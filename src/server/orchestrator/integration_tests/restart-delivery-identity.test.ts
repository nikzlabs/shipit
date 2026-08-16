/**
 * Integration tests for durable DELIVERY IDENTITY across an orchestrator
 * restart (planning#266, docs/240's "later" layer).
 *
 * The gap these close: turn adoption reconnects the orchestrator to a turn that
 * outlived it, but the adopted turn used to reconstruct no completion
 * settlement — the callback it was dispatched with died with the previous
 * process. So for a turn dispatched on behalf of a notify-on-merge WATCH, after
 * a restart the turn kept running, the watch stayed non-terminal because nothing
 * could settle it, and `reconcilePending` queued a SECOND wake behind the
 * still-running first one. Startup ordering (adoption before reconcile, planning#261)
 * kept them from colliding; it never stopped the duplicate.
 *
 * The fix derives liveness instead of tracking it: the wake-turn carries a
 * durable `deliveryId`, the worker records it and reports it from
 * `/agent/status`, adoption rebinds that delivery's settlement, and reconcile
 * redispatches only when no live runner reports the delivery.
 *
 * The harness is deliberately the honest one from `restart-turn-adoption.test.ts`
 * — a REAL `SessionWorker` over HTTP + SSE, a REAL `ContainerSessionRunner`, and
 * a REAL `MergeWatchManager` over a real `SessionManager`. Nothing here would
 * catch the bug if the delivery id were faked at the orchestrator boundary: the
 * whole point is that the id makes the round trip through the worker.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { SessionWorker } from "../../session/session-worker.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { UsageManager } from "../usage.js";
import { MergeWatchManager } from "../merge-watch.js";
import { DatabaseManager } from "../../shared/database.js";
import type { SessionRunnerInterface, SessionRunnerRegistry, SystemTurnDeps } from "../session-runner.js";
import type { PrStatusSummary } from "../../shared/types/github-types.js";
import type {
  AgentProcess,
  AgentProcessEvents,
  AgentId,
  AgentRunParams,
  PermissionMode,
  WorkerAgentStatus,
} from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Worker-side fake agent
// ---------------------------------------------------------------------------

class FakeWorkerAgent extends EventEmitter<AgentProcessEvents> implements AgentProcess {
  readonly agentId: AgentId = "claude";
  readonly capabilities = {
    supportsResume: true,
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: true,
    supportedPermissionModes: [] as PermissionMode[],
    toolNames: [] as string[],
    models: [] as string[],
    supportsReview: true,
    supportsSteering: false,
    supportsCompaction: false,
    skillsDirName: ".claude",
    skillInvocationPrefix: "/",
  };
  runCalled = false;
  lastParams: AgentRunParams | null = null;
  readonly isStreaming = false;

  run(params: AgentRunParams): void {
    this.runCalled = true;
    this.lastParams = params;
  }
  writeStdin(): void {}
  sendUserMessage(): void {}
  interrupt(): void {}
  kill(): void {}
  writeMcpConfig(): { mcpConfigPath?: string; runtimeEnv?: Record<string, string>; cleanup?: () => void } {
    return {};
  }
}

async function waitFor(fn: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
}

/** The session that receives the wake-turn (the docs/196 parent / docs/239 self). */
const WOKEN_ID = "woken-session";
/** The watched session (a child for `kind: "child"`; `WOKEN_ID` itself for self). */
const CHILD_ID = "child-session";
const DELIVERY_ID = "watch-abc:1";

function mergedPrStatus(sessionId: string, prNumber = 7): PrStatusSummary {
  return {
    sessionId,
    prNumber,
    prUrl: `https://github.com/o/r/pull/${prNumber}`,
    prTitle: "Foundation",
    prBody: "",
    prState: "merged",
    baseBranch: "main",
    headBranch: "shipit/child",
    insertions: 1,
    deletions: 0,
    checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
    mergeable: "unknown",
    reviewDecision: "none",
    autoMergeEnabled: false,
  };
}

describe("Integration: durable delivery identity across a restart (planning#266)", () => {
  let worker: SessionWorker;
  let workerUrl: string;
  let lastAgent: FakeWorkerAgent;
  let spawnCount: number;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let usageManager: UsageManager;
  let runners: ContainerSessionRunner[];
  let manager: MergeWatchManager;
  let registry: SessionRunnerRegistry;
  let currentRunner: ContainerSessionRunner | null;

  beforeEach(async () => {
    lastAgent = null as unknown as FakeWorkerAgent;
    spawnCount = 0;
    runners = [];
    currentRunner = null;
    worker = new SessionWorker({
      agentFactory: () => {
        spawnCount++;
        lastAgent = new FakeWorkerAgent();
        return lastAgent;
      },
      port: 0,
      host: "127.0.0.1",
    });
    const address = await worker.start();
    const port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
    workerUrl = `http://127.0.0.1:${port}`;

    dbManager = new DatabaseManager(":memory:");
    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);
    usageManager = new UsageManager(dbManager);
    sessionManager.track(WOKEN_ID, "Woken session", "/tmp/woken-session");
    sessionManager.track(CHILD_ID, "Child API", "/tmp/child-session");

    // A registry over whichever runner the current test has built — the wake
    // path resolves the target session through `get` / `getOrCreate`, so both
    // must hand back the real container runner.
    registry = {
      get: (id: string) =>
        (id === WOKEN_ID ? (currentRunner as unknown as SessionRunnerInterface | null) : null) ?? undefined,
      getOrCreate: () => currentRunner as unknown as SessionRunnerInterface,
      dispose: () => { currentRunner = null; },
    } as unknown as SessionRunnerRegistry;

    manager = new MergeWatchManager({
      sessionManager,
      runnerRegistry: registry,
      chatHistoryManager,
      defaultAgentId: "claude",
    });
  });

  afterEach(async () => {
    manager.stopRetryLoop();
    for (const r of runners) r.dispose({ force: true });
    await worker.stop();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  /** A restarted orchestrator's runner for the woken session, fully wired. */
  function makeRunner(): ContainerSessionRunner {
    const runner = new ContainerSessionRunner({
      sessionId: WOKEN_ID,
      sessionDir: "/tmp/woken-session",
      defaultAgentId: "claude",
      workerUrl,
    });
    const deps: SystemTurnDeps = {
      agentFactory: (agentId) => runner.createAgent(agentId),
      autoCommit: async () => ({
        commitHash: null, parentHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [], unreadable: null,
      }),
      scheduleAutoPush: () => {},
      buildRunParams: async (_sessionId, _agentId, prompt) => ({ prompt, cwd: "/workspace" }),
      // planning#266 — the hook under test. In production this is threaded from
      // `bootstrap-managers.ts`; here it points at the same manager the watch
      // lives on, which is the whole point: the adopted turn must settle the
      // ORIGINAL watch.
      rebindDelivery: (deliveryId) => manager.rebindDelivery(deliveryId),
      listenerDeps: {
        sessionManager,
        chatHistoryManager,
        usageManager,
        sseBroadcast: () => {},
        broadcastLog: () => {},
        getSelectedModel: () => undefined,
      },
    };
    runner.setSystemTurnDeps(deps);
    runners.push(runner);
    currentRunner = runner;
    return runner;
  }

  /**
   * Persist the state the PRE-restart orchestrator left behind: a watch whose
   * merge was observed and whose wake-turn was dispatched (attempt 1, carrying
   * `DELIVERY_ID`) but has not completed.
   */
  function seedDispatchedWatch(kind: "child" | "self"): void {
    const watchedId = kind === "self" ? WOKEN_ID : CHILD_ID;
    sessionManager.setMergeWatch(watchedId, {
      parentSessionId: WOKEN_ID,
      ...(kind === "self" ? { kind: "self" as const, watchId: "watch-abc", prNumber: 7 } : {}),
      state: "merge-observed",
      registeredAt: "t0",
      observedAt: "t1",
      deliveryAttempts: 1,
      lastAttemptAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      deliveryId: DELIVERY_ID,
    });
    sessionManager.setPrStatus(watchedId, mergedPrStatus(watchedId));
    manager.setPrStatusLookup((id) => sessionManager.getPrStatus(id) ?? undefined);
  }

  /**
   * Start the wake-turn on the worker the way the PRE-restart orchestrator
   * would have — carrying the delivery id — and emit its opening events into
   * the ring buffer with nobody listening.
   */
  async function startPreRestartWakeTurn(): Promise<void> {
    const res = await fetch(`${workerUrl}/agent/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "claude",
        runToken: "pre-restart-token",
        deliveryId: DELIVERY_ID,
        params: { prompt: "A child session you registered a merge-watch on…", cwd: "/workspace" },
      }),
    });
    expect(res.status).toBe(200);
    await waitFor(() => lastAgent?.runCalled, 2000, "worker started the wake turn");
    lastAgent.emit("event", {
      type: "agent_init",
      agentId: "claude",
      sessionId: "cli-session-1",
      model: "claude-sonnet-4-6",
      tools: [],
    });
    lastAgent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "MIDTURN_TEXT" }],
    });
    chatHistoryManager.append(WOKEN_ID, { role: "user", text: "wake" });
  }

  /**
   * The bootstrap ordering, verbatim (planning#261): adopt first, THEN reconcile.
   * Reconcile is what used to queue the duplicate, so running them in this order
   * is exactly the scenario under test.
   */
  async function restartSweep(): Promise<boolean> {
    const runner = makeRunner();
    const adopted = await runner.resumeInFlightTurn();
    await manager.reconcilePending();
    return adopted;
  }

  // ---- the worker's own report ----

  it("the worker records the delivery with the turn and reports it, then forgets it when the turn ends", async () => {
    const idle = await (await fetch(`${workerUrl}/agent/status`)).json() as WorkerAgentStatus;
    expect(idle.deliveryId).toBeUndefined();

    await startPreRestartWakeTurn();
    const live = await (await fetch(`${workerUrl}/agent/status`)).json() as WorkerAgentStatus;
    expect(live.turnActive).toBe(true);
    expect(live.deliveryId).toBe(DELIVERY_ID);

    // The delivery belongs to the TURN, not the spawn: once the turn ends it
    // must stop reading as live, or a genuine redispatch would be suppressed
    // forever.
    lastAgent.emit("event", { type: "agent_result", status: "success", sessionId: "cli-session-1" });
    const done = await (await fetch(`${workerUrl}/agent/status`)).json() as WorkerAgentStatus;
    expect(done.turnActive).toBe(false);
    expect(done.deliveryId).toBeUndefined();
  });

  // ---- the bug: a restart mid-wake must not produce a second turn ----

  for (const kind of ["child", "self"] as const) {
    describe(`kind: "${kind}"`, () => {
      it("a restart during a watch-originated turn yields ONE turn, and the watch settles from the adopted turn", async () => {
        const watchedId = kind === "self" ? WOKEN_ID : CHILD_ID;
        seedDispatchedWatch(kind);
        await startPreRestartWakeTurn();
        expect(spawnCount).toBe(1);

        const adopted = await restartSweep();
        expect(adopted).toBe(true);

        // THE regression: reconcile saw a non-terminal watch and used to queue a
        // second wake behind the still-running first one. The delivery is
        // reported by a live worker, so it does not.
        expect(spawnCount).toBe(1);
        expect(runners[0].queueLength).toBe(0);
        expect(sessionManager.getMergeWatch(watchedId)?.state).toBe("merge-observed");

        // …and the ORIGINAL watch settles off the ADOPTED turn — which is the
        // half that did not exist before: the settlement it was dispatched with
        // died with the previous orchestrator process.
        await waitFor(() => runners[0].accumulatedText.includes("MIDTURN_TEXT"), 3000, "replay");
        lastAgent.emit("event", { type: "agent_result", status: "success", sessionId: "cli-session-1" });
        lastAgent.emit("done", 0);
        await waitFor(
          () => sessionManager.getMergeWatch(watchedId)?.state === "delivered",
          3000,
          "watch delivered from the adopted turn",
        );
        // The attempt budget was not burned a second time.
        expect(sessionManager.getMergeWatch(watchedId)?.deliveryAttempts).toBe(1);
      });

      it("a restart where the worker turn genuinely died redispatches exactly once", async () => {
        const watchedId = kind === "self" ? WOKEN_ID : CHILD_ID;
        seedDispatchedWatch(kind);
        // No turn on the worker: the container was recreated, or the CLI exited
        // while the orchestrator was down. Nothing reports the delivery.
        const status = await (await fetch(`${workerUrl}/agent/status`)).json() as WorkerAgentStatus;
        expect(status.turnActive).toBe(false);
        expect(status.deliveryId).toBeUndefined();

        const adopted = await restartSweep();
        expect(adopted).toBe(false);

        // Redispatched — exactly one turn, carrying a FRESH delivery id for the
        // new attempt.
        await waitFor(() => spawnCount === 1, 3000, "redispatched wake turn");
        const watch = sessionManager.getMergeWatch(watchedId);
        expect(watch?.deliveryAttempts).toBe(2);
        expect(watch?.deliveryId).not.toBe(DELIVERY_ID);

        // A second reconcile (a second restart, or the retry supervisor) sees
        // the new delivery live on the runner and stands down.
        await manager.reconcilePending();
        await manager.retryStalledDeliveries();
        expect(spawnCount).toBe(1);
      });
    });
  }

  // ---- the `inFlight` set is no longer load-bearing for liveness ----

  it("liveness comes from the runner, not from any marker the manager set: a fresh manager reaches the same verdict", async () => {
    seedDispatchedWatch("child");
    await startPreRestartWakeTurn();
    await restartSweep();
    expect(spawnCount).toBe(1);

    // A manager instance that has never dispatched anything — i.e. one with an
    // empty in-memory world, exactly like the process after a restart. It still
    // sees the delivery, because the answer lives on the runner (and reached it
    // from the worker's own report).
    const fresh = new MergeWatchManager({
      sessionManager,
      runnerRegistry: registry,
      chatHistoryManager,
      defaultAgentId: "claude",
    });
    fresh.setPrStatusLookup((id) => sessionManager.getPrStatus(id) ?? undefined);
    await fresh.reconcilePending();
    fresh.stopRetryLoop();

    expect(spawnCount).toBe(1);
    expect(sessionManager.getMergeWatch(CHILD_ID)?.deliveryAttempts).toBe(1);
  });

  it("rebindDelivery only matches a live, non-terminal watch", async () => {
    seedDispatchedWatch("child");
    expect(manager.rebindDelivery(DELIVERY_ID)).toBeTypeOf("function");
    // An id nobody owns (a turn from a watch since cancelled or re-armed).
    expect(manager.rebindDelivery("watch-zzz:1")).toBeUndefined();
    // …and one whose watch has since gone terminal.
    const watch = sessionManager.getMergeWatch(CHILD_ID)!;
    sessionManager.setMergeWatch(CHILD_ID, { ...watch, state: "delivered" });
    expect(manager.rebindDelivery(DELIVERY_ID)).toBeUndefined();
    manager.stopRetryLoop();
  });
});
