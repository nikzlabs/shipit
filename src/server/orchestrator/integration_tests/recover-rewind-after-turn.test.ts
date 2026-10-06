// planning#637 — "Recover rewind" restores the state from before a rewind. A turn that ran
// after the rewind is not part of that state, so recovering must not remove it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { GitManager } from "../../shared/git.js";
import { DatabaseManager } from "../../shared/database.js";
import type { WsServerMessage } from "../../shared/types.js";
import type { CredentialStore } from "../credential-store.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

describe("Integration: Recover rewind after a later turn", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let chatHistoryManager: ChatHistoryManager;
  let lastClaude: FakeClaudeProcess | null;
  let credentialStore: CredentialStore;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-recover-rewind-"));
    chatHistoryManager = new ChatHistoryManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);
    lastClaude = null;
    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      chatHistoryManager,
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
    await new Promise((r) => setTimeout(r, 50));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  async function receiveOneOf(client: TestClient, types: string[]): Promise<WsServerMessage> {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const msg = await client.receive(deadline - Date.now());
      if (types.includes(msg.type)) return msg;
    }
    throw new Error(`none of ${types.join(", ")} arrived`);
  }

  async function runTurn(
    client: TestClient,
    sessionId: string,
    workspaceDir: string,
    prompt: string,
    file: string,
    atStart?: () => void,
  ): Promise<string> {
    lastClaude = null;
    client.send({ type: "send_message", text: prompt, sessionId });
    const claude = await waitForClaude(() => lastClaude);
    atStart?.();
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-sid" });
    fs.writeFileSync(path.join(workspaceDir, file), `${prompt}\n`);
    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: `Wrote ${file}` }] },
      session_id: "agent-sid",
    });
    claude.emit("event", { type: "result", subtype: "success", session_id: "agent-sid" });
    claude.emit("done", 0);
    const committed = await client.receiveType("git_committed", 8000) as { hash: string };
    await client.drain({ quietMs: 300, maxMs: 1500 });
    return committed.hash;
  }

  const userPrompts = (sessionId: string): string[] =>
    chatHistoryManager.load(sessionId).filter((m) => m.role === "user").map((m) => m.text);

  it.each(["chat", "code", "both"] as const)("keeps the later turn after a %s rewind", async (action) => {
    const res = await app.inject({ method: "POST", url: "/api/_test/sessions", payload: { title: "Recover" } });
    const { sessionId, workspaceDir } = res.json() as { sessionId: string; workspaceDir: string };
    const git = new GitManager(workspaceDir);
    const client = await TestClient.connect(port, sessionId);
    await client.receiveType("preview_status");
    await runTurn(client, sessionId, workspaceDir, "turn one", "one.txt");
    await runTurn(client, sessionId, workspaceDir, "turn two", "two.txt");

    const gapBeforeTurnTwo = chatHistoryManager.load(sessionId).findIndex((m) => m.text === "turn two");
    client.send({ type: "rewind_at_gap", gapPosition: gapBeforeTurnTwo, action });
    await client.receiveType("rewind_complete");
    await client.drain({ quietMs: 200, maxMs: 1000 });
    expect(chatHistoryManager.latestRewindSnapshot(sessionId)?.action).toBe(action);
    const laterCommit = await runTurn(client, sessionId, workspaceDir, "turn three", "three.txt", () => {
      // Gone before the agent's first event, so a turn that dies early is covered too.
      expect(chatHistoryManager.latestRewindSnapshot(sessionId)).toBeNull();
    });

    client.send({ type: "rewind_restore_request", sessionId });
    const reply = await receiveOneOf(client, ["rewind_restored", "error"]);

    expect(reply).toMatchObject({ type: "error", message: "No recent rewind is available to recover." });
    expect(userPrompts(sessionId)).toContain("turn three");
    expect(await git.getHeadHash()).toBe(laterCommit);
    expect(fs.existsSync(path.join(workspaceDir, "three.txt"))).toBe(true);
    client.close();
  }, 40_000);

  it("retires the undo when the CLI starts a turn on its own", async () => {
    credentialStore.setLiveSteering(true);
    const res = await app.inject({ method: "POST", url: "/api/_test/sessions", payload: { title: "Recover" } });
    const { sessionId, workspaceDir } = res.json() as { sessionId: string; workspaceDir: string };
    const client = await TestClient.connect(port, sessionId);
    await client.receiveType("preview_status");
    client.send({ type: "send_message", text: "turn one", sessionId });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("agent-sid");
    claude.emit("event", { type: "result", subtype: "success", session_id: "agent-sid" });
    await expect.poll(() => app.runnerRegistry.get(sessionId)?.running).toBe(false);
    chatHistoryManager.createRewindSnapshot(sessionId, {
      action: "code",
      headHash: (await new GitManager(workspaceDir).getHeadHash()) ?? "",
      flippedMessageIds: [],
    });
    expect(chatHistoryManager.latestRewindSnapshot(sessionId)).not.toBeNull();

    claude.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });

    // No row of that turn is written yet; the start alone ends the undo.
    expect(chatHistoryManager.latestRewindSnapshot(sessionId)).toBeNull();
    client.close();
  });

  // Undoing a fork archives the child and leaves the parent's later work alone.
  it("still undoes a fork after a later turn in the parent", async () => {
    const res = await app.inject({ method: "POST", url: "/api/_test/sessions", payload: { title: "Recover" } });
    const { sessionId, workspaceDir } = res.json() as { sessionId: string; workspaceDir: string };
    const client = await TestClient.connect(port, sessionId);
    await client.receiveType("preview_status");
    await runTurn(client, sessionId, workspaceDir, "turn one", "one.txt");

    client.send({
      type: "rewind_at_gap",
      gapPosition: chatHistoryManager.load(sessionId).length,
      action: "fork",
      sessionName: "Fork",
    });
    expect((await receiveOneOf(client, ["session_forked", "error"])).type).toBe("session_forked");
    await client.drain({ quietMs: 200, maxMs: 1000 });
    await runTurn(client, sessionId, workspaceDir, "turn two", "two.txt");

    client.send({ type: "rewind_restore_request", sessionId });
    const reply = await receiveOneOf(client, ["rewind_restored", "error"]);

    expect(reply).toMatchObject({ type: "rewind_restored", action: "fork" });
    expect(userPrompts(sessionId)).toContain("turn two");
    client.close();
  }, 40_000);
});
