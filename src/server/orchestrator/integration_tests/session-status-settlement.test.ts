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
 * docs/303 req 11–15, 21, 38 — the whole path in one tree: a turn settles, the card is
 * marked stale at once, the ask rides the NEXT turn's prompt, and the tool call that
 * turn makes takes the card back to current. Each slice tested its own files; this is
 * what none of them could see.
 */
describe("Integration: the status-card settlement and its ask (docs/303)", () => {
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

  /**
   * req 38 — ShipIt spends no turn on the card any more, so this is a guard that it
   * spawned none, not a count of nudges.
   */
  const followUps = (): FakeClaudeProcess[] =>
    agents.filter((a) => a.lastPrompt.startsWith("[ShipIt]"));

  /** The miss notice, as the agent reads it in the next turn's prompt. */
  const asksInPrompt = (agent: FakeClaudeProcess): boolean =>
    agent.lastPrompt.includes("ended without a status-card update");

  const runnerFor = (sessionId: string) => app.runnerRegistry.get(sessionId);

  /**
   * Some tests stand behind two complete turn set-ups before the step they are really
   * about, and the default 5s proved too tight for that on a loaded CI run (one flake per
   * full suite). The waits are on conditions, not on the clock, so a longer deadline costs
   * nothing when the box is quick.
   */
  const SLOW_CI_MS = 20_000;

  /**
   * The boundary a negative assertion needs: `running` alone clears at the drain, with
   * the commit and the settlement still to come. `agentBusy` covers the whole post-turn
   * sequence.
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

  it("marks the card stale at once and asks in the NEXT turn's prompt (req 11, 12, 38)", async () => {
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
    await postTurnSettled(client.sessionId);

    // No turn of ShipIt's own, and nothing added to the conversation (req 38).
    expect(followUps()).toHaveLength(0);
    expect(agents).toHaveLength(2);
    expect(seen.some((m) => m.type === "system_user_message" && m.text.startsWith("[ShipIt]")))
      .toBe(false);

    client.send({ type: "send_message", text: "And the README" });
    const next = await waitForClaude(() => lastClaude, skipper);
    expect(asksInPrompt(next)).toBe(true);
    expect(next.lastPrompt).toContain("And the README");

    stop();
    client.close();
  });

  it("takes the card back to current when the asked turn calls the tool, and drops the ask", async () => {
    const client = await TestClient.connect(port);
    const { stop } = pump(client);

    await turnThatWritesTheCard(client, "Do the billing routes");
    const writer = lastClaude;

    client.send({ type: "send_message", text: "Now the webhook" });
    const skipper = await waitForClaude(() => lastClaude, writer);
    skipper.initSession("skipping-turn");
    skipper.finish("skipping-turn");
    await waitFor(() => card(client.sessionId)?.nudgePending === true, "the ask was recorded");

    client.send({ type: "send_message", text: "And the README" });
    const next = await waitForClaude(() => lastClaude, skipper);
    next.initSession("next-turn");
    expect(asksInPrompt(next)).toBe(true);
    // A bare call is the agent confirming the card exactly as it stands (req 14).
    expect((await callTool(client.sessionId, {})).statusCode).toBe(200);
    next.finish("next-turn");

    await postTurnSettled(client.sessionId);
    expect(card(client.sessionId)?.fresh).toBe(true);
    expect(card(client.sessionId)?.nudgePending).toBeUndefined();
    expect(followUps()).toHaveLength(0);
    expect(runnerFor(client.sessionId)?.queueLength).toBe(0);

    stop();
    client.close();
  });

  it("keeps ONE outstanding ask however many turns ignore it, and spends no turn (req 15, 38)", async () => {
    const client = await TestClient.connect(port);
    const { stop } = pump(client);

    await turnThatWritesTheCard(client, "Do the billing routes");
    const writer = lastClaude;

    client.send({ type: "send_message", text: "Now the webhook" });
    const skipper = await waitForClaude(() => lastClaude, writer);
    skipper.initSession("skipping-turn");
    skipper.finish("skipping-turn");
    await waitFor(() => card(client.sessionId)?.nudgePending === true, "the ask was recorded");

    client.send({ type: "send_message", text: "And the README" });
    const ignorer = await waitForClaude(() => lastClaude, skipper);
    ignorer.initSession("ignoring-turn");
    expect(asksInPrompt(ignorer)).toBe(true);
    ignorer.finish("ignoring-turn");

    await postTurnSettled(client.sessionId);
    expect(followUps()).toHaveLength(0);
    expect(runnerFor(client.sessionId)?.queueLength).toBe(0);
    expect(card(client.sessionId)?.fresh).toBe(false);
    expect(card(client.sessionId)?.nudgePending).toBe(true);

    stop();
    client.close();
  });

  /**
   * planning#594 — Nik: "'Context compacted' event shouldn't require a nudge". Reproduced
   * here before the fix: a `/compact` the user types is an ordinary interactive turn, so
   * the `silent` exemption (which covers only ShipIt's own pre-turn compaction) missed it
   * and the card was both marked stale and asked about, beside the "Context compacted"
   * card. req 36 replaces that exemption with what the turn did.
   */
  it("neither asks nor marks stale after a compaction the user asked for (req 36)", async () => {
    const client = await TestClient.connect(port);
    const { stop } = pump(client);

    await turnThatWritesTheCard(client, "Do the billing routes");
    const writer = lastClaude;

    client.send({ type: "send_message", text: "/compact" });
    const compactor = await waitForClaude(() => lastClaude, writer);
    compactor.initSession("compaction-turn");
    compactor.finish("compaction-turn");

    await postTurnSettled(client.sessionId);
    expect(followUps()).toHaveLength(0);
    expect(card(client.sessionId)?.nudgePending).toBeUndefined();
    expect(runnerFor(client.sessionId)?.queueLength).toBe(0);
    // The card is untouched, not merely un-asked-about: a compaction changed nothing
    // about the session, so presenting the card as current is honest (req 14, 36).
    expect(card(client.sessionId)?.fresh).toBe(true);
    expect(card(client.sessionId)?.status).toContain("Billing routes done");

    stop();
    client.close();
  }, SLOW_CI_MS);

  it("does not ask about a turn that ended with a question (req 13)", async () => {
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
    expect(card(client.sessionId)?.nudgePending).toBeUndefined();
    expect(runnerFor(client.sessionId)?.queueLength).toBe(0);

    stop();
    client.close();
  });

  it("lets a queued successor run next, with nothing queued behind it", async () => {
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

    // The queued user turn runs next, with nothing of ShipIt's behind it.
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

    it("settles once for agent_result and done together", async () => {
      const client = await TestClient.connect(port);
      const { stop } = pump(client);

      await turnThatWritesTheCard(client, "Do the billing routes");
      const writer = lastClaude;

      client.send({ type: "send_message", text: "Now the webhook" });
      const skipper = await waitForClaude(() => lastClaude, writer);
      skipper.initSession("skipping-turn");
      expect(skipper.lastUseStreaming).toBe(true);

      skipper.emit("event", { type: "result", subtype: "success", session_id: "skipping-turn" });
      await waitFor(() => card(client.sessionId)?.nudgePending === true, "the ask was recorded");

      // The process's own exit lands later and must not settle the turn a second time.
      skipper.emit("done", 0);
      await postTurnSettled(client.sessionId);

      expect(followUps()).toHaveLength(0);
      expect(card(client.sessionId)?.turnSeq).toBe(2);
      expect(runnerFor(client.sessionId)?.queueLength).toBe(0);

      stop();
      client.close();
    });

    /**
     * req 34 / planning#589, and req 38's half of it. Nik steered an agent that was
     * waiting on background work and got a nudge turn instead of his message, because the
     * nudge was a system turn that retires the resident process holding it. The ask is now
     * a line in the next prompt, so what req 34 protected is protected by the ask not
     * being a turn — and the miss it used to drop, which is the drift report's largest
     * text-only shape, is recorded instead of lost.
     */
    for (const closingText of [false, true]) {
      const label = closingText
        ? "with the turn's own last text landing before the acknowledgement"
        : "with nothing in the turn following the steer";
      it(`records the ask without touching a steered turn's process, ${label} (req 34, 38)`, async () => {
        const client = await TestClient.connect(port);
        const { seen, stop } = pump(client);

        client.send({ type: "send_message", text: "Do the billing routes" });
        const resident = await waitForClaude(() => lastClaude);
        resident.initSession("resident-turn");
        expect((await callTool(client.sessionId, { status: "Billing done." })).statusCode).toBe(200);
        resident.emit("event", { type: "result", subtype: "success", session_id: "resident-turn" });
        await waitFor(() => runnerFor(client.sessionId)?.running === false, "the first turn settled");

        // A turn that launches background work and never touches the card. Waiting for the
        // resident to have the prompt, not merely for `running`: under load the send can
        // still be in its async setup, and the message after it would then start a turn of
        // its own rather than steer this one.
        const beforeSecond = resident.stdinData.length;
        client.send({ type: "send_message", text: "Kick off the tests" });
        await waitFor(
          () => resident.stdinData.length > beforeSecond
            && runnerFor(client.sessionId)?.running === true,
          "the resident took the second turn",
          SLOW_CI_MS,
        );
        runnerFor(client.sessionId)?.setBackgroundTasks([{ id: "t1", description: "npm test" }]);

        // Nik steers it. The CLI replays the message, which is how ShipIt learns it was taken.
        // Only what the session says from here on: an earlier message may legitimately
        // have been queued, and that is not this assertion's business.
        const beforeSteer = seen.length;
        const answeredSteer = () =>
          seen.slice(beforeSteer).filter((m) => m.type === "message_steered" || m.type === "message_queued");
        client.send({ type: "send_message", text: "Actually, also check the linter" });
        // The server says which path it took, so a message that was queued instead of
        // steered fails as that fact rather than as a bare timeout on the state below.
        await waitFor(() => answeredSteer().length > 0, "the session answered the steer", SLOW_CI_MS);
        expect(answeredSteer()[0]?.type).toBe("message_steered");
        await waitFor(
          () => (runnerFor(client.sessionId)?.steeredMessages.length ?? 0) > 0,
          "the steer was recorded",
          SLOW_CI_MS,
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
        await waitFor(
          () => card(client.sessionId)?.nudgePending === true,
          "the ask was recorded rather than dropped",
        );
        await postTurnSettled(client.sessionId);

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
      // req 35 — and the stored card reaches no turn while the setting is off.
      expect(skipper.lastPrompt).not.toContain("<session_status_card>");
      expect(followUps()).toHaveLength(0);
      expect(runnerFor(client.sessionId)?.queueLength).toBe(0);

      stop();
      client.close();
    });
  });

  /**
   * req 35 — the card is in the turn's prompt, which is what a resident process and every
   * harness alike receive. Without it the agent is asked to reconcile state it cannot read.
   */
  describe("the card reaches the turn (req 35)", () => {
    it("asks for the first card when none is stored yet (req 22, 38)", async () => {
      const client = await TestClient.connect(port);
      const { stop } = pump(client);

      client.send({ type: "send_message", text: "Do the billing routes" });
      const agent = await waitForClaude(() => lastClaude);
      // The nudge turn used to be what asked for the first card; this block replaces it.
      expect(agent.lastPrompt).toContain("no status card yet");
      expect(agent.lastPrompt).toContain("Do the billing routes");

      stop();
      client.close();
    });

    it("puts the stored card, its manual steps and its offers into the next turn's prompt", async () => {
      const client = await TestClient.connect(port);
      const { stop } = pump(client);

      await turnThatWritesTheCard(client, "Do the billing routes");
      const writer = lastClaude;
      expect(
        (await callTool(client.sessionId, {
          needsYou: ["Paste the Stripe test key."],
          actions: [{
            id: "webhook",
            label: "Wire the Stripe webhook",
            description: "Adds the route and its signature check.",
            payload: "Add /webhooks/stripe and verify the signature.",
          }],
        })).statusCode,
      ).toBe(200);

      client.send({ type: "send_message", text: "Now the webhook" });
      const next = await waitForClaude(() => lastClaude, writer);

      expect(next.lastPrompt).toContain("<session_status_card>");
      expect(next.lastPrompt).toContain("Billing routes done");
      expect(next.lastPrompt).toContain("- Paste the Stripe test key.");
      expect(next.lastPrompt).toContain("id: webhook");
      expect(next.lastPrompt).toContain("Add /webhooks/stripe and verify the signature.");
      // The user's own message is still last, after the standing context.
      expect(next.lastPrompt.indexOf("</session_status_card>"))
        .toBeLessThan(next.lastPrompt.indexOf("Now the webhook"));

      stop();
      client.close();
    });

    it("carries it on a message that waited in the queue behind a running turn", async () => {
      const client = await TestClient.connect(port);
      const { stop } = pump(client);

      await turnThatWritesTheCard(client, "Do the billing routes");
      const writer = lastClaude;

      client.send({ type: "send_message", text: "Now the webhook" });
      const running = await waitForClaude(() => lastClaude, writer);
      running.initSession("running-turn");
      // Queued, so it is composed when the queue drains rather than when the user sent it.
      client.send({ type: "send_message", text: "Then the README" });
      await waitFor(() => (runnerFor(client.sessionId)?.queueLength ?? 0) > 0, "message queued");
      running.finish("running-turn");

      const drained = await waitForClaude(() => lastClaude, running);
      expect(drained.lastPrompt).toContain("Then the README");
      expect(drained.lastPrompt).toContain("<session_status_card>");
      expect(drained.lastPrompt).toContain("Billing routes done");

      stop();
      client.close();
    });

  });
});
