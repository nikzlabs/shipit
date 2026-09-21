import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { buildConversationReplay } from "../services/replay.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import type { CredentialStore } from "../credential-store.js";
import type { DatabaseManager } from "../../shared/database.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  waitFor,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

/**
 * The conversation replay belongs to the agent that runs, not to the attempt that happened
 * to build run parameters first. It is spent by the run parameters that carry it into a
 * system prompt, so an attempt that spends it and then fails without recording a
 * conversation of its own leaves the session with neither a thread nor a replay — and the
 * attempt that actually runs answers the user with an empty conversation.
 */
describe("Integration: a retried turn keeps its transcript (docs/007)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let lastClaude: FakeClaudeProcess = null as never;

  const QUOTA_ERROR = "You've hit Claude's 5h usage limit. It resets at 2099-01-01T00:00:00.000Z.";
  const TURN_ONE_TEXT = "Added the billing routes in src/billing.ts.";

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-replay-retry-"));
    credentialStore = createTestCredentialStore(tmpDir);
    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);
    lastClaude = null as never;

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
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
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* cleanup only */ }
  });

  const settled = (sessionId: string) => waitFor(() => {
    const runner = app.runnerRegistry.get(sessionId);
    return runner !== undefined && !runner.running && !runner.agentBusy;
  }, "the turn settled");

  /** A first turn, so the session has a transcript a replay can be built from. */
  const runFirstTurn = async (sessionId: string): Promise<FakeClaudeProcess> => {
    const first = await waitForClaude(() => lastClaude);
    first.initSession("turn-one");
    first.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: TURN_ONE_TEXT }] },
      session_id: "turn-one",
    });
    first.finish("turn-one");
    await settled(sessionId);
    return first;
  };

  /** What `armConversationReplay` leaves behind when the thread is gone. */
  const armReplay = (sessionId: string): void => {
    sessionManager.clearAgentSessionId(sessionId);
    sessionManager.setConversationReplay(
      sessionId,
      buildConversationReplay(chatHistoryManager.load(sessionId)),
    );
  };

  it("re-arms the transcript for the attempt that runs after a quota refusal", async () => {
    const client = await TestClient.connect(port);
    client.send({ type: "send_message", text: "Add the billing routes" });
    const first = await runFirstTurn(client.sessionId);

    // The container was recreated, so there is no thread to resume.
    armReplay(client.sessionId);

    client.send({ type: "send_message", text: "Now do the same for the webhook route" });
    const attempt = await waitForClaude(() => lastClaude, first);
    expect(attempt.lastSystemPrompt).toContain(TURN_ONE_TEXT);

    // The provider refuses at request time: an adapter error, so this attempt records no
    // conversation of its own and the replay it spent is not recoverable from anywhere.
    attempt.emit("error", new Error(QUOTA_ERROR));

    const retry = await waitForClaude(() => lastClaude, attempt);
    expect(retry.lastSystemPrompt).toContain(TURN_ONE_TEXT);
    expect(retry.lastSessionId).toBeUndefined();

    retry.initSession("turn-two");
    retry.finish("turn-two");
    client.close();
  }, 30_000);

  it("re-arms the transcript when the CLI reports its conversation gone", async () => {
    const client = await TestClient.connect(port);
    client.send({ type: "send_message", text: "Add the billing routes" });
    const first = await runFirstTurn(client.sessionId);

    client.send({ type: "send_message", text: "Now do the same for the webhook route" });
    const attempt = await waitForClaude(() => lastClaude, first);
    expect(attempt.lastSessionId).toBe("turn-one");

    // The CLI cannot find the conversation the resume id names. ShipIt clears the pointer
    // and re-dispatches on a fresh process, which has no history unless one is rebuilt.
    attempt.emit("log", "stderr", "No conversation found with session ID: turn-one");
    attempt.emit("event", { type: "system", subtype: "init", session_id: "doomed", tools: [] });

    const retry = await waitForClaude(() => lastClaude, attempt);
    expect(retry.lastSessionId).toBeUndefined();
    expect(retry.lastSystemPrompt).toContain(TURN_ONE_TEXT);

    retry.initSession("turn-two");
    retry.finish("turn-two");
    client.close();
  }, 30_000);

  it("leaves a healthy thread to resume, and does not replay the transcript twice", async () => {
    const client = await TestClient.connect(port);
    client.send({ type: "send_message", text: "Add the billing routes" });
    const first = await runFirstTurn(client.sessionId);

    armReplay(client.sessionId);

    client.send({ type: "send_message", text: "Now do the same for the webhook route" });
    const second = await waitForClaude(() => lastClaude, first);
    expect(second.lastSystemPrompt).toContain(TURN_ONE_TEXT);
    second.initSession("turn-two");
    second.finish("turn-two");
    await waitFor(
      () => sessionManager.get(client.sessionId)?.agentSessionId === "turn-two",
      "the agent reported its conversation",
    );
    await settled(client.sessionId);

    // That conversation now carries the transcript, so the next turn resumes it rather
    // than being handed a second copy.
    client.send({ type: "send_message", text: "And the refunds route" });
    const third = await waitForClaude(() => lastClaude, second);
    expect(third.lastSessionId).toBe("turn-two");
    expect(third.lastSystemPrompt ?? "").not.toContain(TURN_ONE_TEXT);

    third.initSession("turn-two");
    third.finish("turn-two");
    client.close();
  }, 30_000);
});
