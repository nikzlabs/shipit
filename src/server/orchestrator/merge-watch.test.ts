import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { ChatHistoryManager } from "./chat-history.js";
import { MergeWatchManager, MAX_DELIVERY_ATTEMPTS } from "./merge-watch.js";
import { isSteerableDispatch } from "./dispatch-steering.js";
import type { SessionRunnerInterface, SessionRunnerRegistry, AgentDispatchOptions } from "./session-runner.js";
import type { PrTerminalStateInfo } from "./pr-status-poller.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import { createTurnSettlement, TURN_COMPLETED, type TurnHandle, type TurnOutcome } from "./turn-settlement.js";

/**
 * Fake runner that records dispatches + emitted WS messages. Deliberately NOT a
 * `ContainerSessionRunner`, so the deliverer skips the worker-ready wait.
 *
 * Models the real runner's turn-completion contract:
 *   • IDLE parent (`running === false`) — `dispatch` starts the turn now, so by
 *     default the fake fires `onTurnComplete` immediately to simulate it running
 *     to completion. Set `autoCompleteTurn = false` to hold the callback so a
 *     test can fire it later via `completeTurn()` (models the dispatch→finish
 *     gap where a restart would strand the watch).
 *   • BUSY parent (`running === true`) — `dispatch` ENQUEUES; the callback is
 *     held (it rides the in-memory queue, docs/196 fix) and fires only when the
 *     current turn finishes and the queue drains, simulated by `completeTurn()`.
 * In both cases a held callback is flushed by `completeTurn()`.
 *
 * The fake models the CONTRACT, not the machinery: it can't reproduce a message
 * being live-steered into a running turn (SHI-254) or a queue drain narrowing the
 * entry it shifts (SHI-255), because both live in the real turn path. Those are
 * covered against a real turn in `integration_tests/system-turn-queue.test.ts` and
 * the busy-parent case of `integration_tests/session-notify-on-merge.test.ts`; the
 * checks here pin the dispatch SHAPE those fixes depend on (`systemTurn` set, a
 * completion callback attached, and therefore unsteerable).
 */
class FakeRunner {
  running = false;
  disposed = false;
  agentId = "claude" as const;
  dispatched: AgentDispatchOptions[] = [];
  emitted: unknown[] = [];
  autoCompleteTurn = true;
  /** Outcome the simulated turn settles with — docs/240: only `completed` delivers. */
  turnOutcome: TurnOutcome = TURN_COMPLETED;
  /** SHI-264 — the delivery of the turn this runner is RUNNING, if any. */
  activeDeliveryId: string | undefined;
  /** SHI-264 — deliveries sitting in the (in-memory) queue behind a busy turn. */
  private readonly queuedDeliveries = new Set<string>();
  private pendingComplete: (() => void)[] = [];
  constructor(public sessionDir: string) {}
  dispatch(opts: AgentDispatchOptions): TurnHandle {
    this.dispatched.push(opts);
    const settlement = createTurnSettlement();
    // Busy parent → enqueued, runs (and completes) only on drain. Idle parent →
    // starts now (unless the test holds it via `autoCompleteTurn = false`).
    const held = this.running || !this.autoCompleteTurn;
    if (opts.deliveryId !== undefined) {
      if (this.running) this.queuedDeliveries.add(opts.deliveryId);
      else this.activeDeliveryId = opts.deliveryId;
    }
    if (!opts.onTurnComplete) return settlement;
    const fire = () => {
      if (opts.deliveryId !== undefined) {
        this.queuedDeliveries.delete(opts.deliveryId);
        if (this.activeDeliveryId === opts.deliveryId) this.activeDeliveryId = undefined;
      }
      opts.onTurnComplete!(this.turnOutcome);
    };
    if (held) { this.pendingComplete.push(fire); return settlement; }
    fire();
    return settlement;
  }
  /** SHI-264 — the ground-truth liveness answer the retry supervisor now asks for. */
  hasDelivery(deliveryId: string): boolean {
    return this.activeDeliveryId === deliveryId || this.queuedDeliveries.has(deliveryId);
  }
  /**
   * An orchestrator restart with nothing surviving in a worker: the in-memory
   * queue, the held completion callbacks, and the running-turn state all die
   * with the process. (A turn that DOES survive inside its container is the
   * adoption case — covered against a real worker in
   * `integration_tests/restart-delivery-identity.test.ts`.)
   */
  simulateRestart(): void {
    this.pendingComplete = [];
    this.queuedDeliveries.clear();
    this.activeDeliveryId = undefined;
    this.running = false;
  }
  /** Simulate held/queued wake-turns draining to completion. */
  completeTurn(): void {
    const pending = this.pendingComplete;
    this.pendingComplete = [];
    for (const fire of pending) fire();
  }
  emitMessage(msg: unknown): void { this.emitted.push(msg); }
}

/**
 * `control.failWake` models the SHI-258 failure: the parent's container can't be
 * resumed. `wakeSessionWithTurn` detects that as a disposed runner and throws,
 * which is exactly what a boot failure / credential-refresh failure surfaces as.
 */
function makeFakeRegistry(): {
  registry: SessionRunnerRegistry;
  runners: Map<string, FakeRunner>;
  control: { failWake: boolean };
} {
  const runners = new Map<string, FakeRunner>();
  const control = { failWake: false };
  const registry = {
    get: (id: string) => runners.get(id) as unknown as SessionRunnerInterface | undefined,
    getOrCreate: (id: string, dir: string) => {
      let r = runners.get(id);
      if (!r) { r = new FakeRunner(dir); runners.set(id, r); }
      r.disposed = control.failWake;
      return r as unknown as SessionRunnerInterface;
    },
    dispose: (id: string) => { runners.delete(id); },
  } as unknown as SessionRunnerRegistry;
  return { registry, runners, control };
}

function makeManager() {
  const db = new DatabaseManager(":memory:");
  const sessionManager = new SessionManager(db);
  const chatHistoryManager = new ChatHistoryManager(db);
  const { registry, runners, control } = makeFakeRegistry();
  const manager = new MergeWatchManager({
    sessionManager,
    runnerRegistry: registry,
    chatHistoryManager,
    defaultAgentId: "claude",
  });
  // Parent + child sessions, linked.
  sessionManager.track("parent", "Parent", "/ws/parent");
  sessionManager.track("child", "Child API", "/ws/child");
  sessionManager.setParentSession("child", "parent");
  return { sessionManager, chatHistoryManager, registry, runners, control, manager };
}

const MERGED: PrTerminalStateInfo = {
  sessionId: "child",
  outcome: "merged",
  prNumber: 7,
  prUrl: "https://github.com/o/r/pull/7",
  prTitle: "Foundation",
  branch: "shipit/child",
  mergeSha: "deadbeefcafe1234",
};
const CLOSED: PrTerminalStateInfo = { ...MERGED, outcome: "closed", mergeSha: undefined };

function arm(sessionManager: SessionManager) {
  sessionManager.setMergeWatch("child", { parentSessionId: "parent", state: "armed", registeredAt: "t0" });
}

describe("MergeWatchManager (docs/196)", () => {
  let ctx: ReturnType<typeof makeManager>;
  beforeEach(() => { ctx = makeManager(); });

  it("merged: surfaces a persisted card + enqueues the wake-turn, marks delivered", async () => {
    arm(ctx.sessionManager);
    await ctx.manager.handleChildPrTerminal(MERGED);

    // State machine reached `delivered`.
    expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("delivered");

    // Persisted merge card on the PARENT's history.
    const history = ctx.chatHistoryManager.load("parent");
    const card = history.find((m) => m.childMerged)?.childMerged;
    expect(card?.outcome).toBe("merged");
    expect(card?.prNumber).toBe(7);
    expect(card?.mergeSha).toBe("deadbeefcafe1234");

    // Wake-turn dispatched into the parent as a system turn.
    const parentRunner = ctx.runners.get("parent");
    expect(parentRunner?.dispatched).toHaveLength(1);
    expect(parentRunner?.dispatched[0].systemTurn).toBe(true);
    expect(parentRunner?.dispatched[0].text).toContain("merged");
    expect(parentRunner?.dispatched[0].text).toContain("child");
    expect(parentRunner?.dispatched[0].text.length).toBeLessThan(240);
  });

  it("is fire-once: a re-poll after delivery is a no-op", async () => {
    arm(ctx.sessionManager);
    await ctx.manager.handleChildPrTerminal(MERGED);
    await ctx.manager.handleChildPrTerminal(MERGED);

    const parentRunner = ctx.runners.get("parent");
    expect(parentRunner?.dispatched).toHaveLength(1);
    expect(ctx.chatHistoryManager.load("parent").filter((m) => m.childMerged)).toHaveLength(1);
  });

  it("closed-unmerged: distinct card + wake-turn, terminal state", async () => {
    arm(ctx.sessionManager);
    await ctx.manager.handleChildPrTerminal(CLOSED);

    expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("closed-unmerged");
    const card = ctx.chatHistoryManager.load("parent").find((m) => m.childMerged)?.childMerged;
    expect(card?.outcome).toBe("closed-unmerged");
    const parentRunner = ctx.runners.get("parent");
    expect(parentRunner?.dispatched[0].text).toContain("closed without merging");
  });

  it("drops the watch silently when the parent was archived", async () => {
    arm(ctx.sessionManager);
    ctx.sessionManager.archive("parent");
    await ctx.manager.handleChildPrTerminal(MERGED);

    expect(ctx.sessionManager.getMergeWatch("child")).toBeUndefined();
    expect(ctx.runners.get("parent")).toBeUndefined();
    expect(ctx.chatHistoryManager.load("parent").filter((m) => m.childMerged)).toHaveLength(0);
  });

  it("no-ops when the child carries no watch", async () => {
    await ctx.manager.handleChildPrTerminal(MERGED);
    expect(ctx.chatHistoryManager.load("parent")).toHaveLength(0);
  });

  it("never preempts a busy parent — still enqueues (dispatch), never disposes", async () => {
    arm(ctx.sessionManager);
    // Pre-create a running parent runner.
    const parentRunner = ctx.registry.getOrCreate("parent", "/ws/parent", "claude") as unknown as FakeRunner;
    parentRunner.running = true;
    await ctx.manager.handleChildPrTerminal(MERGED);

    expect(parentRunner.dispatched).toHaveLength(1);
    expect(parentRunner.disposed).toBe(false);
    expect(ctx.runners.get("parent")).toBe(parentRunner);
  });

  it("reconcilePending fires an armed watch whose child PR already merged", async () => {
    arm(ctx.sessionManager);
    const status: PrStatusSummary = {
      sessionId: "child",
      prNumber: 7,
      prUrl: "https://github.com/o/r/pull/7",
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
    ctx.manager.setPrStatusLookup((id) => (id === "child" ? status : undefined));
    await ctx.manager.reconcilePending();

    expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("delivered");
    expect(ctx.runners.get("parent")?.dispatched).toHaveLength(1);
  });

  it("merged: marks delivered only once the wake-turn has actually run, not when enqueued", async () => {
    arm(ctx.sessionManager);
    // Idle parent, but hold the turn so it's dispatched-but-not-yet-complete.
    const parentRunner = ctx.registry.getOrCreate("parent", "/ws/parent", "claude") as unknown as FakeRunner;
    parentRunner.autoCompleteTurn = false;

    await ctx.manager.handleChildPrTerminal(MERGED);

    // Card surfaced and wake-turn dispatched, but NOT yet delivered — a restart
    // here must be recoverable, so the watch stays at `merge-observed`.
    expect(parentRunner.dispatched).toHaveLength(1);
    expect(parentRunner.dispatched[0].systemTurn).toBe(true);
    expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("merge-observed");
    expect(ctx.chatHistoryManager.load("parent").filter((m) => m.childMerged)).toHaveLength(1);

    // The turn finishes → only NOW does the watch reach `delivered`.
    parentRunner.completeTurn();
    expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("delivered");
  });

  // Helper: a merged-PR snapshot for `setPrStatusLookup`, keyed by child id.
  function mergedStatus(): PrStatusSummary {
    return {
      sessionId: "child",
      prNumber: 7,
      prUrl: "https://github.com/o/r/pull/7",
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

  it("busy parent: wake-turn enqueued, reaches delivered once it drains (no restart needed)", async () => {
    arm(ctx.sessionManager);
    // Mid-turn parent → dispatch enqueues; the completion callback is held by
    // the in-memory queue and fires only when the queue drains (docs/196 fix).
    const parentRunner = ctx.registry.getOrCreate("parent", "/ws/parent", "claude") as unknown as FakeRunner;
    parentRunner.running = true;

    await ctx.manager.handleChildPrTerminal(MERGED);

    // Enqueued + card surfaced, but the queued turn has not run yet, so the
    // watch is recoverable: NOT delivered while it sits in the queue.
    expect(parentRunner.dispatched).toHaveLength(1);
    expect(parentRunner.dispatched[0].systemTurn).toBe(true);
    // SHI-254 — the wake-turn carries both markers that make it unsteerable, so
    // a real runner enqueues it instead of injecting it into the running user
    // turn (which would return before the enqueue and drop the callback below).
    expect(parentRunner.dispatched[0].onTurnComplete).toBeTypeOf("function");
    expect(isSteerableDispatch(parentRunner.dispatched[0])).toBe(false);
    expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("merge-observed");
    expect(ctx.chatHistoryManager.load("parent").filter((m) => m.childMerged)).toHaveLength(1);

    // The parent's current turn finishes and the queued wake-turn drains + runs
    // — IN-PROCESS, no orchestrator restart. Only NOW is the watch `delivered`.
    parentRunner.running = false;
    parentRunner.completeTurn();
    expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("delivered");

    // The reported bug: a later restart re-derives the still-merged PR and must
    // NOT re-fire — the watch is now terminal, so reconcile is a no-op.
    ctx.manager.setPrStatusLookup((id) => (id === "child" ? mergedStatus() : undefined));
    await ctx.manager.reconcilePending();
    expect(parentRunner.dispatched).toHaveLength(1); // no duplicate wake-turn
    expect(ctx.chatHistoryManager.load("parent").filter((m) => m.childMerged)).toHaveLength(1);
  });

  it("regression: a delivered watch is never re-fired across repeated restarts (no duplicate notifications)", async () => {
    arm(ctx.sessionManager);
    await ctx.manager.handleChildPrTerminal(MERGED);
    expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("delivered");

    // Several orchestrator restarts in a row, each re-running the startup
    // reconcile against the persisted (still-merged) PR snapshot.
    ctx.manager.setPrStatusLookup((id) => (id === "child" ? mergedStatus() : undefined));
    await ctx.manager.reconcilePending();
    await ctx.manager.reconcilePending();
    await ctx.manager.reconcilePending();

    // Exactly one wake-turn + one card, ever — `delivered` is fire-once.
    expect(ctx.runners.get("parent")?.dispatched).toHaveLength(1);
    expect(ctx.chatHistoryManager.load("parent").filter((m) => m.childMerged)).toHaveLength(1);
  });

  it("busy parent that never drains before a restart: reconcile re-delivers without a second card", async () => {
    arm(ctx.sessionManager);
    // Mid-turn parent → dispatch enqueues; the parent restarts before the queued
    // turn ever runs, so the in-memory queue (and its held callback) is lost.
    const parentRunner = ctx.registry.getOrCreate("parent", "/ws/parent", "claude") as unknown as FakeRunner;
    parentRunner.running = true;

    await ctx.manager.handleChildPrTerminal(MERGED);
    expect(parentRunner.dispatched).toHaveLength(1);
    expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("merge-observed");

    // Restart: the queued turn was lost with the in-memory queue (it never
    // reached a worker, so nothing survives to adopt), parent idle again.
    parentRunner.simulateRestart();
    ctx.manager.setPrStatusLookup((id) => (id === "child" ? mergedStatus() : undefined));
    await ctx.manager.reconcilePending();

    // Re-delivered to completion now — and NO second card (the
    // `armed → merge-observed` card guard holds across the re-entry).
    expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("delivered");
    expect(parentRunner.dispatched).toHaveLength(2);
    expect(ctx.chatHistoryManager.load("parent").filter((m) => m.childMerged)).toHaveLength(1);
  });

  it("checkAndFireNow fires when the PR already resolved at registration time", async () => {
    arm(ctx.sessionManager);
    const status = { prState: "merged", prNumber: 7, prUrl: "u", prTitle: "t", headBranch: "shipit/child" } as unknown as PrStatusSummary;
    ctx.manager.setPrStatusLookup(() => status);
    await ctx.manager.checkAndFireNow("child");
    expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("delivered");
  });

  // ---- SHI-258: a FAILED delivery is retried without an orchestrator restart ----
  //
  // The pre-fix behavior: `deliverWakeTurn` throws (parent container won't
  // resume), the watch is left at `merge-observed`, and because the poller's
  // terminal callbacks fire only once per terminal transition and
  // `reconcilePending` has a bootstrap-only call site, nothing ever re-enters
  // delivery. The merge card sits in the parent's transcript and the agent never
  // starts, until someone restarts the orchestrator.
  describe("failed-delivery retry (SHI-258)", () => {
    afterEach(() => {
      ctx.manager.stopRetryLoop();
      vi.useRealTimers();
    });

    /** Backdate the watch's attempt anchor so the backoff window has elapsed. */
    function rewindLastAttempt(ms = 60 * 60 * 1000): void {
      const watch = ctx.sessionManager.getMergeWatch("child");
      if (!watch) throw new Error("no watch to rewind");
      ctx.sessionManager.setMergeWatch("child", {
        ...watch,
        lastAttemptAt: new Date(Date.now() - ms).toISOString(),
      });
    }

    it("records the failed attempt and leaves the watch retryable instead of throwing", async () => {
      arm(ctx.sessionManager);
      ctx.control.failWake = true;

      // The poller's hook is fire-and-forget; a handled failure must not surface
      // as a rejection, or the failure bookkeeping would be indistinguishable
      // from an unrelated crash.
      await expect(ctx.manager.handleChildPrTerminal(MERGED)).resolves.toBeUndefined();

      const watch = ctx.sessionManager.getMergeWatch("child");
      expect(watch?.state).toBe("merge-observed");
      expect(watch?.deliveryAttempts).toBe(1);
      expect(watch?.lastAttemptAt).toBeTypeOf("string");
      expect(watch?.lastDeliveryError).toContain("could not be resumed");
      // The card DID surface (the human sees the merge) — that's the reported
      // symptom: notification present, agent never started.
      expect(ctx.chatHistoryManager.load("parent").filter((m) => m.childMerged)).toHaveLength(1);
      expect(ctx.runners.get("parent")?.dispatched).toHaveLength(0);
    });

    it("retries in-process and reaches delivered once an attempt succeeds — no restart", async () => {
      arm(ctx.sessionManager);
      ctx.control.failWake = true;
      await ctx.manager.handleChildPrTerminal(MERGED);
      expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("merge-observed");

      // The parent's container comes back. Same manager instance, no reconcile,
      // no restart — the retry pass alone must recover the watch.
      ctx.control.failWake = false;
      rewindLastAttempt();
      await ctx.manager.retryStalledDeliveries();

      expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("delivered");
      expect(ctx.runners.get("parent")?.dispatched).toHaveLength(1);
      expect(ctx.runners.get("parent")?.dispatched[0].systemTurn).toBe(true);
      // Still exactly one card — the re-entry skips the card guard.
      expect(ctx.chatHistoryManager.load("parent").filter((m) => m.childMerged)).toHaveLength(1);
    });

    it("the retry supervisor's own timer drives the recovery (no external caller)", async () => {
      vi.useFakeTimers();
      arm(ctx.sessionManager);
      ctx.control.failWake = true;
      await ctx.manager.handleChildPrTerminal(MERGED);
      expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("merge-observed");

      ctx.control.failWake = false;
      // First backoff window is 60s; the supervisor ticks every 30s.
      await vi.advanceTimersByTimeAsync(61_000);

      expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("delivered");
      expect(ctx.runners.get("parent")?.dispatched).toHaveLength(1);
    });

    it("honors the backoff: a just-failed delivery is not re-attempted immediately", async () => {
      arm(ctx.sessionManager);
      ctx.control.failWake = true;
      await ctx.manager.handleChildPrTerminal(MERGED);

      ctx.control.failWake = false;
      // No rewind — the attempt is seconds old, well inside the 60s window.
      await ctx.manager.retryStalledDeliveries();

      expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("merge-observed");
      expect(ctx.sessionManager.getMergeWatch("child")?.deliveryAttempts).toBe(1);
      expect(ctx.runners.get("parent")?.dispatched).toHaveLength(0);
    });

    it("REGRESSION: a wake-turn queued behind a busy parent is never re-fired by the retry pass", async () => {
      arm(ctx.sessionManager);
      // Mid-turn parent → the dispatch ENQUEUES. `merge-observed` is the correct
      // state for the whole time it waits, which is exactly why a naive
      // "reconcile on every poll" reintroduced duplicate wake-turns: it would
      // re-fire at precisely the busiest parents.
      const parentRunner = ctx.registry.getOrCreate("parent", "/ws/parent", "claude") as unknown as FakeRunner;
      parentRunner.running = true;

      await ctx.manager.handleChildPrTerminal(MERGED);
      expect(parentRunner.dispatched).toHaveLength(1);
      expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("merge-observed");

      // A parent turn can run for far longer than any backoff window. Pretend it
      // has, and hammer the retry pass.
      for (let i = 0; i < 5; i++) {
        rewindLastAttempt();
        await ctx.manager.retryStalledDeliveries();
      }

      expect(parentRunner.dispatched).toHaveLength(1); // no duplicate wake-turn
      expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("merge-observed");
      expect(ctx.chatHistoryManager.load("parent").filter((m) => m.childMerged)).toHaveLength(1);
      // The budget is untouched too — a queued turn must never burn attempts.
      expect(ctx.sessionManager.getMergeWatch("child")?.deliveryAttempts).toBe(1);

      // The parent's turn finishes and the queued wake-turn drains: still one.
      parentRunner.running = false;
      parentRunner.completeTurn();
      expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("delivered");
      expect(parentRunner.dispatched).toHaveLength(1);
    });

    it("re-delivers a queued wake-turn whose parent runner was disposed under it", async () => {
      arm(ctx.sessionManager);
      const parentRunner = ctx.registry.getOrCreate("parent", "/ws/parent", "claude") as unknown as FakeRunner;
      parentRunner.running = true;
      await ctx.manager.handleChildPrTerminal(MERGED);
      expect(parentRunner.dispatched).toHaveLength(1);

      // The runner (and its in-memory queue, and the completion callback riding
      // it) is gone — the turn will never run, so "in flight" no longer holds.
      ctx.registry.dispose("parent");
      rewindLastAttempt();
      await ctx.manager.retryStalledDeliveries();

      expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("delivered");
      expect(ctx.runners.get("parent")?.dispatched).toHaveLength(1);
      expect(ctx.chatHistoryManager.load("parent").filter((m) => m.childMerged)).toHaveLength(1);
    });

    it("caps attempts: the watch reaches delivery-failed and surfaces a persisted failure card", async () => {
      arm(ctx.sessionManager);
      ctx.control.failWake = true;
      await ctx.manager.handleChildPrTerminal(MERGED);

      // Burn the remaining budget.
      for (let i = 1; i < MAX_DELIVERY_ATTEMPTS; i++) {
        rewindLastAttempt();
        await ctx.manager.retryStalledDeliveries();
      }

      const watch = ctx.sessionManager.getMergeWatch("child");
      expect(watch?.state).toBe("delivery-failed");
      expect(watch?.deliveryAttempts).toBe(MAX_DELIVERY_ATTEMPTS);
      expect(watch?.failedAt).toBeTypeOf("string");

      // The failure is SURFACED, not swallowed: a second, persisted card in the
      // parent's transcript (it rehydrates on reload like the first one).
      const cards = ctx.chatHistoryManager.load("parent")
        .map((m) => m.childMerged)
        .filter((c): c is NonNullable<typeof c> => !!c);
      expect(cards).toHaveLength(2);
      expect(cards[0].deliveryFailure).toBeUndefined();
      expect(cards[1].deliveryFailure?.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
      expect(cards[1].deliveryFailure?.error).toContain("could not be resumed");
      expect(cards[1].prNumber).toBe(7);

      // Terminal ⇒ it drops out of the pending list, so it stops holding the PR
      // polling gate open for a wake that will never happen.
      expect(ctx.sessionManager.listPendingMergeWatches()).toHaveLength(0);
    });

    it("a delivery-failed watch is terminal: no further retries, no resurrection by reconcile", async () => {
      arm(ctx.sessionManager);
      ctx.control.failWake = true;
      await ctx.manager.handleChildPrTerminal(MERGED);
      for (let i = 1; i < MAX_DELIVERY_ATTEMPTS; i++) {
        rewindLastAttempt();
        await ctx.manager.retryStalledDeliveries();
      }
      expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("delivery-failed");

      // Everything recovers — but the watch already told the human it gave up,
      // so re-arming is the user's call, not an automatic resurrection.
      ctx.control.failWake = false;
      await ctx.manager.retryStalledDeliveries();
      ctx.manager.setPrStatusLookup((id) => (id === "child" ? mergedStatus() : undefined));
      await ctx.manager.reconcilePending();
      await ctx.manager.handleChildPrTerminal(MERGED);

      expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("delivery-failed");
      expect(ctx.runners.get("parent")?.dispatched ?? []).toHaveLength(0);
      expect(ctx.chatHistoryManager.load("parent").filter((m) => m.childMerged)).toHaveLength(2);
    });

    it("drops the watch (no retry) when the parent is archived between attempts", async () => {
      arm(ctx.sessionManager);
      ctx.control.failWake = true;
      await ctx.manager.handleChildPrTerminal(MERGED);

      ctx.sessionManager.archive("parent");
      ctx.control.failWake = false;
      rewindLastAttempt();
      await ctx.manager.retryStalledDeliveries();

      expect(ctx.sessionManager.getMergeWatch("child")).toBeUndefined();
    });

    // ---- SHI-264: the delivery identity the retry supervisor now reads ----
    //
    // These pin the manager-side half of "derive liveness rather than track it".
    // The half that only a real worker can prove — that the id survives an
    // orchestrator restart inside the container and comes back on
    // `/agent/status` — is covered in
    // `integration_tests/restart-delivery-identity.test.ts`.

    it("stamps a durable delivery id on every attempt and persists it WITH the attempt", async () => {
      arm(ctx.sessionManager);
      ctx.control.failWake = true;
      await ctx.manager.handleChildPrTerminal(MERGED);

      const first = ctx.sessionManager.getMergeWatch("child");
      expect(first?.deliveryAttempts).toBe(1);
      expect(first?.deliveryId).toBe("child:1");

      // A retry is a NEW delivery: its id must not collide with the previous
      // attempt's, or a stale worker report would suppress it.
      rewindLastAttempt();
      await ctx.manager.retryStalledDeliveries();
      expect(ctx.sessionManager.getMergeWatch("child")?.deliveryId).toBe("child:2");
    });

    it("a wake-turn queued behind a busy parent is recognized by its DELIVERY, with no in-memory marker to trust", async () => {
      arm(ctx.sessionManager);
      const parentRunner = ctx.registry.getOrCreate("parent", "/ws/parent", "claude") as unknown as FakeRunner;
      parentRunner.running = true;
      await ctx.manager.handleChildPrTerminal(MERGED);

      const deliveryId = ctx.sessionManager.getMergeWatch("child")?.deliveryId;
      expect(deliveryId).toBeTypeOf("string");
      expect(parentRunner.dispatched[0].deliveryId).toBe(deliveryId);
      expect(parentRunner.hasDelivery(deliveryId!)).toBe(true);

      // A manager that never dispatched anything — the shape of the process
      // AFTER a restart — reaches the same "still in flight" verdict, because
      // the answer lives on the runner rather than in this manager's memory.
      const fresh = new MergeWatchManager({
        sessionManager: ctx.sessionManager,
        runnerRegistry: ctx.registry,
        chatHistoryManager: ctx.chatHistoryManager,
        defaultAgentId: "claude",
      });
      fresh.setPrStatusLookup((id) => (id === "child" ? mergedStatus() : undefined));
      rewindLastAttempt();
      await fresh.retryStalledDeliveries();
      await fresh.reconcilePending();
      fresh.stopRetryLoop();

      expect(parentRunner.dispatched).toHaveLength(1);
      expect(ctx.sessionManager.getMergeWatch("child")?.deliveryAttempts).toBe(1);
    });

    it("rebindDelivery hands back the settlement for a live delivery, and nothing for a stale one", async () => {
      arm(ctx.sessionManager);
      const parentRunner = ctx.registry.getOrCreate("parent", "/ws/parent", "claude") as unknown as FakeRunner;
      parentRunner.autoCompleteTurn = false;
      await ctx.manager.handleChildPrTerminal(MERGED);
      const deliveryId = ctx.sessionManager.getMergeWatch("child")!.deliveryId!;

      expect(ctx.manager.rebindDelivery("child:99")).toBeUndefined();

      // The rebound callback is the same settlement the dispatch attached, so an
      // ADOPTED turn's clean completion advances the ORIGINAL watch.
      const settle = ctx.manager.rebindDelivery(deliveryId);
      expect(settle).toBeTypeOf("function");
      settle!(TURN_COMPLETED);
      expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("delivered");

      // Terminal now — a late second rebind finds nothing to settle.
      expect(ctx.manager.rebindDelivery(deliveryId)).toBeUndefined();
    });

    it("closed-unmerged: a failed wake-turn surfaces a failure card (terminal, not retried)", async () => {
      arm(ctx.sessionManager);
      ctx.control.failWake = true;
      await ctx.manager.handleChildPrTerminal(CLOSED);

      expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("closed-unmerged");
      const cards = ctx.chatHistoryManager.load("parent")
        .map((m) => m.childMerged)
        .filter((c): c is NonNullable<typeof c> => !!c);
      expect(cards).toHaveLength(2);
      expect(cards[1].outcome).toBe("closed-unmerged");
      expect(cards[1].deliveryFailure?.attempts).toBe(1);
    });
  });
});
