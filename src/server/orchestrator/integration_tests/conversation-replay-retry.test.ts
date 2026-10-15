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
 * A replay only starts a conversation (a fork's first spawn), and it stays stored until the
 * CLI reports the conversation it started. A stored id is always resumed and never cleared
 * or replaced by ShipIt, including when the CLI says it cannot find it.
 */
describe("Integration: the replay and the stored conversation id (docs/007)", () => {
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

  /** What a fork leaves on its new session: no thread yet, and the transcript to start from. */
  const armReplay = (sessionId: string): void => {
    sessionManager.clearAgentSessionId(sessionId);
    sessionManager.setConversationReplay(
      sessionId,
      buildConversationReplay(chatHistoryManager.load(sessionId)),
    );
  };

  it("keeps the transcript for the attempt that runs after a quota refusal", async () => {
    const client = await TestClient.connect(port);
    client.send({ type: "send_message", text: "Add the billing routes" });
    const first = await runFirstTurn(client.sessionId);

    armReplay(client.sessionId);

    client.send({ type: "send_message", text: "Now do the same for the webhook route" });
    const attempt = await waitForClaude(() => lastClaude, first);
    expect(attempt.lastSystemPrompt).toContain(TURN_ONE_TEXT);

    // The provider refuses at request time: an adapter error, so this attempt records no
    // conversation of its own and the replay must still be there for the retry.
    attempt.emit("error", new Error(QUOTA_ERROR));

    const retry = await waitForClaude(() => lastClaude, attempt);
    expect(retry.lastSystemPrompt).toContain(TURN_ONE_TEXT);
    expect(retry.lastSessionId).toBeUndefined();

    retry.initSession("turn-two");
    retry.finish("turn-two");
    client.close();
  }, 30_000);

  it("keeps the stored id, ends the turn and starts no new conversation when the CLI cannot resume", async () => {
    const client = await TestClient.connect(port);
    client.send({ type: "send_message", text: "Add the billing routes" });
    const first = await runFirstTurn(client.sessionId);

    client.send({ type: "send_message", text: "Now do the same for the webhook route" });
    const attempt = await waitForClaude(() => lastClaude, first);
    expect(attempt.lastSessionId).toBe("turn-one");

    attempt.emit("log", "stderr", "No conversation found with session ID: turn-one");
    attempt.emit("event", { type: "system", subtype: "init", session_id: "doomed", tools: [] });
    attempt.emit("done", 1);
    await settled(client.sessionId);

    // Not killed: the CLI exits by itself, and a kill can drop the `done` that ends the turn.
    expect(attempt.killed).toBe(false);
    expect(lastClaude).toBe(attempt);
    const session = sessionManager.get(client.sessionId);
    expect(session?.agentSessionId).toBe("turn-one");
    expect(session?.conversationReplay).toBeUndefined();
    const errors = chatHistoryManager.load(client.sessionId).filter((m) => m.isError);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.text).toContain("fork the session");

    // The next turn resumes the same conversation again, with nothing replayed.
    client.send({ type: "send_message", text: "Try again" });
    const next = await waitForClaude(() => lastClaude, attempt);
    expect(next.lastSessionId).toBe("turn-one");
    expect(next.lastSystemPrompt ?? "").not.toContain(TURN_ONE_TEXT);
    next.initSession("turn-one");
    next.finish("turn-one");
    client.close();
  }, 30_000);

  it("keeps the transcript for the next turn when a spawn fails before the CLI reports a conversation", async () => {
    const client = await TestClient.connect(port);
    client.send({ type: "send_message", text: "Add the billing routes" });
    const first = await runFirstTurn(client.sessionId);

    armReplay(client.sessionId);

    client.send({ type: "send_message", text: "Now do the same for the webhook route" });
    const failed = await waitForClaude(() => lastClaude, first);
    expect(failed.lastSystemPrompt).toContain(TURN_ONE_TEXT);
    // What the worker's 413 looked like: the spawn request is refused and the turn ends.
    failed.emit("error", new Error("Payload Too Large"));
    await settled(client.sessionId);
    expect(sessionManager.get(client.sessionId)?.conversationReplay).toContain(TURN_ONE_TEXT);

    client.send({ type: "send_message", text: "Please try once more" });
    const next = await waitForClaude(() => lastClaude, failed);
    expect(next.lastSessionId).toBeUndefined();
    expect(next.lastSystemPrompt).toContain(TURN_ONE_TEXT);
    next.initSession("turn-two");
    next.finish("turn-two");
    await waitFor(
      () => sessionManager.get(client.sessionId)?.conversationReplay === undefined,
      "the reported conversation retired the replay",
    );
    client.close();
  }, 30_000);

  it("keeps the transcript when the CLI itself reports the first attempt failed", async () => {
    const client = await TestClient.connect(port);
    client.send({ type: "send_message", text: "Add the billing routes" });
    const first = await runFirstTurn(client.sessionId);

    armReplay(client.sessionId);

    client.send({ type: "send_message", text: "Now do the same for the webhook route" });
    const refused = await waitForClaude(() => lastClaude, first);
    expect(refused.lastSystemPrompt).toContain(TURN_ONE_TEXT);
    // The CLI started a conversation, then the API refused: its own error text and an error
    // result, before the model said anything.
    refused.initSession("refused-attempt");
    refused.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "API Error: 500 Internal server error" }] },
      is_api_error_message: true,
      session_id: "refused-attempt",
    });
    refused.emit("event", { type: "result", subtype: "success", is_error: true, session_id: "refused-attempt" });
    refused.emit("done", 1);
    await settled(client.sessionId);

    const session = sessionManager.get(client.sessionId);
    expect(session?.agentSessionId).toBeUndefined();
    expect(session?.conversationReplay).toContain(TURN_ONE_TEXT);

    client.send({ type: "send_message", text: "Please try once more" });
    const next = await waitForClaude(() => lastClaude, refused);
    expect(next.lastSessionId).toBeUndefined();
    expect(next.lastSystemPrompt).toContain(TURN_ONE_TEXT);
    next.initSession("turn-two");
    next.finish("turn-two");
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
