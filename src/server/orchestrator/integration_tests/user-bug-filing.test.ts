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
import type { SessionRunnerInterface } from "../session-runner.js";
import { buildTurnMessages } from "../chat-card-persistence.js";
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
  /**
   * nikzlabs/shipit#2350 — every agent the app spawned, so a test can read the prompt the
   * outcome wake-turn actually delivered. The signal is only real if it reaches
   * the AGENT; asserting on the WS card alone would pass while the agent stayed
   * uninformed, which is the whole defect.
   */
  let agents: FakeClaudeProcess[];

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "user-bug-filing-"));
    sessionManager = new SessionManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);
    agents = [];
    githubAuthManager = new StubGitHubAuthManager();
    await githubAuthManager.setToken("test-token"); // authenticate as test-user

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      agentFactory: () => {
        const agent = new FakeClaudeProcess();
        agents.push(agent);
        return agent as unknown as never;
      },
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
    expect(filed.url).toContain("nikzlabs/shipit/issues/1234");

    expect(githubAuthManager.createIssueCalls).toHaveLength(1);
    const call = githubAuthManager.createIssueCalls[0];
    expect(call.owner).toBe("nikzlabs");
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

  it("(a) persists the card durably even though no turn is running", async () => {
    const histMgr = (app as unknown as { chatHistoryManager: ChatHistoryManager }).chatHistoryManager;
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: { title: "Preview won't reload", body: "Something is broken in the editor." },
    });
    const card = (await client.receiveType("bug_report_card")) as WsBugReportCard;

    // A USER-filed report arrives with no turn in flight, so `emitChatCard`
    // appends it as an already-final row rather than folding it into an
    // in-progress turn that doesn't exist. That distinction is the whole point:
    // an `in_progress=1` row is deleted wholesale by the NEXT turn's first
    // `replaceInProgress`, so the card the user just filed would silently
    // disappear from the transcript as soon as they sent another message.
    const persisted = histMgr.load(sessionId).filter((m) => m.bugReport);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].bugReport?.cardId).toBe(card.cardId);
    expect(persisted[0].bugReport?.phase).toBe("draft");
    expect(persisted[0].inProgress).toBeUndefined();

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

    // `emitChatCard` already persisted the card in-band the instant it fired
    // (docs/191) — no manual append needed. Finalize the in-progress rows to
    // simulate the proposing turn ending (in production `agent_result` →
    // `finalizeInProgress` does this), which is when the user clicks Submit.
    histMgr.finalizeInProgress(sessionId);

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
    expect(cardsAfter[0]?.issueUrl).toContain("nikzlabs/shipit/issues/1234");

    client.close();
  });

  it("(b/d) keeps a filed transition through finalize when the proposing turn is still in flight", async () => {
    const histMgr = (app as unknown as { chatHistoryManager: ChatHistoryManager }).chatHistoryManager;

    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: { title: "Preview won't reload", body: "Something is broken in the editor." },
    });
    const card = (await client.receiveType("bug_report_card")) as WsBugReportCard;

    // Simulate the proposing turn STILL running — the agent filed a bug then
    // kept working, so `recordedCards` holds the draft snapshot and the turn has
    // NOT finalized. This is the window a DB-only patch lost: the rebuild at
    // finalize would clobber `filed` back to `draft`.
    const runner = (app as unknown as {
      runnerRegistry: { get(id: string): SessionRunnerInterface | undefined };
    }).runnerRegistry.get(sessionId)!;
    runner.running = true;

    // User confirms mid-turn → filed.
    client.send({ type: "submit_bug_report", cardId: card.cardId, title: card.title, body: card.body });
    await client.receiveType("bug_report_filed");

    // The proposing turn now finalizes (mirrors the `agent_result` path):
    // rebuild the permanent rows from `recordedCards`. Because the recorded card
    // was patched in place, this carries `filed` rather than reverting to draft.
    runner.running = false;
    histMgr.replaceInProgress(
      sessionId,
      buildTurnMessages(runner.chatMessageGroups, runner.steeredMessages, runner.recordedCards, { inProgress: false }),
    );
    histMgr.finalizeInProgress(sessionId);

    const historyAfter = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const cardsAfter = (historyAfter.json() as { messages: { bugReport?: PersistedBugReport }[] }).messages
      .map((m) => m.bugReport)
      .filter(Boolean);
    // The terminal state survives finalize — no revert to the editable draft.
    expect(cardsAfter).toHaveLength(1);
    expect(cardsAfter[0]?.phase).toBe("filed");
    expect(cardsAfter[0]?.issueNumber).toBe(1234);

    client.close();
  });

  /**
   * nikzlabs/shipit#2350 — the consent gate used to swallow its own result. The user still
   * decides; the agent is now told what they decided, so it can stop describing
   * a filed report as pending and can cite the issue it produced.
   */
  it("tells the agent the report was filed, with the issue number and URL", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: { title: "Preview won't reload", body: "Something is broken in the editor." },
    });
    const card = (await client.receiveType("bug_report_card")) as WsBugReportCard;

    client.send({ type: "submit_bug_report", cardId: card.cardId, title: card.title, body: card.body });
    await client.receiveType("bug_report_filed");

    const woken = await waitForWakePrompt(() => agents, /FILED as issue #1234/);
    expect(woken).toContain("nikzlabs/shipit/issues/1234");
    expect(woken).toContain("Preview won't reload");

    client.close();
  });

  it("does not signal an outcome when filing failed — the report really is still pending", async () => {
    githubAuthManager.setCreateIssueResult({
      success: false,
      scopeError: true,
      message: "Your GitHub token can't file issues on the ShipIt repo.",
    });

    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: { title: "Preview won't reload", body: "Something is broken in the editor." },
    });
    const card = (await client.receiveType("bug_report_card")) as WsBugReportCard;

    client.send({ type: "submit_bug_report", cardId: card.cardId, title: card.title, body: card.body });
    await client.receiveType("bug_report_failed");
    await new Promise((r) => setTimeout(r, 150));

    // Assert on the ABSENCE OF A TURN, not on the wording: a wake of any text
    // would have had to spawn an agent in this harness, so a failure-path wake
    // that said something else could not slip past this.
    expect(agents).toHaveLength(0);

    // Liveness: the negative above must not be able to pass because the wake
    // path is broken outright. The user fixes their token and resubmits — the
    // very same harness now does deliver a signal.
    githubAuthManager.setCreateIssueResult(null);
    client.send({ type: "submit_bug_report", cardId: card.cardId, title: card.title, body: card.body });
    await client.receiveType("bug_report_filed");
    await waitForWakePrompt(() => agents, /FILED as issue #1234/);

    client.close();
  });

  it("persists a dismissal and tells the agent the report was declined", async () => {
    const histMgr = (app as unknown as { chatHistoryManager: ChatHistoryManager }).chatHistoryManager;

    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: { title: "Preview won't reload", body: "Something is broken in the editor." },
    });
    const card = (await client.receiveType("bug_report_card")) as WsBugReportCard;
    histMgr.finalizeInProgress(sessionId);

    client.send({ type: "dismiss_bug_report", cardId: card.cardId });
    const dismissed = await client.receiveType("bug_report_dismissed");
    expect((dismissed as { cardId: string }).cardId).toBe(card.cardId);

    // Nothing was filed — Cancel is not a quiet submit.
    expect(githubAuthManager.createIssueCalls).toHaveLength(0);

    // The decision is durable: a reload must not resurrect an editable draft.
    const historyAfter = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const cardsAfter = (historyAfter.json() as { messages: { bugReport?: PersistedBugReport }[] }).messages
      .map((m) => m.bugReport)
      .filter(Boolean);
    expect(cardsAfter).toHaveLength(1);
    expect(cardsAfter[0]?.phase).toBe("dismissed");

    const woken = await waitForWakePrompt(() => agents, /DECLINED the ShipIt bug report/);
    expect(woken).toContain("Preview won't reload");

    client.close();
  });

  /**
   * The stale-`recordedCards` path, which the plain post-turn test cannot reach:
   * a card proposed MID-TURN is recorded on the runner, and that snapshot is
   * cleared only at the next turn start — so once the proposing turn finalizes,
   * the recorded copy still says `draft` while the DB says `filed`. A Cancel
   * that trusted the recorded copy would overwrite a real success with a
   * decline and tell the agent a filed report was declined.
   */
  it("ignores a Cancel after filing even when the proposing turn left a stale recorded draft", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    const runner = (app as unknown as {
      runnerRegistry: { get(id: string): SessionRunnerInterface | undefined };
    }).runnerRegistry.get(sessionId)!;

    // Propose while a turn is running → the product code records the card on
    // the runner. Capture that real entry; it is the snapshot the bug hinges on.
    runner.running = true;
    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: { title: "Preview won't reload", body: "Something is broken in the editor." },
    });
    const card = (await client.receiveType("bug_report_card")) as WsBugReportCard;
    const draftSnapshot = runner.recordedCards.find((c) => c.message.bugReport?.cardId === card.cardId);
    expect(draftSnapshot?.message.bugReport?.phase).toBe("draft");
    const staleEntry = structuredClone(draftSnapshot!);

    // The proposing turn ends. `recordedCards` is cleared only at the NEXT turn
    // start, so the draft snapshot outlives the turn and goes stale.
    runner.running = false;
    client.send({ type: "submit_bug_report", cardId: card.cardId, title: card.title, body: card.body });
    await client.receiveType("bug_report_filed");

    // Reinstate that stale snapshot. In production it simply never went away;
    // here the outcome wake-turn's own start cleared it, so we restore it to
    // model the window before that turn runs (or when it never does).
    runner.recordedCards = [staleEntry];
    expect(runner.recordedCards[0].message.bugReport?.phase).toBe("draft");

    client.send({ type: "dismiss_bug_report", cardId: card.cardId });
    await new Promise((r) => setTimeout(r, 200));

    const historyAfter = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const cardsAfter = (historyAfter.json() as { messages: { bugReport?: PersistedBugReport }[] }).messages
      .map((m) => m.bugReport)
      .filter(Boolean);
    // The success stands: not rewritten to a decline, issue link not dropped.
    expect(cardsAfter[0]?.phase).toBe("filed");
    expect(cardsAfter[0]?.issueUrl).toContain("nikzlabs/shipit/issues/1234");
    // And the agent was never told a filed report had been declined.
    expect(agents.some((a) => a.lastPrompt.includes("DECLINED"))).toBe(false);

    client.close();
  });

  it("refuses a dismissal naming an unknown card", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    client.send({ type: "dismiss_bug_report", cardId: "bug-card-does-not-exist" });
    const err = (await client.receiveType("error")) as { message: string };
    expect(err.message).toMatch(/unknown bug report card/i);
    // No phantom collapse, and no wake about a card nobody proposed.
    expect(agents.some((a) => a.lastPrompt.includes("DECLINED"))).toBe(false);

    client.close();
  });

  it("ignores a Cancel that arrives after the report was already filed", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: { title: "Preview won't reload", body: "Something is broken in the editor." },
    });
    const card = (await client.receiveType("bug_report_card")) as WsBugReportCard;

    client.send({ type: "submit_bug_report", cardId: card.cardId, title: card.title, body: card.body });
    await client.receiveType("bug_report_filed");

    client.send({ type: "dismiss_bug_report", cardId: card.cardId });
    await new Promise((r) => setTimeout(r, 150));

    const historyAfter = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const cardsAfter = (historyAfter.json() as { messages: { bugReport?: PersistedBugReport }[] }).messages
      .map((m) => m.bugReport)
      .filter(Boolean);
    expect(cardsAfter[0]?.phase).toBe("filed");

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

/**
 * Poll the spawned agents for a wake-turn prompt matching `pattern`. The wake is
 * dispatched asynchronously after the card transition, so a bare read races it.
 */
async function waitForWakePrompt(
  getAgents: () => FakeClaudeProcess[],
  pattern: RegExp,
  timeoutMs = 3000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = getAgents().find((a) => pattern.test(a.lastPrompt));
    if (hit) return hit.lastPrompt;
    if (Date.now() > deadline) {
      throw new Error(
        `no wake-turn prompt matched ${pattern}; saw: ${JSON.stringify(getAgents().map((a) => a.lastPrompt))}`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}
