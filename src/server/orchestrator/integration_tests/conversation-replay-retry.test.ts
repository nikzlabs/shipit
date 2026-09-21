import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
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
 * The conversation replay belongs to the turn's AGENT, not to the first attempt that
 * happened to build run parameters. A quota refusal reported as an adapter error records
 * no conversation of its own, so a replay taken by that attempt is spent on a process
 * that never read a word of it and the failover starts with an empty transcript.
 */
describe("Integration: a retried turn seeds its agent with the same replay (docs/007)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess = null as never;

  const QUOTA_ERROR = "You've hit Claude's 5h usage limit. It resets at 2099-01-01T00:00:00.000Z.";
  const REPLAY = "You are continuing a conversation. Here is the conversation so far:\n\n"
    + "User: Add the billing routes\nAssistant: Added them in src/billing.ts.";

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-replay-retry-"));
    credentialStore = createTestCredentialStore(tmpDir);
    sessionManager = new SessionManager(dbManager);
    lastClaude = null as never;

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
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
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* cleanup only */ }
  });

  it("carries the replay onto the attempt that runs after a quota refusal", async () => {
    const client = await TestClient.connect(port);

    // A first turn, so the session exists and holds a transcript.
    client.send({ type: "send_message", text: "Add the billing routes" });
    const first = await waitForClaude(() => lastClaude);
    first.initSession("turn-one");
    first.finish("turn-one");
    await waitFor(() => {
      const runner = app.runnerRegistry.get(client.sessionId);
      return runner !== undefined && !runner.running && !runner.agentBusy;
    }, "the first turn settled");

    // The container was recreated, so the thread is gone and ShipIt armed a replay in
    // its place — the state `armConversationReplay` leaves behind.
    sessionManager.clearAgentSessionId(client.sessionId);
    sessionManager.setConversationReplay(client.sessionId, REPLAY);

    client.send({ type: "send_message", text: "Now do the same for the webhook route" });
    const attempt = await waitForClaude(() => lastClaude, first);
    expect(attempt.lastSystemPrompt).toContain("Added them in src/billing.ts.");

    // The provider refuses at request time: an adapter error, so no conversation of this
    // attempt's own is ever recorded.
    attempt.emit("error", new Error(QUOTA_ERROR));

    const retry = await waitForClaude(() => lastClaude, attempt);
    expect(retry.lastSystemPrompt).toContain("Added them in src/billing.ts.");
    expect(retry.lastSessionId).toBeUndefined();

    retry.initSession("turn-two");
    retry.finish("turn-two");
    client.close();
  }, 30_000);

  it("retires the replay once the agent reports a conversation that carries it", async () => {
    const client = await TestClient.connect(port);

    client.send({ type: "send_message", text: "Add the billing routes" });
    const first = await waitForClaude(() => lastClaude);
    first.initSession("turn-one");
    first.finish("turn-one");
    await waitFor(() => {
      const runner = app.runnerRegistry.get(client.sessionId);
      return runner !== undefined && !runner.running && !runner.agentBusy;
    }, "the first turn settled");

    sessionManager.clearAgentSessionId(client.sessionId);
    sessionManager.setConversationReplay(client.sessionId, REPLAY);

    client.send({ type: "send_message", text: "Now do the same for the webhook route" });
    const second = await waitForClaude(() => lastClaude, first);
    expect(second.lastSystemPrompt).toContain("Added them in src/billing.ts.");
    second.initSession("turn-two");
    second.finish("turn-two");
    await waitFor(
      () => sessionManager.get(client.sessionId)?.agentSessionId === "turn-two",
      "the agent reported its conversation",
    );

    // The thread now carries the transcript, so a later turn must not append it again.
    expect(sessionManager.readConversationReplay(client.sessionId)).toBeUndefined();

    client.send({ type: "send_message", text: "And the refunds route" });
    const third = await waitForClaude(() => lastClaude, second);
    expect(third.lastSystemPrompt ?? "").not.toContain("Added them in src/billing.ts.");

    third.initSession("turn-two");
    third.finish("turn-two");
    client.close();
  }, 30_000);
});
