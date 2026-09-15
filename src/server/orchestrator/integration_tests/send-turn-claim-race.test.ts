import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { DatabaseManager } from "../../shared/database.js";

import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

type AnyMsg = Record<string, unknown> & { type: string };

/**
 * planning#575 — `handleSendMessage` used to read `running` before its awaits and
 * set it after them, so two sends could both pass the check and the SLOWER one
 * lost its own turn to the message sent after it, along with the per-message
 * flags that turn carried. The slowness is not artificial: attachments are
 * resolved inside that window, one file read at a time.
 *
 * The first test reproduces the inversion through that real timing difference
 * rather than an injected delay, so it is a race reproduction and not a proof
 * of the ordering — it was red on every one of six pre-fix runs. What the fix
 * makes deterministic is the other direction: order no longer depends on which
 * preamble finishes first.
 */
describe("Integration: a send cannot be overtaken by the send after it (planning#575)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let lastClaude: FakeClaudeProcess | null = null;
  let allClaudes: FakeClaudeProcess[] = [];
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null;
    allClaudes = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-claim-race-"));

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        const claude = new FakeClaudeProcess();
        lastClaude = claude;
        allClaudes.push(claude);
        return claude as never;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* cleanup is best-effort */ }
  });

  const sessionDirOf = (client: TestClient) =>
    path.join(tmpDir, "sessions", client.sessionId, "workspace");

  async function drainUntil(
    client: TestClient,
    predicate: (m: AnyMsg) => boolean,
    maxMsgs = 40,
    timeoutMs = 3000,
  ): Promise<AnyMsg | null> {
    for (let i = 0; i < maxMsgs; i++) {
      const msg = (await client.receive(timeoutMs)) as AnyMsg;
      if (predicate(msg)) return msg;
    }
    return null;
  }

  /** The maximum a message may carry, so the window is as wide as the product allows. */
  function attachTenFiles(client: TestClient): { path: string }[] {
    const dir = sessionDirOf(client);
    const refs: { path: string }[] = [];
    for (let i = 0; i < 10; i++) {
      const name = `attached-${i}.txt`;
      fs.writeFileSync(path.join(dir, name), `attachment ${i}\n`.repeat(400));
      refs.push({ path: name });
    }
    return refs;
  }

  it("runs the FIRST send as the turn and queues the second, even when the first carries attachments", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    const files = attachTenFiles(client);
    client.send({ type: "send_message", text: "first", files });
    client.send({ type: "send_message", text: "second" });

    const turn = await waitForClaude(() => lastClaude);
    expect(turn.lastPrompt).toContain("first");
    expect(turn.lastPrompt).not.toContain("second");

    const queued = await drainUntil(client, (m) => m.type === "message_queued");
    expect(queued).toMatchObject({ type: "message_queued", text: "second" });
    expect(allClaudes).toHaveLength(1);

    // The overtaken message is not lost: it runs next, in the order it was sent.
    turn.finish("agent-a");
    const next = await waitForClaude(() => lastClaude, turn);
    expect(next.lastPrompt).toContain("second");

    client.close();
  });

  /**
   * The claim is taken before work that can refuse the message, so every refusal
   * has to give it back. A session that kept it would accept no further turn.
   */
  it("still accepts the next turn after a send is refused for an unresolvable attachment", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "refused", files: [{ path: "does-not-exist.txt" }] });
    const err = (await client.receiveType("error")) as AnyMsg;
    expect(String(err.message)).toContain("File not found");
    expect(allClaudes).toHaveLength(0);

    client.send({ type: "send_message", text: "after the refusal" });
    const turn = await waitForClaude(() => lastClaude);
    expect(turn.lastPrompt).toContain("after the refusal");

    client.close();
  });

  it("still accepts the next turn after a send is refused for a path outside the workspace", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "refused", files: [{ path: "../../etc/passwd" }] });
    const err = (await client.receiveType("error")) as AnyMsg;
    expect(String(err.message)).toContain("Invalid file path");

    client.send({ type: "send_message", text: "after the traversal refusal" });
    const turn = await waitForClaude(() => lastClaude);
    expect(turn.lastPrompt).toContain("after the traversal refusal");

    client.close();
  });

  it("still accepts the next turn after a send is refused for an unresolvable upload", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({
      type: "send_message",
      text: "refused",
      uploads: [{ path: "/uploads/missing.txt", type: "upload" }],
    });
    await client.receiveType("error");

    client.send({ type: "send_message", text: "after the upload refusal" });
    const turn = await waitForClaude(() => lastClaude);
    expect(turn.lastPrompt).toContain("after the upload refusal");

    client.close();
  });

  /**
   * The refusal for a workspace that has gone away is the last exit above the
   * claim, past the attachment work and past session activation.
   */
  it("still accepts the next turn after a send is refused for a missing workspace", async () => {
    const client = await TestClient.connect(port);
    // Activation re-creates the workspace as it settles; let it finish first.
    await client.drain({ quietMs: 300, maxMs: 3000 });

    const dir = sessionDirOf(client);
    fs.rmSync(dir, { recursive: true, force: true });

    client.send({ type: "send_message", text: "doomed" });
    const err = (await client.receiveType("error")) as AnyMsg;
    expect(String(err.message)).toContain("workspace is no longer available");
    expect(allClaudes).toHaveLength(0);

    fs.mkdirSync(dir, { recursive: true });
    client.send({ type: "send_message", text: "after the lost workspace" });
    const turn = await waitForClaude(() => lastClaude);
    expect(turn.lastPrompt).toContain("after the lost workspace");

    client.close();
  });
});
