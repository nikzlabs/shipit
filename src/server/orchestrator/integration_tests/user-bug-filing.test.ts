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

describe("Integration: user bug filing", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let githubAuthManager: StubGitHubAuthManager;
  let sessionId: string;
  let agents: FakeClaudeProcess[];

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "user-bug-filing-"));
    sessionManager = new SessionManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);
    agents = [];
    githubAuthManager = new StubGitHubAuthManager();
    await githubAuthManager.setToken("test-token");

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
    await client.receive();

    const relay = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: {
        title: "Preview won't reload",
        body: "It broke. My token ghp_ABCDEFGHIJKLMNOP1234567890abcd and email me@example.com.",
      },
    });
    expect(relay.statusCode).toBe(200);

    expect(githubAuthManager.createIssueCalls).toHaveLength(0);

    const card = (await client.receiveType("bug_report_card")) as WsBugReportCard;
    expect(card.title).toBe("Preview won't reload");
    expect(card.body).not.toContain("ghp_ABCDEFGHIJKLMNOP");
    expect(card.body).not.toContain("me@example.com");
    expect(card.body).toContain("[REDACTED]");
    expect(card.body).toContain("<!-- shipit-report source=session");
    expect(card.stage2Ran).toBe(false);
    expect(card.filedAs).toBe("test-user");

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
    await client.receive();

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
    await client.receive();

    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: { title: "Preview won't reload", body: "Something is broken in the editor." },
    });
    const card = (await client.receiveType("bug_report_card")) as WsBugReportCard;

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
    await client.receive();

    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: { title: "Preview won't reload", body: "Something is broken in the editor." },
    });
    const card = (await client.receiveType("bug_report_card")) as WsBugReportCard;

    histMgr.finalizeInProgress(sessionId);

    const historyBefore = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const cardsBefore = (historyBefore.json() as { messages: { bugReport?: PersistedBugReport }[] }).messages
      .map((m) => m.bugReport)
      .filter(Boolean);
    expect(cardsBefore).toHaveLength(1);
    expect(cardsBefore[0]?.phase).toBe("draft");

    client.send({ type: "submit_bug_report", cardId: card.cardId, title: card.title, body: card.body });
    await client.receiveType("bug_report_filed");

    const historyAfter = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const cardsAfter = (historyAfter.json() as { messages: { bugReport?: PersistedBugReport }[] }).messages
      .map((m) => m.bugReport)
      .filter(Boolean);
    expect(cardsAfter).toHaveLength(1);
    expect(cardsAfter[0]?.phase).toBe("filed");
    expect(cardsAfter[0]?.issueNumber).toBe(1234);
    expect(cardsAfter[0]?.issueUrl).toContain("nikzlabs/shipit/issues/1234");

    client.close();
  });

  it("(b/d) keeps a filed transition through finalize when the proposing turn is still in flight", async () => {
    const histMgr = (app as unknown as { chatHistoryManager: ChatHistoryManager }).chatHistoryManager;

    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: { title: "Preview won't reload", body: "Something is broken in the editor." },
    });
    const card = (await client.receiveType("bug_report_card")) as WsBugReportCard;

    const runner = (app as unknown as {
      runnerRegistry: { get(id: string): SessionRunnerInterface | undefined };
    }).runnerRegistry.get(sessionId)!;
    runner.running = true;

    client.send({ type: "submit_bug_report", cardId: card.cardId, title: card.title, body: card.body });
    await client.receiveType("bug_report_filed");

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
    expect(cardsAfter).toHaveLength(1);
    expect(cardsAfter[0]?.phase).toBe("filed");
    expect(cardsAfter[0]?.issueNumber).toBe(1234);

    client.close();
  });

  it("tells the agent the report was filed, with the issue number and URL, on the next user turn", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: { title: "Preview won't reload", body: "Something is broken in the editor." },
    });
    const card = (await client.receiveType("bug_report_card")) as WsBugReportCard;

    client.send({ type: "submit_bug_report", cardId: card.cardId, title: card.title, body: card.body });
    await client.receiveType("bug_report_filed");
    await settle();

    expect(agents).toHaveLength(0);

    const prompt = await sendUserTurn(client, () => agents, "What is left to do?");
    expect(prompt).toContain("FILED as issue #1234");
    expect(prompt).toContain("nikzlabs/shipit/issues/1234");
    expect(prompt).toContain("Preview won't reload");
    expect(prompt.endsWith("What is left to do?")).toBe(true);

    client.close();
  });

  it("delivers the outcome exactly once — the turn after that is clean", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: { title: "Preview won't reload", body: "Something is broken in the editor." },
    });
    const card = (await client.receiveType("bug_report_card")) as WsBugReportCard;
    client.send({ type: "submit_bug_report", cardId: card.cardId, title: card.title, body: card.body });
    await client.receiveType("bug_report_filed");

    const first = await sendUserTurn(client, () => agents, "First");
    expect(first).toContain("FILED as issue #1234");

    const second = await sendUserTurn(client, () => agents, "Second");
    expect(second).not.toContain("FILED as issue");
    expect(second).toBe("Second");

    client.close();
  });

  it("says nothing when filing failed — the report really is still pending", async () => {
    githubAuthManager.setCreateIssueResult({
      success: false,
      scopeError: true,
      message: "Your GitHub token can't file issues on the ShipIt repo.",
    });

    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: { title: "Preview won't reload", body: "Something is broken in the editor." },
    });
    const card = (await client.receiveType("bug_report_card")) as WsBugReportCard;

    client.send({ type: "submit_bug_report", cardId: card.cardId, title: card.title, body: card.body });
    await client.receiveType("bug_report_failed");

    const afterFailure = await sendUserTurn(client, () => agents, "Carry on");
    expect(afterFailure).toBe("Carry on");

    githubAuthManager.setCreateIssueResult(null);
    client.send({ type: "submit_bug_report", cardId: card.cardId, title: card.title, body: card.body });
    await client.receiveType("bug_report_filed");
    const afterSuccess = await sendUserTurn(client, () => agents, "And now?");
    expect(afterSuccess).toContain("FILED as issue #1234");

    client.close();
  });

  it("persists a dismissal and tells the agent the report was declined", async () => {
    const histMgr = (app as unknown as { chatHistoryManager: ChatHistoryManager }).chatHistoryManager;

    const client = await TestClient.connect(port, sessionId);
    await client.receive();

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

    expect(githubAuthManager.createIssueCalls).toHaveLength(0);

    const historyAfter = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const cardsAfter = (historyAfter.json() as { messages: { bugReport?: PersistedBugReport }[] }).messages
      .map((m) => m.bugReport)
      .filter(Boolean);
    expect(cardsAfter).toHaveLength(1);
    expect(cardsAfter[0]?.phase).toBe("dismissed");

    await settle();
    expect(agents).toHaveLength(0);

    const prompt = await sendUserTurn(client, () => agents, "Anything else?");
    expect(prompt).toContain("DECLINED by the user");
    expect(prompt).toContain("Preview won't reload");

    client.close();
  });

  it("ignores a Cancel after filing even when the proposing turn left a stale recorded draft", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    const runner = (app as unknown as {
      runnerRegistry: { get(id: string): SessionRunnerInterface | undefined };
    }).runnerRegistry.get(sessionId)!;

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

    runner.running = false;
    client.send({ type: "submit_bug_report", cardId: card.cardId, title: card.title, body: card.body });
    await client.receiveType("bug_report_filed");

    runner.recordedCards = [staleEntry];
    expect(runner.recordedCards[0].message.bugReport?.phase).toBe("draft");

    client.send({ type: "dismiss_bug_report", cardId: card.cardId });
    await new Promise((r) => setTimeout(r, 200));

    const historyAfter = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const cardsAfter = (historyAfter.json() as { messages: { bugReport?: PersistedBugReport }[] }).messages
      .map((m) => m.bugReport)
      .filter(Boolean);
    expect(cardsAfter[0]?.phase).toBe("filed");
    expect(cardsAfter[0]?.issueUrl).toContain("nikzlabs/shipit/issues/1234");
    const prompt = await sendUserTurn(client, () => agents, "Status?");
    expect(prompt).not.toContain("DECLINED");
    expect(prompt).toContain("FILED as issue #1234");

    client.close();
  });

  it("delivers an outcome that was resolved mid-turn, after that turn finalizes", async () => {
    const histMgr = (app as unknown as { chatHistoryManager: ChatHistoryManager }).chatHistoryManager;
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    const runner = (app as unknown as {
      runnerRegistry: { get(id: string): SessionRunnerInterface | undefined };
    }).runnerRegistry.get(sessionId)!;

    runner.running = true;
    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: { title: "Preview won't reload", body: "Something is broken in the editor." },
    });
    const card = (await client.receiveType("bug_report_card")) as WsBugReportCard;

    client.send({ type: "submit_bug_report", cardId: card.cardId, title: card.title, body: card.body });
    await client.receiveType("bug_report_filed");
    expect(
      runner.recordedCards.find((c) => c.message.bugReport?.cardId === card.cardId)?.message.bugReport
        ?.phase,
    ).toBe("filed");

    runner.running = false;
    histMgr.replaceInProgress(
      sessionId,
      buildTurnMessages(runner.chatMessageGroups, runner.steeredMessages, runner.recordedCards, {
        inProgress: false,
      }),
    );
    histMgr.finalizeInProgress(sessionId);

    const prompt = await sendUserTurn(client, () => agents, "Now what?");
    expect(prompt).toContain("FILED as issue #1234");

    client.close();
  });

  it("holds the outcome back on /compact, so the next real turn still gets it", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: { title: "Preview won't reload", body: "Something is broken in the editor." },
    });
    const card = (await client.receiveType("bug_report_card")) as WsBugReportCard;
    client.send({ type: "submit_bug_report", cardId: card.cardId, title: card.title, body: card.body });
    await client.receiveType("bug_report_filed");

    const compact = await sendUserTurn(client, () => agents, "/compact");
    expect(compact).not.toContain("FILED as issue");

    const real = await sendUserTurn(client, () => agents, "Carry on");
    expect(real).toContain("FILED as issue #1234");

    client.close();
  });

  it("refuses a Submit for a card the user already declined", async () => {
    const histMgr = (app as unknown as { chatHistoryManager: ChatHistoryManager }).chatHistoryManager;
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: { title: "Preview won't reload", body: "Something is broken in the editor." },
    });
    const card = (await client.receiveType("bug_report_card")) as WsBugReportCard;
    histMgr.finalizeInProgress(sessionId);

    client.send({ type: "dismiss_bug_report", cardId: card.cardId });
    await client.receiveType("bug_report_dismissed");

    client.send({ type: "submit_bug_report", cardId: card.cardId, title: card.title, body: card.body });
    await client.receiveType("bug_report_dismissed");
    expect(githubAuthManager.createIssueCalls).toHaveLength(0);

    const historyAfter = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const cardsAfter = (historyAfter.json() as { messages: { bugReport?: PersistedBugReport }[] }).messages
      .map((m) => m.bugReport)
      .filter(Boolean);
    expect(cardsAfter[0]?.phase).toBe("dismissed");

    const prompt = await sendUserTurn(client, () => agents, "Status?");
    expect(prompt).toContain("DECLINED by the user");
    expect(prompt).not.toContain("FILED as issue");

    client.close();
  });

  it("does not file twice when a stale tab re-submits an already-filed card", async () => {
    const histMgr = (app as unknown as { chatHistoryManager: ChatHistoryManager }).chatHistoryManager;
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/bug-report`,
      payload: { title: "Preview won't reload", body: "Something is broken in the editor." },
    });
    const card = (await client.receiveType("bug_report_card")) as WsBugReportCard;
    histMgr.finalizeInProgress(sessionId);

    client.send({ type: "submit_bug_report", cardId: card.cardId, title: card.title, body: card.body });
    await client.receiveType("bug_report_filed");

    client.send({ type: "submit_bug_report", cardId: card.cardId, title: card.title, body: card.body });
    const second = (await client.receiveType("bug_report_filed")) as { number: number };
    expect(second.number).toBe(1234);
    expect(githubAuthManager.createIssueCalls).toHaveLength(1);

    client.close();
  });

  it("refuses a dismissal naming an unknown card", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    client.send({ type: "dismiss_bug_report", cardId: "bug-card-does-not-exist" });
    const err = (await client.receiveType("error")) as { message: string };
    expect(err.message).toMatch(/unknown bug report card/i);
    const prompt = await sendUserTurn(client, () => agents, "Carry on");
    expect(prompt).toBe("Carry on");

    client.close();
  });

  it("ignores a Cancel that arrives after the report was already filed", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

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

async function settle(ms = 200): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function sendUserTurn(
  client: TestClient,
  getAgents: () => FakeClaudeProcess[],
  text: string,
  timeoutMs = 5000,
): Promise<string> {
  const before = getAgents().length;
  client.send({ type: "send_message", text });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const spawned = getAgents()[before];
    if (spawned?.runCalled) {
      spawned.emit("done", 0);
      await new Promise((r) => setTimeout(r, 50));
      return spawned.lastPrompt;
    }
    if (Date.now() > deadline) {
      throw new Error(`no agent spawned for user turn ${JSON.stringify(text)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}
