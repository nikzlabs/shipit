import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import type { CredentialStore } from "../credential-store.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import { testDispatch } from "./dispatch-test-helpers.js";
import { TURN_COMPLETED } from "../turn-settlement.js";
import { releaseQueuedTurn } from "../queue-drain.js";
import { turnClaimGateKeyCount } from "../ws-handlers/turn-claim-gate.js";
import { takeSessionHold } from "../session-hold.js";

type AnyMsg = any;

const WAKE_TEXT = "Child PR #42 merged: child (child-id).";

describe("Integration: a dispatched wake behind a real turn (planning#256/planning#257)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let lastClaude: FakeClaudeProcess = null as never;
  let dbManager: DatabaseManager;
  // Set by a test that needs a turn's local commit to stay pending.
  let commitGate: Promise<void> | null = null;
  let commitsStarted = 0;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as never;
    commitGate = null;
    commitsStarted = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-wake-queue-"));
    credentialStore = createTestCredentialStore(tmpDir);

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => {
        const git = new GitManager(dir);
        const autoCommit = git.autoCommit.bind(git);
        git.autoCommit = async (...args) => {
          commitsStarted += 1;
          if (commitGate) await commitGate;
          return autoCommit(...args);
        };
        return git;
      },
      sessionManager: new SessionManager(dbManager),
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
    const match = /:(\d+)$/.exec(address);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore cleanup errors */ }
  });

  async function drainUntil(client: TestClient, predicate: (m: AnyMsg) => boolean, maxMsgs = 30, timeoutMs = 2000): Promise<AnyMsg> {
    for (let i = 0; i < maxMsgs; i++) {
      const msg: AnyMsg = await client.receive(timeoutMs);
      if (predicate(msg)) return msg;
    }
    return null;
  }

  async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`waitUntil("${label}") timed out`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  function runnerFor(sessionId: string): SessionRunnerInterface {
    return (app as any).runnerRegistry.get(sessionId) as SessionRunnerInterface;
  }

  it("planning#256: live steering on + a real streaming user turn — a wake that asks for its own turn is QUEUED, not steered, and its onTurnComplete survives to fire", async () => {
    credentialStore.setLiveSteering(true);

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Refactor the parser" });
    const userTurn = await waitForClaude(() => lastClaude);
    userTurn.initSession("user-turn-session");
    expect(userTurn.lastUseStreaming).toBe(true);

    const runner = runnerFor(client.sessionId);
    await waitUntil(() => runner.running && runner.isStreamingActive, "user turn running + streaming");

    const completions: { errored: boolean }[] = [];
    runner.dispatch(testDispatch({
      text: WAKE_TEXT,
      activity: "Resuming after child PR merged…",
      automatic: true,
      onTurnComplete: (outcome) => completions.push(outcome),
    }), { whenBusy: "queue" });

    const queued = await drainUntil(client, (m) => m.type === "message_queued");
    expect(queued).toMatchObject({ type: "message_queued", text: WAKE_TEXT });
    expect(runner.queueLength).toBe(1);
    expect(userTurn.stdinData.join("")).not.toContain("MERGED");
    expect(completions).toEqual([]);

    userTurn.finish("user-turn-session");
    const wakeTurn = await waitForClaude(() => lastClaude, userTurn);
    expect(wakeTurn.lastPrompt).toContain("merged");

    wakeTurn.finish("wake-turn-session");
    await waitUntil(() => completions.length > 0, "onTurnComplete fired");
    expect(completions).toEqual([TURN_COMPLETED]);

    client.close();
  });

  it("planning#257: a wake-turn queued behind a real INTERACTIVE turn runs as its own turn and fires onTurnComplete (no restart)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Write the docs" });
    const userTurn = await waitForClaude(() => lastClaude);
    userTurn.initSession("user-turn-session");

    const runner = runnerFor(client.sessionId);
    await waitUntil(() => runner.running, "user turn running");

    const completions: { errored: boolean }[] = [];
    runner.dispatch(testDispatch({
      text: WAKE_TEXT,
      activity: "Resuming after child PR merged…",
      automatic: true,
      onTurnComplete: (outcome) => completions.push(outcome),
    }), { whenBusy: "queue" });
    await drainUntil(client, (m) => m.type === "message_queued");
    expect(runner.queueLength).toBe(1);

    userTurn.finish("user-turn-session");
    const wakeTurn = await waitForClaude(() => lastClaude, userTurn);
    expect(wakeTurn.lastPrompt).toContain("merged");

    wakeTurn.finish("wake-turn-session");
    await waitUntil(() => completions.length > 0, "onTurnComplete fired");
    expect(completions).toEqual([TURN_COMPLETED]);

    client.close();
  });

  it("docs/288 req 6: a typed message is QUEUED while ShipIt is merging, then STARTS when the hold clears", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First" });
    const first = await waitForClaude(() => lastClaude);
    first.initSession("first-session");
    first.finish("first-session");
    const runner = runnerFor(client.sessionId);
    // The release below declines while the first turn's commit is still pending.
    await waitUntil(() => !runner.running && !runner.turnCommitPending, "first turn finished and committed");

    runner.mergeHold = true;
    const before = lastClaude;
    client.send({ type: "send_message", text: "typed during the merge" });
    await drainUntil(client, (m) => m.type === "message_queued");
    expect(runner.running).toBe(false);
    expect(runner.queueLength).toBe(1);
    expect(lastClaude).toBe(before);

    runner.mergeHold = false;
    expect(releaseQueuedTurn(runner)).toBe(true);
    const resumed = await waitForClaude(() => lastClaude, before ?? undefined);
    expect(resumed.lastPrompt).toContain("typed during the merge");
    expect(runner.queueLength).toBe(0);
    resumed.finish("resumed-session");

    client.close();
  });

  it("docs/288 req 6: a message is queued even when the hold arrives DURING the send", async () => {
    const claims = (app as unknown as { agentMergeClaims: { markMergeInFlight(id: string): void } })
      .agentMergeClaims;
    const client = await TestClient.connect(port);
    await client.receive();

    const registry = (app as unknown as {
      runnerRegistry: { dispose(id: string, o?: { force?: boolean }): void; get(id: string): unknown };
    }).runnerRegistry;
    registry.dispose(client.sessionId, { force: true });
    expect(registry.get(client.sessionId)).toBeUndefined();

    claims.markMergeInFlight(client.sessionId);
    const before = lastClaude;
    client.send({ type: "send_message", text: "typed as the merge began" });
    await drainUntil(client, (m) => m.type === "message_queued");

    const runner = runnerFor(client.sessionId);
    expect(runner.mergeHold).toBe(true);
    expect(runner.running).toBe(false);
    expect(runner.queueLength).toBe(1);
    expect(lastClaude).toBe(before);

    client.close();
  });

  it("docs/288 req 6: a resident streaming agent is not steered into during a merge", async () => {
    credentialStore.setLiveSteering(true);
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First" });
    const first = await waitForClaude(() => lastClaude);
    first.initSession("first-session");
    first.finish("first-session");
    const runner = runnerFor(client.sessionId);
    await waitUntil(() => !runner.running, "first turn finished");
    // Restore residency explicitly because finish() clears the fake agent.
    runner.isStreamingActive = true;
    runner.setAgent(first as never);
    expect(runner.getAgent()).not.toBeNull();
    expect(credentialStore.getLiveSteering()).toBe(true);

    runner.mergeHold = true;
    client.send({ type: "send_message", text: "steer me mid-merge" });
    await drainUntil(client, (m) => m.type === "message_queued");

    expect(first.stdinData).toEqual([]);
    expect(runner.queueLength).toBe(1);
    expect(runner.running).toBe(false);

    client.close();
  });

  it("docs/288 req 6: an AskUserQuestion answer is QUEUED while ShipIt is merging", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First" });
    const first = await waitForClaude(() => lastClaude);
    first.initSession("first-session");
    first.finish("first-session");
    const runner = runnerFor(client.sessionId);
    await waitUntil(() => !runner.running, "first turn finished");

    runner.mergeHold = true;
    const before = lastClaude;
    client.send({
      type: "answer_question", toolUseId: "tu1", answers: { q: "yes" }, text: "yes",
      permissionMode: "plan",
    });
    await drainUntil(client, (m) => m.type === "message_queued");
    expect(runner.running).toBe(false);
    expect(runner.queueLength).toBe(1);
    expect(lastClaude).toBe(before);

    const queued = runner.dequeue();
    expect(queued?.text).toContain("yes");
    expect(queued?.permissionMode).toBe("plan");

    client.close();
  });

  // Post-turn invariant 1, from outside the queue: `running` is false while the commit is open.
  async function endFirstTurnWithItsCommitHeld(client: TestClient): Promise<{
    first: FakeClaudeProcess;
    runner: SessionRunnerInterface;
    landCommit: () => void;
  }> {
    let land = (): void => {};
    commitGate = new Promise<void>((resolve) => { land = resolve; });
    client.send({ type: "send_message", text: "First" });
    const first = await waitForClaude(() => lastClaude);
    first.initSession("first-session");
    first.finish("first-session");
    const runner = runnerFor(client.sessionId);
    await waitUntil(() => commitsStarted === 1, "first turn's commit started");
    expect([runner.running, runner.turnCommitPending]).toEqual([false, true]);
    return { first, runner, landCommit: () => { commitGate = null; land(); } };
  }

  // The send gate is held from the handler's entry to its claim, so a count of one says the
  // frame arrived; the pause after it is what an unguarded handler needs to reach the claim.
  async function sendHandlerIsWaiting(): Promise<void> {
    await waitUntil(() => turnClaimGateKeyCount() === 1, "the send handler holds its gate");
    await new Promise((r) => setTimeout(r, 150));
  }

  // A typed message waits rather than queues, so it keeps the interactive executor.
  it("a send_message typed while the last turn's commit is pending STARTS only after the commit", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const { first, runner, landCommit } = await endFirstTurnWithItsCommitHeld(client);

    client.send({ type: "send_message", text: "typed during the commit" });
    await sendHandlerIsWaiting();
    expect(lastClaude).toBe(first);
    expect([runner.running, runner.queueLength]).toEqual([false, 0]);

    landCommit();
    const resumed = await waitForClaude(() => lastClaude, first);
    expect(resumed.lastPrompt).toContain("typed during the commit");
    expect(runner.turnCommitPending).toBe(false);
    resumed.finish("resumed-session");
    await waitUntil(() => !runner.running && !runner.postTurnWorkInFlight, "second turn finished");

    client.close();
  });

  it("an answer_question sent while the last turn's commit is pending is QUEUED, then STARTS after the commit", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const { first, runner, landCommit } = await endFirstTurnWithItsCommitHeld(client);

    client.send({ type: "answer_question", toolUseId: "tu1", answers: { q: "x" }, text: "answered during the commit" });
    await drainUntil(client, (m) => m.type === "message_queued");
    expect([runner.running, runner.queueLength]).toEqual([false, 1]);
    expect(lastClaude).toBe(first);

    landCommit();
    const resumed = await waitForClaude(() => lastClaude, first);
    expect(resumed.lastPrompt).toContain("answered during the commit");
    expect(runner.queueLength).toBe(0);
    resumed.finish("resumed-session");
    await waitUntil(() => !runner.running && !runner.postTurnWorkInFlight, "second turn finished");

    client.close();
  });

  it("a wake that arrives while a typed message waits for the commit runs first, and the message follows", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const { first, runner, landCommit } = await endFirstTurnWithItsCommitHeld(client);

    client.send({ type: "send_message", text: "typed during the commit" });
    await sendHandlerIsWaiting();
    const wake = runner.dispatch(testDispatch({ text: WAKE_TEXT, automatic: true }), { whenBusy: "queue" });
    expect(wake.admitted).toBe("queued");
    expect(lastClaude).toBe(first);

    landCommit();
    const wakeTurn = await waitForClaude(() => lastClaude, first);
    expect(wakeTurn.lastPrompt).toContain("merged");
    await waitUntil(() => runner.queueLength === 1, "the typed message queued behind the wake");
    wakeTurn.finish("wake-session");
    const typedTurn = await waitForClaude(() => lastClaude, wakeTurn);
    expect(typedTurn.lastPrompt).toContain("typed during the commit");
    typedTurn.finish("typed-session");
    await waitUntil(() => !runner.running && !runner.postTurnWorkInFlight, "all turns finished");

    client.close();
  });

  // docs/329-user-steers-every-turn — a wake is an ordinary turn: it enters the resident, and
  // the background work that the resident runs goes on (planning#562 once deferred it instead).
  for (const start of ["interactive", "dispatched"] as const) {
    it(`a queued wake enters a resident agent with background work, and leaves the work running (after a ${start} turn)`, async () => {
      credentialStore.setLiveSteering(true);

      const client = await TestClient.connect(port);
      await client.receive();

      const runner = runnerFor(client.sessionId);
      if (start === "interactive") {
        client.send({ type: "send_message", text: "Review the branch" });
      } else {
        runner.dispatch(testDispatch({ text: "Review the branch" }));
      }
      const userTurn = await waitForClaude(() => lastClaude);
      userTurn.initSession("user-turn-session");
      await waitUntil(
        () => runner.running && runner.isStreamingActive && runner.getAgent() !== null,
        "resident streaming turn",
      );

      runner.setBackgroundTasks([{ id: "bg-1", description: "Codex consult" }]);

      const completions: { errored: boolean }[] = [];
      runner.dispatch(testDispatch({
        text: WAKE_TEXT,
        activity: "Resuming after child PR merged…",
        automatic: true,
        onTurnComplete: (outcome) => completions.push(outcome),
      }), { whenBusy: "queue" });
      await drainUntil(client, (m) => m.type === "message_queued");
      expect(runner.queueLength).toBe(1);

      // Settle the turn without exiting the process: the CLI stays resident, as it does
      // in production while its backgrounded work runs.
      userTurn.emit("event", { type: "result", subtype: "success", session_id: "user-turn-session" });
      await waitUntil(() => userTurn.stdinData.some((d) => d.includes("merged")), "the wake entered the resident");

      expect(runner.queueLength).toBe(0);
      expect(userTurn.killed).toBe(false);
      expect(runner.getAgent()).toBe(userTurn as never);
      expect(lastClaude).toBe(userTurn);
      expect(runner.backgroundWorkDescriptions).toEqual(["Codex consult"]);

      userTurn.emit("event", { type: "result", subtype: "success", session_id: "user-turn-session" });
      await waitUntil(() => completions.length > 0, "onTurnComplete fired");
      expect(completions).toEqual([TURN_COMPLETED]);

      client.close();
    });
  }

  // docs/329-user-steers-every-turn — a rebase or a restart can take the session during the commit.
  it("does not start a queued message under a hold taken while the turn's work was committed", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First" });
    const first = await waitForClaude(() => lastClaude);
    first.initSession("first-session");
    client.send({ type: "send_message", text: "Second" });
    await drainUntil(client, (m) => m.type === "message_queued");
    const runner = runnerFor(client.sessionId);

    let landCommit = (): void => {};
    commitGate = new Promise<void>((resolve) => { landCommit = resolve; });
    first.emit("event", { type: "result", subtype: "success", session_id: "first-session" });
    await waitUntil(() => commitsStarted === 1, "the turn's commit started");

    const hold = takeSessionHold(runner);
    commitGate = null;
    landCommit();
    await waitUntil(() => !runner.turnCommitPending, "the commit landed");
    await new Promise((r) => setTimeout(r, 150));

    expect(lastClaude).toBe(first);
    expect(runner.running).toBe(false);
    expect(runner.messageQueue.map((m) => m.text)).toEqual(["Second"]);

    hold.release();
    expect(releaseQueuedTurn(runner)).toBe(true);
    const second = await waitForClaude(() => lastClaude, first);
    expect(second.lastPrompt).toContain("Second");
    second.finish("second-session");
    client.close();
  });

  it("an ordinary user message queued behind a running turn still drains on the interactive path (no server echo bubble)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First" });
    const first = await waitForClaude(() => lastClaude);
    first.initSession("first-session");

    client.send({ type: "send_message", text: "Second" });
    await drainUntil(client, (m) => m.type === "message_queued");

    const echoes: AnyMsg[] = [];
    const collect = (async (): Promise<void> => {
      for (let i = 0; i < 20; i++) {
        const msg: AnyMsg = await client.receive(1500).catch(() => null);
        if (!msg) return;
        if (msg.type === "system_user_message") echoes.push(msg);
      }
    })();

    first.finish("first-session");
    const second = await waitForClaude(() => lastClaude, first);
    expect(second.lastPrompt).toContain("Second");

    second.finish("second-session");
    await Promise.race([collect, new Promise((r) => setTimeout(r, 300))]);
    expect(echoes.filter((m) => (m.text as string)?.includes("Second"))).toEqual([]);

    client.close();
  });
});
