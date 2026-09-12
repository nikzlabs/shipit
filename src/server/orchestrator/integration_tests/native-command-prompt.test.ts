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
import type { WsServerMessage } from "../../shared/types.js";
import type { CredentialStore } from "../credential-store.js";
import type { DatabaseManager } from "../../shared/database.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

const NOTICE = "[System] Your previous pull request (#482) was merged into main.";

/**
 * docs/299 — the CLI reads its own command only when the message is exactly the
 * command: measured, a notice before it means no command is seen at all, and
 * context after it lands inside the command's argument.
 */
describe("Integration: a command invocation reaches the harness alone (docs/299)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessions: SessionManager;
  let credentialStore: CredentialStore;
  let dbManager: DatabaseManager;
  let lastClaude: FakeClaudeProcess = null as unknown as FakeClaudeProcess;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as unknown as FakeClaudeProcess;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-native-command-"));
    credentialStore = createTestCredentialStore(tmpDir);
    sessions = new SessionManager(dbManager);

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: sessions,
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as never;
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
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  async function receiveNotice(client: TestClient, timeoutMs = 3000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const msg = await client.receive(Math.max(1, deadline - Date.now())) as WsServerMessage;
      if (msg.type === "system_notice") return msg.message;
    }
  }

  it("sends a skill invocation alone, leaving the pending notice for the next turn", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    sessions.setPendingAgentNotice(client.sessionId, NOTICE);

    client.send({ type: "send_message", text: "/code-review high" });
    const claude = await waitForClaude(() => lastClaude);

    expect(claude.lastPrompt).toBe("/code-review high");
    expect(sessions.consumePendingAgentNotice(client.sessionId)).toBe(NOTICE);
    client.close();
  });

  it("leaves a role's standing instructions untaken by a command turn", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    sessions.setRoleName(client.sessionId, "Reviewer");

    client.send({ type: "send_message", text: "/code-review" });
    const claude = await waitForClaude(() => lastClaude);

    expect(claude.lastPrompt).toBe("/code-review");
    // The take records its origin; an untaken brief still has none.
    expect(sessions.get(client.sessionId)?.originRoleName).toBeUndefined();
    client.close();
  });

  it("still prefixes the notice onto an ordinary message", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    sessions.setPendingAgentNotice(client.sessionId, NOTICE);

    client.send({ type: "send_message", text: "review the auth module" });
    const claude = await waitForClaude(() => lastClaude);

    expect(claude.lastPrompt).toBe(`${NOTICE}\n\nreview the auth module`);
    expect(sessions.consumePendingAgentNotice(client.sessionId)).toBeUndefined();
    client.close();
  });

  it("does not treat a path-first message as a command", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    sessions.setPendingAgentNotice(client.sessionId, NOTICE);

    client.send({ type: "send_message", text: "/tmp/foo.ts is broken, fix it" });
    const claude = await waitForClaude(() => lastClaude);

    expect(claude.lastPrompt).toBe(`${NOTICE}\n\n/tmp/foo.ts is broken, fix it`);
    client.close();
  });

  it("refuses a command that carries attachments instead of folding them into its argument", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "export const a = 1;\n");

    client.send({ type: "send_message", text: "/code-review", files: [{ path: "a.ts" }] });

    expect(await receiveNotice(client)).toMatch(/cannot carry attachments/);
    expect(lastClaude).toBeNull();
    client.close();
  });

  it("steers a command invocation alone, with no dictation block appended", async () => {
    credentialStore.setLiveSteering(true);
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "start the work" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("native-command-session");

    client.send({ type: "send_message", text: "/code-review high", dictated: true });
    await new Promise((r) => setTimeout(r, 100));

    expect(claude.stdinData).toContain("/code-review high");
    client.close();
  });
});
