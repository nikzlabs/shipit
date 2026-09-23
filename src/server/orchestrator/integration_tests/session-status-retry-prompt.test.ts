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
import type { SessionStatus } from "../../shared/types.js";
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
 * docs/303 req 35 — the same guard as `turn-retry-status-context.test.ts`, on the OTHER
 * composition site. An ordinary message from the composer is composed by
 * `runAgentWithMessage` (`ws-handlers/agent-execution.ts`), not by `runDispatchedTurnInner`,
 * and it was the path the report came from. The unit-level guard cannot see it: it drives
 * the runner's dispatch, so dropping the interactive site's handoff leaves it green.
 */
describe("Integration: a retried interactive turn reads the card as it stands (docs/303)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let agents: FakeClaudeProcess[];
  let lastClaude: FakeClaudeProcess = null as never;

  const QUOTA_ERROR = "You've hit Claude's 5h usage limit. It resets at 2099-01-01T00:00:00.000Z.";

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-status-retry-"));
    credentialStore = createTestCredentialStore(tmpDir);
    sessionManager = new SessionManager(dbManager);
    agents = [];
    lastClaude = null as never;

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess();
        agents.push(lastClaude);
        return lastClaude as never;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
    credentialStore.setSessionStatusCard(true);
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* cleanup only */ }
  });

  const card = (sessionId: string): SessionStatus | undefined =>
    sessionManager.get(sessionId)?.sessionStatus;

  const callTool = (sessionId: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/sessions/${sessionId}/session-status`, payload });

  it("carries the session_status write the failed attempt made into the retry", async () => {
    const client = await TestClient.connect(port);

    // A first turn, so the session has a card the next turn's prompt can carry.
    client.send({ type: "send_message", text: "Do the billing routes" });
    const first = await waitForClaude(() => lastClaude);
    first.initSession("turn-one");
    expect((await callTool(client.sessionId, {
      status: "Billing routes done; the webhook is not started.",
      actions: [{
        id: "follow-up",
        label: "Open the follow-up PR",
        description: "Files the rate-limit edge case as its own PR.",
        payload: "Open the follow-up PR for the rate-limit edge case",
      }],
    })).statusCode).toBe(200);
    first.finish("turn-one");
    await waitFor(() => {
      const runner = app.runnerRegistry.get(client.sessionId);
      return runner !== undefined && !runner.running && !runner.agentBusy;
    }, "the first turn settled");

    const offerId = card(client.sessionId)!.actions[0]!.offerId;

    // The user ticks the offer and submits it: an ordinary composer message.
    client.send({
      type: "send_message",
      text: "[Action card → Submit] I approved this action.\n\n1. Open the follow-up PR for the rate-limit edge case",
      sessionStatusOfferIds: [offerId],
    });
    const attempt = await waitForClaude(() => lastClaude, first);
    attempt.initSession("turn-two");
    expect(attempt.lastPrompt).toContain("the webhook is not started");

    // The agent does the work and writes the card; the tool answers that it is up to date.
    await waitFor(
      () => card(client.sessionId)?.actions[0]?.takenAt !== undefined,
      "the offer was taken",
    );
    expect((await callTool(client.sessionId, {
      status: "Follow-up PR #212 is open and ready to merge.",
      lastTurn: "Opened PR #212.",
    })).statusCode).toBe(200);

    // Only then does the provider refuse on quota, and ShipIt re-runs the turn.
    attempt.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "turn-two" });
    const retry = await waitForClaude(() => lastClaude, attempt);

    expect(retry.lastPrompt).toContain("Follow-up PR #212 is open and ready to merge.");
    expect(retry.lastPrompt).not.toContain("the webhook is not started");
    // And the offer the user submitted reads as work already sent, not as a live one.
    expect(retry.lastPrompt).toContain("ALREADY SENT to you");

    retry.initSession("turn-two");
    retry.finish("turn-two");
    client.close();
  }, 30_000);
});
