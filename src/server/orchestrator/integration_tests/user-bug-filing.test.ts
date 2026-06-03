import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
  createTestSession,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import type { ChatHistoryManager, PersistedBugReport } from "../chat-history.js";
import type { FastifyInstance } from "fastify";
import type { CredentialStore } from "../credential-store.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { WsBugReportCard, WsBugReportFiled, WsBugReportFailed } from "../../shared/types.js";

/**
 * docs/164 — user bug filing, end-to-end. Drives the two-step flow with a
 * stubbed GitHub auth manager:
 *   1. the agent's `report_shipit_bug` relays a draft to the bug-report route,
 *      which REDACTS it server-side and emits a consent card (nothing filed);
 *   2. only the user's `submit_bug_report` confirm files the issue on the
 *      fixed upstream repo under the user's own identity.
 * Also covers: redaction is applied to the card, no issue is created before
 * confirm, and a GitHub scope error surfaces a reconnect prompt.
 */
describe("Integration: user bug filing", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let githubAuthManager: StubGitHubAuthManager;
  let sessionId: string;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "user-bug-filing-"));
    sessionManager = new SessionManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);
    githubAuthManager = new StubGitHubAuthManager();
    await githubAuthManager.setToken("test-token"); // authenticate as test-user

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as unknown as never,
      credentialStore,
      databaseManager: dbManager,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);

    const created = await createTestSession(sessionManager, tmpDir);
    sessionId = created.sessionId;
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore */ }
  });

  it("redacts the draft, emits a card, and files only after explicit confirm", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    // The agent relays a draft whose body contains a secret + email — these
    // must be scrubbed by Stage 1 before the card is ever shown.
    const relay = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: {
        title: "Preview won't reload",
        body: "It broke. My token ghp_ABCDEFGHIJKLMNOP1234567890abcd and email me@example.com.",
      },
    });
    expect(relay.statusCode).toBe(200);

    // No issue created yet — the relay only proposes.
    expect(githubAuthManager.createIssueCalls).toHaveLength(0);

    const card = (await client.receiveType("bug_report_card")) as WsBugReportCard;
    expect(card.title).toBe("Preview won't reload");
    expect(card.body).not.toContain("ghp_ABCDEFGHIJKLMNOP");
    expect(card.body).not.toContain("me@example.com");
    expect(card.body).toContain("[REDACTED]");
    // The body marker carries the producer for maintainer-side labeling.
    expect(card.body).toContain("<!-- shipit-report source=session");
    // Stage 2 didn't run (no real CLI in tests) → flagged for the human.
    expect(card.stage2Ran).toBe(false);
    expect(card.filedAs).toBe("test-user");

    // User confirms — now (and only now) the issue is filed.
    client.send({
      type: "submit_bug_report",
      cardId: card.cardId,
      title: card.title,
      body: card.body,
    });

    const filed = (await client.receiveType("bug_report_filed")) as WsBugReportFiled;
    expect(filed.number).toBe(1234);
    expect(filed.url).toContain("nicolasalt/shipit/issues/1234");

    expect(githubAuthManager.createIssueCalls).toHaveLength(1);
    const call = githubAuthManager.createIssueCalls[0];
    expect(call.owner).toBe("nicolasalt");
    expect(call.repo).toBe("shipit");
    expect(call.title).toBe("Preview won't reload");
    expect(call.labels).toEqual(["user-reported", "source:session"]);
    // The redaction survives all the way to the filed payload.
    expect(call.body).not.toContain("ghp_ABCDEFGHIJKLMNOP");

    client.close();
  });

  it("surfaces a GitHub scope error as a reconnect prompt", async () => {
    githubAuthManager.setCreateIssueResult({
      success: false,
      scopeError: true,
      message: "Your GitHub token can't file issues on the ShipIt repo. Reconnect GitHub …",
    });

    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: { title: "A bug", body: "Something is broken in the editor." },
    });
    const card = (await client.receiveType("bug_report_card")) as WsBugReportCard;

    client.send({ type: "submit_bug_report", cardId: card.cardId, title: card.title, body: card.body });

    const failed = (await client.receiveType("bug_report_failed")) as WsBugReportFailed;
    expect(failed.scopeError).toBe(true);
    expect(failed.message).toContain("Reconnect GitHub");

    client.close();
  });

  it("(a) records the card in-band so it persists at its transcript position", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: { title: "Preview won't reload", body: "Something is broken in the editor." },
    });
    const card = (await client.receiveType("bug_report_card")) as WsBugReportCard;

    // The card is recorded on the runner (anchored by afterGroupIndex) so
    // `buildTurnMessages` folds it into chat history at the spot the agent's
    // `report_shipit_bug` tool fired — the same mechanism voice notes use.
    const runner = (app as unknown as { runnerRegistry: { get(id: string): { bugReportCards: { afterGroupIndex: number; card: { cardId: string; phase: string } }[] } | undefined } }).runnerRegistry.get(sessionId);
    expect(runner?.bugReportCards).toHaveLength(1);
    expect(runner?.bugReportCards[0].card.cardId).toBe(card.cardId);
    expect(runner?.bugReportCards[0].card.phase).toBe("draft");

    client.close();
  });

  it("(b/d) a submission patches the persisted card so a reload shows its terminal state", async () => {
    const histMgr = (app as unknown as { chatHistoryManager: ChatHistoryManager }).chatHistoryManager;

    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: { title: "Preview won't reload", body: "Something is broken in the editor." },
    });
    const card = (await client.receiveType("bug_report_card")) as WsBugReportCard;

    // Simulate the proposing turn finalizing the recorded card into chat history
    // (in production `buildTurnMessages` does this at the tool-result boundary).
    const runner = (app as unknown as { runnerRegistry: { get(id: string): { bugReportCards: { card: PersistedBugReport }[] } | undefined } }).runnerRegistry.get(sessionId);
    histMgr.append(sessionId, { role: "assistant", text: "", bugReport: runner!.bugReportCards[0].card });

    // It replays on attach (reload rebuilds from this history).
    const historyBefore = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const cardsBefore = (historyBefore.json() as { messages: { bugReport?: PersistedBugReport }[] }).messages
      .map((m) => m.bugReport)
      .filter(Boolean);
    expect(cardsBefore).toHaveLength(1);
    expect(cardsBefore[0]?.phase).toBe("draft");

    // User confirms → filed. The terminal state is patched into the same record.
    client.send({ type: "submit_bug_report", cardId: card.cardId, title: card.title, body: card.body });
    await client.receiveType("bug_report_filed");

    const historyAfter = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const cardsAfter = (historyAfter.json() as { messages: { bugReport?: PersistedBugReport }[] }).messages
      .map((m) => m.bugReport)
      .filter(Boolean);
    // No duplicate card — the single record is updated in place.
    expect(cardsAfter).toHaveLength(1);
    expect(cardsAfter[0]?.phase).toBe("filed");
    expect(cardsAfter[0]?.issueNumber).toBe(1234);
    expect(cardsAfter[0]?.issueUrl).toContain("nicolasalt/shipit/issues/1234");

    client.close();
  });

  it("rejects a draft with an empty body", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: { title: "Title only", body: "   " },
    });
    expect(res.statusCode).toBe(400);
  });
});
