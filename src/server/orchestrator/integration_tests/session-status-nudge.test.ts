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
import type { WsServerMessage } from "../../shared/types.js";
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
 * docs/303 req 11–15, 21 — the whole path in one tree: a turn settles, the card is
 * marked stale at once, ShipIt sends the visible follow-up turn, and the tool call
 * that turn makes takes the card back to current. Each slice tested its own files;
 * this is what none of them could see.
 */
describe("Integration: the status-card settlement and its follow-up turn (docs/303)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let agents: FakeClaudeProcess[];
  let lastClaude: FakeClaudeProcess = null as never;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-status-nudge-"));
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
    } catch { /* ignore cleanup errors */ }
  });

  /** The tool's call path ends here; the worker relay in front of it is the worker's own test. */
  const callTool = (sessionId: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/sessions/${sessionId}/session-status`, payload });

  const card = (sessionId: string): SessionStatus | undefined =>
    sessionManager.get(sessionId)?.sessionStatus;

  /** Every message the session ever sent this viewer, so an assertion can look backwards. */
  function pump(client: TestClient): { seen: WsServerMessage[]; stop: () => void } {
    const seen: WsServerMessage[] = [];
    const state = { running: true };
    void (async () => {
      while (state.running) {
        try {
          seen.push(await client.receive(1000));
        } catch {
          // A quiet second is not the end of the session; only `stop` is.
        }
      }
    })();
    return { seen, stop: () => { state.running = false; } };
  }

  /** The dispatched turn's identity, not its prose: an edit to the prompt must not move this. */
  const followUps = (): FakeClaudeProcess[] =>
    agents.filter((a) => a.lastPrompt.startsWith("[ShipIt]"));

  const runnerFor = (sessionId: string) => app.runnerRegistry.get(sessionId);

  /**
   * The boundary a negative assertion needs: `running` alone clears at the drain, with the
   * commit, the nudge decision and the dispatch still to come. `agentBusy` covers the whole
   * post-turn sequence, because the nudge takes the same lease as the work around it.
   */
  async function postTurnSettled(sessionId: string): Promise<void> {
    await waitFor(() => {
      const runner = runnerFor(sessionId);
      return runner !== undefined && !runner.running && !runner.agentBusy;
    }, "the post-turn sequence finished");
  }

  /** A turn that writes the card, so the next turn's settlement has a stored one to mark. */
  async function turnThatWritesTheCard(client: TestClient, text: string): Promise<void> {
    const previous = lastClaude;
    client.send({ type: "send_message", text });
    const agent = await waitForClaude(() => lastClaude, previous);
    agent.initSession("written-turn");
    const res = await callTool(client.sessionId, { status: "Billing routes done; webhook not started." });
    expect(res.statusCode).toBe(200);
    agent.finish("written-turn");
    await postTurnSettled(client.sessionId);
    expect(card(client.sessionId)?.fresh).toBe(true);
  }

  it("marks the card stale at once and sends ONE visible [ShipIt] follow-up (req 11, 12)", async () => {
    const client = await TestClient.connect(port);
    const { seen, stop } = pump(client);

    await turnThatWritesTheCard(client, "Do the billing routes");
    const writer = lastClaude;

    client.send({ type: "send_message", text: "Now the webhook" });
    const skipper = await waitForClaude(() => lastClaude, writer);
    skipper.initSession("skipping-turn");
    skipper.finish("skipping-turn");

    await waitFor(() => card(client.sessionId)?.fresh === false, "card marked stale");
    // The words the user wrote survive the mark: only the freshness moved (req 14).
    expect(card(client.sessionId)?.status).toContain("Billing routes done");

    const nudge = await waitForClaude(() => lastClaude, skipper);
    // It asks for the one tool; the rest of its wording is the prompt file's business.
    expect(nudge.lastPrompt).toContain("session_status");

    // req 12 — visible in the conversation as a regular turn, not a silent one.
    await waitFor(
      () => seen.some((m) => m.type === "system_user_message" && m.text.startsWith("[ShipIt]")),
      "the follow-up's user row is echoed",
    );
    expect(followUps()).toHaveLength(1);

    stop();
    client.close();
  });

  it("takes the card back to current when the follow-up calls the tool, and stops there", async () => {
    const client = await TestClient.connect(port);
    const { stop } = pump(client);

    await turnThatWritesTheCard(client, "Do the billing routes");
    const writer = lastClaude;

    client.send({ type: "send_message", text: "Now the webhook" });
    const skipper = await waitForClaude(() => lastClaude, writer);
    skipper.initSession("skipping-turn");
    skipper.finish("skipping-turn");

    const nudge = await waitForClaude(() => lastClaude, skipper);
    nudge.initSession("nudge-turn");
    // A bare call is the agent confirming the card exactly as it stands (req 14).
    expect((await callTool(client.sessionId, {})).statusCode).toBe(200);
    nudge.finish("nudge-turn");

    await postTurnSettled(client.sessionId);
    expect(card(client.sessionId)?.fresh).toBe(true);
    expect(followUps()).toHaveLength(1);
    expect(runnerFor(client.sessionId)?.queueLength).toBe(0);

    stop();
    client.close();
  });

  it("nudges once per missing update: an ignored follow-up gets no second one (req 15)", async () => {
    const client = await TestClient.connect(port);
    const { stop } = pump(client);

    await turnThatWritesTheCard(client, "Do the billing routes");
    const writer = lastClaude;

    client.send({ type: "send_message", text: "Now the webhook" });
    const skipper = await waitForClaude(() => lastClaude, writer);
    skipper.initSession("skipping-turn");
    skipper.finish("skipping-turn");

    const nudge = await waitForClaude(() => lastClaude, skipper);
    nudge.initSession("nudge-turn");
    nudge.finish("nudge-turn");

    await postTurnSettled(client.sessionId);
    expect(followUps()).toHaveLength(1);
    expect(runnerFor(client.sessionId)?.queueLength).toBe(0);
    expect(card(client.sessionId)?.fresh).toBe(false);

    stop();
    client.close();
  });

  it("does not follow up a turn that ended with a question (req 13)", async () => {
    const client = await TestClient.connect(port);
    const { stop } = pump(client);

    await turnThatWritesTheCard(client, "Do the billing routes");
    const writer = lastClaude;

    client.send({ type: "send_message", text: "Which backend?" });
    const asker = await waitForClaude(() => lastClaude, writer);
    asker.initSession("question-turn");
    // The CLI's own done on interrupt is suppressed, so the turn still produces a
    // result: without it `receivedResult` would block the nudge and this test could
    // never fail on the question itself.
    asker.streamingInterrupt = true;
    asker.emit("event", {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "ask-1",
          name: "AskUserQuestion",
          input: {
            questions: [{
              question: "Pick a backend",
              header: "Backend",
              options: [{ label: "Redis", description: "In memory" }],
              multiSelect: false,
            }],
          },
        }],
      },
    });
    await waitFor(() => asker.interrupted, "the question interrupted the turn");
    asker.finish("question-turn");

    // The card may lag by a turn there, and says so (req 13, 14).
    await waitFor(() => card(client.sessionId)?.fresh === false, "card marked stale");
    await postTurnSettled(client.sessionId);
    expect(followUps()).toHaveLength(0);
    expect(runnerFor(client.sessionId)?.queueLength).toBe(0);

    stop();
    client.close();
  });

  it("defers to a queued successor, leaving nothing queued behind it", async () => {
    const client = await TestClient.connect(port);
    const { stop } = pump(client);

    await turnThatWritesTheCard(client, "Do the billing routes");
    const writer = lastClaude;

    client.send({ type: "send_message", text: "First" });
    const first = await waitForClaude(() => lastClaude, writer);
    first.initSession("first-turn");
    client.send({ type: "send_message", text: "Second" });
    await waitFor(
      () => (runnerFor(client.sessionId)?.queueLength ?? 0) > 0,
      "the successor is queued",
    );
    first.finish("first-turn");

    // The queued user turn runs next, and the deferral leaves nothing behind it:
    // counting spawned follow-ups alone would miss a nudge waiting in the queue.
    const second = await waitForClaude(() => lastClaude, first);
    expect(second.lastPrompt).toContain("Second");
    expect(followUps()).toHaveLength(0);
    expect(runnerFor(client.sessionId)?.queueLength).toBe(0);

    // And the successor is checked afresh: it writes, so it is not nudged either.
    second.initSession("second-turn");
    expect((await callTool(client.sessionId, {})).statusCode).toBe(200);
    second.finish("second-turn");

    await postTurnSettled(client.sessionId);
    expect(followUps()).toHaveLength(0);
    expect(card(client.sessionId)?.fresh).toBe(true);
    expect(runnerFor(client.sessionId)?.queueLength).toBe(0);

    stop();
    client.close();
  });

  describe("on the streaming path", () => {
    beforeEach(() => {
      credentialStore.setLiveSteering(true);
    });

    it("spawns exactly one follow-up for agent_result and done together", async () => {
      const client = await TestClient.connect(port);
      const { stop } = pump(client);

      await turnThatWritesTheCard(client, "Do the billing routes");
      const writer = lastClaude;

      client.send({ type: "send_message", text: "Now the webhook" });
      const skipper = await waitForClaude(() => lastClaude, writer);
      skipper.initSession("skipping-turn");
      expect(skipper.lastUseStreaming).toBe(true);

      skipper.emit("event", { type: "result", subtype: "success", session_id: "skipping-turn" });
      const nudge = await waitForClaude(() => lastClaude, skipper);
      nudge.initSession("nudge-turn");

      // The process's own exit lands after the follow-up turn already owns the runner.
      skipper.emit("done", 0);
      nudge.finish("nudge-turn");
      await postTurnSettled(client.sessionId);

      expect(followUps()).toHaveLength(1);
      expect(runnerFor(client.sessionId)?.queueLength).toBe(0);

      stop();
      client.close();
    });

    it("leaves the card current when a predecessor exits long after a later turn wrote", async () => {
      const client = await TestClient.connect(port);
      const { stop } = pump(client);

      await turnThatWritesTheCard(client, "Do the billing routes");
      const writer = lastClaude;

      client.send({ type: "send_message", text: "Now the webhook" });
      const skipper = await waitForClaude(() => lastClaude, writer);
      skipper.initSession("skipping-turn");
      skipper.emit("event", { type: "result", subtype: "success", session_id: "skipping-turn" });

      // The follow-up writes and finishes...
      const nudge = await waitForClaude(() => lastClaude, skipper);
      nudge.initSession("nudge-turn");
      expect((await callTool(client.sessionId, {})).statusCode).toBe(200);
      nudge.finish("nudge-turn");
      await waitFor(() => card(client.sessionId)?.fresh === true, "the follow-up made it current");

      // ...and a further turn is under way, which resets `statusUpdated` — so nothing
      // but the predecessor's own snapshot stands between its late exit and a stale
      // mark on a card two turns newer than anything it saw.
      client.send({ type: "send_message", text: "And now something else" });
      const later = await waitForClaude(() => lastClaude, nudge);
      later.initSession("later-turn");
      await waitFor(
        () => runnerFor(client.sessionId)?.statusUpdated === false,
        "the later turn reset the update flag",
      );

      skipper.emit("done", 0);
      await new Promise((r) => setTimeout(r, 100));
      expect(card(client.sessionId)?.fresh).toBe(true);

      later.finish("later-turn");
      stop();
      client.close();
    });

    /**
     * req 34 / planning#589 — Nik steered an agent that was waiting on background work and
     * got a nudge turn instead of his message. A steer goes straight to the CLI, so it is
     * neither running nor queued at settlement. Nudging there does not merely ask
     * needlessly: the nudge is a system turn, so it retires the resident process and the
     * message the user just sent is never answered.
     *
     * Both orderings, because a rule that reads the transcript to tell an answered steer
     * from a pending one passes the first and fails the second — the turn's own closing
     * text lands before the CLI acknowledges the message.
     */
    for (const closingText of [false, true]) {
      const label = closingText
        ? "even when the turn's own last text lands before the acknowledgement"
        : "when nothing in the turn follows the steer";
      it(`does not nudge a turn the user steered into, ${label} (req 34)`, async () => {
        const client = await TestClient.connect(port);
        const { stop } = pump(client);

        client.send({ type: "send_message", text: "Do the billing routes" });
        const resident = await waitForClaude(() => lastClaude);
        resident.initSession("resident-turn");
        expect((await callTool(client.sessionId, { status: "Billing done." })).statusCode).toBe(200);
        resident.emit("event", { type: "result", subtype: "success", session_id: "resident-turn" });
        await waitFor(() => runnerFor(client.sessionId)?.running === false, "the first turn settled");

        // A turn that launches background work and never touches the card.
        client.send({ type: "send_message", text: "Kick off the tests" });
        await waitFor(() => runnerFor(client.sessionId)?.running === true, "the second turn is running");
        runnerFor(client.sessionId)?.setBackgroundTasks([{ id: "t1", description: "npm test" }]);

        // Nik steers it. The CLI replays the message, which is how ShipIt learns it was taken.
        client.send({ type: "send_message", text: "Actually, also check the linter" });
        await waitFor(
          () => (runnerFor(client.sessionId)?.steeredMessages.length ?? 0) > 0,
          "the steer was recorded",
        );
        if (closingText) {
          resident.emit("event", {
            type: "assistant",
            message: { content: [{ type: "text", text: "Tests are running in the background." }] },
          });
          await waitFor(
            () => (runnerFor(client.sessionId)?.chatMessageGroups.length ?? 0) > 0,
            "the turn's closing text was accumulated",
          );
        }
        resident.emit("event", { type: "agent_user_replay", text: "Actually, also check the linter" });
        await waitFor(
          () => runnerFor(client.sessionId)?.steeredMessages[0]?.delivered === true,
          "the CLI acknowledged the steer",
        );

        // The last background task finishes and the turn the steer landed in ends.
        runnerFor(client.sessionId)?.setBackgroundTasks([]);
        resident.emit("event", { type: "result", subtype: "success", session_id: "resident-turn" });

        await waitFor(() => card(client.sessionId)?.fresh === false, "card marked stale");
        // Not `postTurnSettled`: a nudge that DOES go out keeps the runner busy, and the
        // failure this guards must be the follow-up below, not a timeout on the barrier.
        await waitFor(() => {
          const runner = runnerFor(client.sessionId);
          return followUps().length > 0
            || (runner !== undefined && !runner.running && !runner.agentBusy);
        }, "the settlement finished, or spawned a follow-up turn");

        expect(followUps()).toHaveLength(0);
        expect(runnerFor(client.sessionId)?.queueLength).toBe(0);
        // The process that holds the steered message is still the one on the session.
        expect(resident.killed).toBe(false);
        expect(runnerFor(client.sessionId)?.getAgent()).toBe(resident);

        stop();
        client.close();
      });
    }

    it("retires a resident spawned across a toggle and respawns it with the other prompt (req 21)", async () => {
      const client = await TestClient.connect(port);
      const { stop } = pump(client);

      client.send({ type: "send_message", text: "Do the billing routes" });
      const first = await waitForClaude(() => lastClaude);
      first.initSession("resident-turn");
      expect(first.lastSessionStatusCard).toBe(true);
      expect(first.lastSystemPrompt).toContain("## Session status");
      await callTool(client.sessionId, { status: "Billing routes done." });
      // A result with no exit: the process stays resident for the next turn.
      first.emit("event", { type: "result", subtype: "success", session_id: "resident-turn" });
      await waitFor(
        () => app.runnerRegistry.get(client.sessionId)?.running === false,
        "the turn settled with the process still resident",
      );
      expect(app.runnerRegistry.get(client.sessionId)?.getAgent()).toBe(first);

      // The control: with the setting unchanged, the next turn reuses that process.
      client.send({ type: "send_message", text: "Reuse me" });
      await waitFor(() => first.stdinData.length > 0, "the resident took the next turn");
      expect(agents).toHaveLength(1);
      first.emit("event", { type: "result", subtype: "success", session_id: "resident-turn" });
      await waitFor(
        () => app.runnerRegistry.get(client.sessionId)?.running === false,
        "the reused turn settled",
      );

      credentialStore.setSessionStatusCard(false);
      client.send({ type: "send_message", text: "After the toggle" });
      const second = await waitForClaude(() => lastClaude, first);

      expect(first.killed).toBe(true);
      expect(agents).toHaveLength(2);
      expect(second.lastSessionStatusCard).toBeUndefined();
      expect(second.lastSystemPrompt).toContain("## Proposing optional follow-up actions");
      expect(second.lastSystemPrompt).not.toContain("## Session status");

      stop();
      client.close();
    });
  });

  describe("with the setting off", () => {
    beforeEach(() => {
      credentialStore.setSessionStatusCard(false);
    });

    it("is today's behaviour: no card, no mark, no follow-up, and the action tool in the prompt", async () => {
      const client = await TestClient.connect(port);
      const { stop } = pump(client);

      client.send({ type: "send_message", text: "Do the billing routes" });
      const agent = await waitForClaude(() => lastClaude);
      agent.initSession("off-turn");

      expect(agent.lastSessionStatusCard).toBeUndefined();
      expect(agent.lastSystemPrompt).toContain("## Proposing optional follow-up actions");
      expect(agent.lastSystemPrompt).not.toContain("## Session status");

      // The route is closed while the setting is off, so no card can appear behind it.
      const refused = await callTool(client.sessionId, { status: "Written with the card off." });
      expect(refused.statusCode).toBe(409);

      agent.finish("off-turn");
      await postTurnSettled(client.sessionId);

      expect(card(client.sessionId)).toBeUndefined();
      expect(followUps()).toHaveLength(0);
      expect(agents).toHaveLength(1);
      expect(runnerFor(client.sessionId)?.queueLength).toBe(0);

      stop();
      client.close();
    });

    it("leaves a card stored from before the toggle exactly as it was", async () => {
      const client = await TestClient.connect(port);
      const { stop } = pump(client);

      credentialStore.setSessionStatusCard(true);
      await turnThatWritesTheCard(client, "Do the billing routes");
      const writer = lastClaude;
      const before = card(client.sessionId);
      credentialStore.setSessionStatusCard(false);

      client.send({ type: "send_message", text: "Now the webhook" });
      const skipper = await waitForClaude(() => lastClaude, writer);
      skipper.initSession("off-turn");
      skipper.finish("off-turn");
      await postTurnSettled(client.sessionId);

      // Off changes nothing stored: the settlement does not even read the card.
      expect(card(client.sessionId)).toEqual(before);
      expect(followUps()).toHaveLength(0);
      expect(runnerFor(client.sessionId)?.queueLength).toBe(0);

      stop();
      client.close();
    });
  });
});
