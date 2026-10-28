import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import type { DatabaseManager } from "../../shared/database.js";
import { buildInboxNotice, INBOX_TURN_TEXT } from "../services/session-inbox-notice.js";
import { clearSessionReportRateLimits } from "../services/session-report.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
  createTestSession,
} from "./test-helpers.js";

/**
 * docs/328-session-message-inbox, through the app: the report route, the turn that
 * ShipIt starts, the notice on a turn the user starts (`agent-execution.ts`), and the
 * read route. The rules themselves are in `services/session-inbox.test.ts`.
 */
describe("Integration: session message inbox", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let parentId: string;
  let childId: string;
  let agents: FakeClaudeProcess[];

  beforeEach(async () => {
    clearSessionReportRateLimits();
    agents = [];
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-inbox-"));
    sessionManager = new SessionManager(dbManager);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        const agent = new FakeClaudeProcess();
        agents.push(agent);
        return agent as unknown as never;
      },
      credentialStore: createTestCredentialStore(tmpDir),
      databaseManager: dbManager,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);

    parentId = (await createTestSession(sessionManager, tmpDir, "Coordinator")).sessionId;
    childId = (await createTestSession(sessionManager, tmpDir, "Parser slice")).sessionId;
    sessionManager.setParentSession(childId, parentId);
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore */ }
  });

  const report = (body: string) =>
    app.inject({ method: "POST", url: `/api/sessions/${childId}/report`, payload: { body, severity: "warn" } });

  const readInbox = async (sessionId: string, all = false) =>
    (await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/inbox/read`, payload: { all } }))
      .json().messages as { id: number; text: string; from?: { sessionId: string; relation: string } }[];

  async function agentRun(index: number): Promise<FakeClaudeProcess> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const agent = agents[index];
      if (agent?.runCalled) return agent;
      if (Date.now() > deadline) throw new Error(`agent ${index} did not run`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async function finish(agent: FakeClaudeProcess): Promise<void> {
    agent.emit("event", { type: "result", subtype: "success", session_id: "agent-sid" });
    agent.emit("done", 0);
    await new Promise((r) => setTimeout(r, 100));
  }

  it("turns two reports to an idle parent into one turn, and one read returns both", async () => {
    const first = await report("The regen command deletes every catalog.");
    expect(first.statusCode).toBe(200);
    expect(first.json().recipients).toEqual([
      expect.objectContaining({ sessionId: parentId, woken: true, told: "started" }),
    ]);
    const agent = await agentRun(0);
    // The parent's turn runs now; the second report starts no second turn.
    expect((await report("It also resets the lock file.")).json().recipients[0].told).toBe("later");

    // The turn says that messages wait. Their text is in the inbox, not in the turn (req 1).
    expect(agent.lastPrompt).toContain(buildInboxNotice(1));
    expect(agent.lastPrompt.endsWith(INBOX_TURN_TEXT)).toBe(true);
    expect(agent.lastPrompt).not.toContain("The regen command deletes every catalog.");

    const read = await readInbox(parentId);
    expect(read.map((m) => m.from)).toEqual([
      { sessionId: childId, sessionTitle: "Parser slice", relation: "child" },
      { sessionId: childId, sessionTitle: "Parser slice", relation: "child" },
    ]);
    expect(read[0]!.text).toContain("The regen command deletes every catalog.");
    expect(read[1]!.text).toContain("It also resets the lock file.");
    expect(await readInbox(parentId)).toEqual([]);
    expect(await readInbox(parentId, true)).toHaveLength(2);

    await finish(agent);
    expect(agents.filter((a) => a.runCalled)).toHaveLength(1);
    // The user still has a card for each report in the parent's transcript.
    expect(app.chatHistoryManager.load(parentId).filter((m) => m.sessionReport)).toHaveLength(2);
  });

  it("gives a parent that was busy with the user's turn one turn when that turn ends", async () => {
    const client = await TestClient.connect(port, parentId);
    await client.receive();
    client.send({ type: "send_message", text: "Refactor the parser." });
    const usersTurn = await agentRun(0);

    expect((await report("Found during your refactor.")).json().recipients[0].told).toBe("later");
    expect((await report("And one more thing.")).json().recipients[0].told).toBe("later");
    expect(usersTurn.lastPrompt).toBe("Refactor the parser.");

    await finish(usersTurn);
    const inboxTurn = await agentRun(1);
    client.close();

    expect(inboxTurn.lastPrompt).toContain(buildInboxNotice(2));
    expect(inboxTurn.lastPrompt.endsWith(INBOX_TURN_TEXT)).toBe(true);
    await finish(inboxTurn);
    expect(agents.filter((a) => a.runCalled)).toHaveLength(2);
  });

  it("holds the notice while the agent waits for the user's answer, and the user's reply carries it", async () => {
    sessionManager.setAwaitingAnswer(parentId, true);

    expect((await report("Found while you were waiting.")).json().recipients[0].told).toBe("later");
    await new Promise((r) => setTimeout(r, 150));
    expect(agents.filter((a) => a.runCalled)).toHaveLength(0);

    const client = await TestClient.connect(port, parentId);
    await client.receive();
    client.send({ type: "send_message", text: "Use SQLite." });
    const agent = await agentRun(0);

    expect(agent.lastPrompt).toContain(buildInboxNotice(1));
    expect(agent.lastPrompt.endsWith("Use SQLite.")).toBe(true);

    await finish(agent);
    // The agent did not read in the user's turn, so ShipIt tells it again (planning#222).
    const inboxTurn = await agentRun(1);
    client.close();
    expect(inboxTurn.lastPrompt).toContain(buildInboxNotice(1));
    expect(inboxTurn.lastPrompt.endsWith(INBOX_TURN_TEXT)).toBe(true);
    expect(await readInbox(parentId)).toHaveLength(1);
    await finish(inboxTurn);
    expect(agents.filter((a) => a.runCalled)).toHaveLength(2);
  });

  it("404s a read for a session that does not exist", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions/nope/inbox/read", payload: {} });
    expect(res.statusCode).toBe(404);
  });
});
