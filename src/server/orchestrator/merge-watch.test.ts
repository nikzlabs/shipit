import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { ChatHistoryManager } from "./chat-history.js";
import { MergeWatchManager, MAX_DELIVERY_ATTEMPTS } from "./merge-watch.js";
import { registerMergeWatch } from "./services/child-sessions.js";
import { isSteerableDispatch } from "./dispatch-steering.js";
import type { SessionRunnerInterface, SessionRunnerRegistry, AgentDispatchOptions } from "./session-runner.js";
import type { PrTerminalStateInfo } from "./pr-status-poller.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import { createTurnSettlement, TURN_COMPLETED, type TurnHandle, type TurnOutcome } from "./turn-settlement.js";

// Real queue and steering behavior is covered in integration_tests/system-turn-queue.test.ts.
class FakeRunner {
  running = false;
  disposed = false;
  agentId = "claude" as const;
  dispatched: AgentDispatchOptions[] = [];
  emitted: unknown[] = [];
  autoCompleteTurn = true;
  turnOutcome: TurnOutcome = TURN_COMPLETED;
  activeDeliveryId: string | undefined;
  private readonly queuedDeliveries = new Set<string>();
  private pendingComplete: (() => void)[] = [];
  constructor(public sessionDir: string) {}
  dispatch(opts: AgentDispatchOptions): TurnHandle {
    this.dispatched.push(opts);
    const settlement = createTurnSettlement();
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
  hasDelivery(deliveryId: string): boolean {
    return this.activeDeliveryId === deliveryId || this.queuedDeliveries.has(deliveryId);
  }
  simulateRestart(): void {
    this.pendingComplete = [];
    this.queuedDeliveries.clear();
    this.activeDeliveryId = undefined;
    this.running = false;
  }
  completeTurn(): void {
    const pending = this.pendingComplete;
    this.pendingComplete = [];
    for (const fire of pending) fire();
  }
  emitMessage(msg: unknown): void { this.emitted.push(msg); }
}

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

    expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("delivered");

    const history = ctx.chatHistoryManager.load("parent");
    const card = history.find((m) => m.childMerged)?.childMerged;
    expect(card?.outcome).toBe("merged");
    expect(card?.prNumber).toBe(7);
    expect(card?.mergeSha).toBe("deadbeefcafe1234");

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
    const parentRunner = ctx.registry.getOrCreate("parent", "/ws/parent", "claude") as unknown as FakeRunner;
    parentRunner.autoCompleteTurn = false;

    await ctx.manager.handleChildPrTerminal(MERGED);

    expect(parentRunner.dispatched).toHaveLength(1);
    expect(parentRunner.dispatched[0].systemTurn).toBe(true);
    expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("merge-observed");
    expect(ctx.chatHistoryManager.load("parent").filter((m) => m.childMerged)).toHaveLength(1);

    parentRunner.completeTurn();
    expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("delivered");
  });

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
    const parentRunner = ctx.registry.getOrCreate("parent", "/ws/parent", "claude") as unknown as FakeRunner;
    parentRunner.running = true;

    await ctx.manager.handleChildPrTerminal(MERGED);

    expect(parentRunner.dispatched).toHaveLength(1);
    expect(parentRunner.dispatched[0].systemTurn).toBe(true);
    expect(parentRunner.dispatched[0].onTurnComplete).toBeTypeOf("function");
    expect(isSteerableDispatch(parentRunner.dispatched[0])).toBe(false);
    expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("merge-observed");
    expect(ctx.chatHistoryManager.load("parent").filter((m) => m.childMerged)).toHaveLength(1);

    parentRunner.running = false;
    parentRunner.completeTurn();
    expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("delivered");

    ctx.manager.setPrStatusLookup((id) => (id === "child" ? mergedStatus() : undefined));
    await ctx.manager.reconcilePending();
    expect(parentRunner.dispatched).toHaveLength(1);
    expect(ctx.chatHistoryManager.load("parent").filter((m) => m.childMerged)).toHaveLength(1);
  });

  it("regression: a delivered watch is never re-fired across repeated restarts (no duplicate notifications)", async () => {
    arm(ctx.sessionManager);
    await ctx.manager.handleChildPrTerminal(MERGED);
    expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("delivered");

    ctx.manager.setPrStatusLookup((id) => (id === "child" ? mergedStatus() : undefined));
    await ctx.manager.reconcilePending();
    await ctx.manager.reconcilePending();
    await ctx.manager.reconcilePending();

    expect(ctx.runners.get("parent")?.dispatched).toHaveLength(1);
    expect(ctx.chatHistoryManager.load("parent").filter((m) => m.childMerged)).toHaveLength(1);
  });

  it("busy parent that never drains before a restart: reconcile re-delivers without a second card", async () => {
    arm(ctx.sessionManager);
    const parentRunner = ctx.registry.getOrCreate("parent", "/ws/parent", "claude") as unknown as FakeRunner;
    parentRunner.running = true;

    await ctx.manager.handleChildPrTerminal(MERGED);
    expect(parentRunner.dispatched).toHaveLength(1);
    expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("merge-observed");

    parentRunner.simulateRestart();
    ctx.manager.setPrStatusLookup((id) => (id === "child" ? mergedStatus() : undefined));
    await ctx.manager.reconcilePending();

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

  describe("failed-delivery retry (planning#260)", () => {
    afterEach(() => {
      ctx.manager.stopRetryLoop();
      vi.useRealTimers();
    });

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

      await expect(ctx.manager.handleChildPrTerminal(MERGED)).resolves.toBeUndefined();

      const watch = ctx.sessionManager.getMergeWatch("child");
      expect(watch?.state).toBe("merge-observed");
      expect(watch?.deliveryAttempts).toBe(1);
      expect(watch?.lastAttemptAt).toBeTypeOf("string");
      expect(watch?.lastDeliveryError).toContain("could not be resumed");
      expect(ctx.chatHistoryManager.load("parent").filter((m) => m.childMerged)).toHaveLength(1);
      expect(ctx.runners.get("parent")?.dispatched).toHaveLength(0);
    });

    it("retries in-process and reaches delivered once an attempt succeeds — no restart", async () => {
      arm(ctx.sessionManager);
      ctx.control.failWake = true;
      await ctx.manager.handleChildPrTerminal(MERGED);
      expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("merge-observed");

      ctx.control.failWake = false;
      rewindLastAttempt();
      await ctx.manager.retryStalledDeliveries();

      expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("delivered");
      expect(ctx.runners.get("parent")?.dispatched).toHaveLength(1);
      expect(ctx.runners.get("parent")?.dispatched[0].systemTurn).toBe(true);
      expect(ctx.chatHistoryManager.load("parent").filter((m) => m.childMerged)).toHaveLength(1);
    });

    it("the retry supervisor's own timer drives the recovery (no external caller)", async () => {
      vi.useFakeTimers();
      arm(ctx.sessionManager);
      ctx.control.failWake = true;
      await ctx.manager.handleChildPrTerminal(MERGED);
      expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("merge-observed");

      ctx.control.failWake = false;
      await vi.advanceTimersByTimeAsync(61_000);

      expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("delivered");
      expect(ctx.runners.get("parent")?.dispatched).toHaveLength(1);
    });

    it("honors the backoff: a just-failed delivery is not re-attempted immediately", async () => {
      arm(ctx.sessionManager);
      ctx.control.failWake = true;
      await ctx.manager.handleChildPrTerminal(MERGED);

      ctx.control.failWake = false;
      await ctx.manager.retryStalledDeliveries();

      expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("merge-observed");
      expect(ctx.sessionManager.getMergeWatch("child")?.deliveryAttempts).toBe(1);
      expect(ctx.runners.get("parent")?.dispatched).toHaveLength(0);
    });

    it("REGRESSION: a wake-turn queued behind a busy parent is never re-fired by the retry pass", async () => {
      arm(ctx.sessionManager);
      const parentRunner = ctx.registry.getOrCreate("parent", "/ws/parent", "claude") as unknown as FakeRunner;
      parentRunner.running = true;

      await ctx.manager.handleChildPrTerminal(MERGED);
      expect(parentRunner.dispatched).toHaveLength(1);
      expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("merge-observed");

      for (let i = 0; i < 5; i++) {
        rewindLastAttempt();
        await ctx.manager.retryStalledDeliveries();
      }

      expect(parentRunner.dispatched).toHaveLength(1);
      expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("merge-observed");
      expect(ctx.chatHistoryManager.load("parent").filter((m) => m.childMerged)).toHaveLength(1);
      expect(ctx.sessionManager.getMergeWatch("child")?.deliveryAttempts).toBe(1);

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

      for (let i = 1; i < MAX_DELIVERY_ATTEMPTS; i++) {
        rewindLastAttempt();
        await ctx.manager.retryStalledDeliveries();
      }

      const watch = ctx.sessionManager.getMergeWatch("child");
      expect(watch?.state).toBe("delivery-failed");
      expect(watch?.deliveryAttempts).toBe(MAX_DELIVERY_ATTEMPTS);
      expect(watch?.failedAt).toBeTypeOf("string");

      const cards = ctx.chatHistoryManager.load("parent")
        .map((m) => m.childMerged)
        .filter((c): c is NonNullable<typeof c> => !!c);
      expect(cards).toHaveLength(2);
      expect(cards[0].deliveryFailure).toBeUndefined();
      expect(cards[1].deliveryFailure?.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
      expect(cards[1].deliveryFailure?.error).toContain("could not be resumed");
      expect(cards[1].prNumber).toBe(7);

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

    it("stamps a durable delivery id on every attempt and persists it WITH the attempt", async () => {
      arm(ctx.sessionManager);
      ctx.control.failWake = true;
      await ctx.manager.handleChildPrTerminal(MERGED);

      const first = ctx.sessionManager.getMergeWatch("child");
      expect(first?.deliveryAttempts).toBe(1);
      expect(first?.deliveryId).toBe("child:1");

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

      const settle = ctx.manager.rebindDelivery(deliveryId);
      expect(settle).toBeTypeOf("function");
      settle!(TURN_COMPLETED);
      expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("delivered");

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

describe("a session watched by its parent AND by itself (docs/196 + docs/239)", () => {
  let ctx: ReturnType<typeof makeManager>;
  beforeEach(() => {
    ctx = makeManager();
    arm(ctx.sessionManager);
    armSelf(ctx.sessionManager);
    ctx.sessionManager.setPrStatus("child", MERGED_STATUS);
    ctx.manager.setPrStatusLookup((id) => ctx.sessionManager.getPrStatus(id) ?? undefined);
  });
  afterEach(() => { ctx.manager.stopRetryLoop(); });

  const SELF_ID = "self-watch-1";
  const MERGED_STATUS = {
    sessionId: "child", prNumber: 7, prUrl: MERGED.prUrl, prTitle: "Foundation", prBody: "",
    prState: "merged", baseBranch: "main", headBranch: "shipit/child", insertions: 1, deletions: 0,
    checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
    mergeable: "unknown", reviewDecision: "none", autoMergeEnabled: false,
  } as PrStatusSummary;

  function armSelf(sessionManager: SessionManager) {
    sessionManager.setSelfMergeWatch("child", {
      parentSessionId: "child", kind: "self", watchId: SELF_ID, prNumber: 7, state: "armed", registeredAt: "t0",
    });
  }

  function heldRunner(id: string): FakeRunner {
    ctx.registry.getOrCreate(id, `/ws/${id}`, "claude");
    const runner = ctx.runners.get(id)!;
    runner.autoCompleteTurn = false;
    return runner;
  }

  const parentState = () => ctx.sessionManager.getMergeWatch("child")?.state;
  const selfState = () => ctx.sessionManager.getSelfMergeWatch("child")?.state;

  it("one merge wakes the parent from the terminal hook and the child from the merge callback", async () => {
    await ctx.manager.handleChildPrTerminal(MERGED);
    expect(ctx.runners.get("parent")?.dispatched).toHaveLength(1);
    expect(ctx.runners.get("child")).toBeUndefined();
    expect(parentState()).toBe("delivered");
    expect(selfState()).toBe("armed");

    await ctx.manager.handleSelfMerge("child");
    expect(ctx.runners.get("child")?.dispatched).toHaveLength(1);
    expect(ctx.runners.get("child")?.dispatched[0].text).toContain("shipit branch reset-to-base");
    expect(ctx.runners.get("parent")?.dispatched).toHaveLength(1);
    expect(selfState()).toBe("delivered");
    expect(parentState()).toBe("delivered");
    expect(ctx.chatHistoryManager.load("parent").filter((m) => m.childMerged)).toHaveLength(1);
  });

  it("delivers both when the two paths run at the same time, as the poller starts them", async () => {
    await Promise.all([ctx.manager.handleChildPrTerminal(MERGED), ctx.manager.handleSelfMerge("child")]);

    expect(ctx.runners.get("parent")?.dispatched).toHaveLength(1);
    expect(ctx.runners.get("child")?.dispatched).toHaveLength(1);
    expect(parentState()).toBe("delivered");
    expect(selfState()).toBe("delivered");
  });

  it("each wake turn settles only its own watch", async () => {
    const parentRunner = heldRunner("parent");
    const childRunner = heldRunner("child");
    await ctx.manager.handleChildPrTerminal(MERGED);
    await ctx.manager.handleSelfMerge("child");
    expect(parentState()).toBe("merge-observed");
    expect(selfState()).toBe("merge-observed");
    expect(ctx.sessionManager.getMergeWatch("child")?.deliveryId).toBe("child:1");
    expect(ctx.sessionManager.getSelfMergeWatch("child")?.deliveryId).toBe(`${SELF_ID}:1`);

    childRunner.completeTurn();
    expect(selfState()).toBe("delivered");
    expect(parentState()).toBe("merge-observed");

    parentRunner.completeTurn();
    expect(parentState()).toBe("delivered");
  });

  it("both watches hold the polling gate, and each one releases only itself", async () => {
    const pendingKinds = () =>
      ctx.sessionManager.listPendingMergeWatches().map((e) => e.watch.kind ?? "parent").sort();
    expect(pendingKinds()).toEqual(["parent", "self"]);

    await ctx.manager.handleChildPrTerminal(MERGED);
    expect(pendingKinds()).toEqual(["self"]);

    await ctx.manager.handleSelfMerge("child");
    expect(pendingKinds()).toEqual([]);
  });

  it("rebindDelivery finds each watch by its own delivery id after a restart", async () => {
    heldRunner("parent");
    heldRunner("child");
    await ctx.manager.handleChildPrTerminal(MERGED);
    await ctx.manager.handleSelfMerge("child");
    ctx.runners.get("parent")!.simulateRestart();
    ctx.runners.get("child")!.simulateRestart();

    ctx.manager.rebindDelivery(`${SELF_ID}:1`)!(TURN_COMPLETED);
    expect(selfState()).toBe("delivered");
    expect(parentState()).toBe("merge-observed");

    ctx.manager.rebindDelivery("child:1")!(TURN_COMPLETED);
    expect(parentState()).toBe("delivered");
  });

  it("the retry supervisor recovers both failed deliveries, with one attempt count per watch", async () => {
    ctx.control.failWake = true;
    await ctx.manager.handleChildPrTerminal(MERGED);
    await ctx.manager.handleSelfMerge("child");
    expect(ctx.sessionManager.getMergeWatch("child")).toMatchObject({ state: "merge-observed", deliveryAttempts: 1 });
    expect(ctx.sessionManager.getSelfMergeWatch("child")).toMatchObject({ state: "merge-observed", deliveryAttempts: 1 });

    ctx.control.failWake = false;
    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    ctx.sessionManager.setMergeWatch("child", { ...ctx.sessionManager.getMergeWatch("child")!, lastAttemptAt: longAgo });
    ctx.sessionManager.setSelfMergeWatch("child", { ...ctx.sessionManager.getSelfMergeWatch("child")!, lastAttemptAt: longAgo });
    await ctx.manager.retryStalledDeliveries();

    expect(ctx.sessionManager.getMergeWatch("child")).toMatchObject({ state: "delivered", deliveryAttempts: 2 });
    expect(ctx.sessionManager.getSelfMergeWatch("child")).toMatchObject({ state: "delivered", deliveryAttempts: 2 });
    expect(ctx.runners.get("child")?.dispatched[0].text).toContain("shipit branch reset-to-base");
    expect(ctx.runners.get("parent")?.dispatched[0].text).toContain("Child PR #7 merged");
  });

  it("a wake queued behind a busy parent does not hold back the child's own retry", async () => {
    const parentRunner = heldRunner("parent");
    parentRunner.running = true;
    await ctx.manager.handleChildPrTerminal(MERGED);
    ctx.control.failWake = true;
    await ctx.manager.handleSelfMerge("child");
    ctx.control.failWake = false;
    parentRunner.disposed = false;

    ctx.sessionManager.setSelfMergeWatch("child", {
      ...ctx.sessionManager.getSelfMergeWatch("child")!,
      lastAttemptAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    await ctx.manager.retryStalledDeliveries();

    expect(selfState()).toBe("delivered");
    expect(parentState()).toBe("merge-observed");
    expect(parentRunner.dispatched).toHaveLength(1);
  });

  it("reconcilePending delivers both after a restart", async () => {
    await ctx.manager.reconcilePending();
    expect(ctx.runners.get("parent")?.dispatched).toHaveLength(1);
    expect(ctx.runners.get("child")?.dispatched).toHaveLength(1);
    expect(parentState()).toBe("delivered");
    expect(selfState()).toBe("delivered");
  });

  // A restart keeps nothing in memory, and the child's own wake turn resets its branch, which
  // clears the PR snapshot. The watch's own record of the merge is then the only one left.
  function restartWithoutSnapshot(): MergeWatchManager {
    ctx.manager.stopRetryLoop();
    const fresh = new MergeWatchManager({
      sessionManager: ctx.sessionManager,
      runnerRegistry: ctx.registry,
      chatHistoryManager: ctx.chatHistoryManager,
      defaultAgentId: "claude",
    });
    fresh.setPrStatusLookup(() => undefined);
    return fresh;
  }

  it("a parent wake that failed is re-delivered after a restart, though the child's wake cleared the PR snapshot", async () => {
    ctx.control.failWake = true;
    await ctx.manager.handleChildPrTerminal(MERGED);
    expect(parentState()).toBe("merge-observed");
    ctx.control.failWake = false;

    const fresh = restartWithoutSnapshot();
    await fresh.reconcilePending();
    fresh.stopRetryLoop();

    expect(parentState()).toBe("delivered");
    const wake = ctx.runners.get("parent")!.dispatched.at(-1)!;
    expect(wake.text).toContain("Child PR #7 merged");
    expect(ctx.chatHistoryManager.load("parent").filter((m) => m.childMerged)).toHaveLength(1);
  });

  it("the retry supervisor also re-delivers it after such a restart", async () => {
    ctx.control.failWake = true;
    await ctx.manager.handleChildPrTerminal(MERGED);
    ctx.control.failWake = false;
    ctx.sessionManager.setMergeWatch("child", {
      ...ctx.sessionManager.getMergeWatch("child")!,
      lastAttemptAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });

    const fresh = restartWithoutSnapshot();
    await fresh.retryStalledDeliveries();
    fresh.stopRetryLoop();

    expect(ctx.sessionManager.getMergeWatch("child")).toMatchObject({ state: "delivered", deliveryAttempts: 2 });
  });

  it("a self wake whose merge callback never ran is delivered after a restart without the PR snapshot", async () => {
    await ctx.manager.handleChildPrTerminal(MERGED);
    expect(selfState()).toBe("armed");

    const fresh = restartWithoutSnapshot();
    await fresh.reconcilePending();
    fresh.stopRetryLoop();

    expect(selfState()).toBe("delivered");
    expect(ctx.runners.get("child")?.dispatched[0].text).toContain("#7");
  });

  it("the parent's register-time check leaves the self-watch to the merge callback", async () => {
    await ctx.manager.checkAndFireNow("child");
    expect(ctx.runners.get("parent")?.dispatched).toHaveLength(1);
    expect(ctx.runners.get("child")).toBeUndefined();
    expect(selfState()).toBe("armed");
  });

  it("closed without merging: the parent is woken, and the child gets its note and loses its watch", async () => {
    await ctx.manager.handleChildPrTerminal(CLOSED);

    expect(parentState()).toBe("closed-unmerged");
    expect(ctx.runners.get("parent")?.dispatched[0].text).toContain("closed without merging");
    expect(ctx.sessionManager.getSelfMergeWatch("child")).toBeUndefined();
    expect(ctx.runners.get("child")).toBeUndefined();
    expect(ctx.chatHistoryManager.load("child").find((m) => m.notice)?.text).toContain("closed without merging");
  });

  it("an archived parent drops only its own watch; the child is still woken", async () => {
    ctx.sessionManager.archive("parent");
    await ctx.manager.handleChildPrTerminal(MERGED);
    await ctx.manager.handleSelfMerge("child");

    expect(ctx.sessionManager.getMergeWatch("child")).toBeUndefined();
    expect(ctx.runners.get("parent")).toBeUndefined();
    expect(ctx.runners.get("child")?.dispatched).toHaveLength(1);
    expect(selfState()).toBe("delivered");
  });
});

describe("a parent that follows a child across several PRs (docs/196-session-notify-on-merge)", () => {
  let ctx: ReturnType<typeof makeManager>;
  let snapshot: PrStatusSummary | undefined;
  beforeEach(() => {
    ctx = makeManager();
    snapshot = undefined;
    ctx.manager.setPrStatusLookup((id) => (id === "child" ? snapshot : undefined));
  });
  afterEach(() => { ctx.manager.stopRetryLoop(); });

  const pr = (prNumber: number, outcome: "merged" | "closed" = "merged"): PrTerminalStateInfo => ({
    sessionId: "child",
    outcome,
    prNumber,
    prUrl: `https://github.com/o/r/pull/${prNumber}`,
    prTitle: `Step ${prNumber}`,
    branch: "shipit/child",
  });
  const status = (prNumber: number, prState: "merged" | "closed" | "open" = "merged") => ({
    sessionId: "child", prNumber, prUrl: `https://github.com/o/r/pull/${prNumber}`, prTitle: `Step ${prNumber}`,
    prState, headBranch: "shipit/child", baseBranch: "main",
  }) as unknown as PrStatusSummary;

  // The arm as the route makes it: the service call, then the register-time check.
  async function armAsParent() {
    const result = registerMergeWatch(ctx.sessionManager, "parent", "child");
    await ctx.manager.checkAndFireNow("child");
    return result;
  }
  function heldParent(): FakeRunner {
    ctx.registry.getOrCreate("parent", "/ws/parent", "claude");
    const runner = ctx.runners.get("parent")!;
    runner.autoCompleteTurn = false;
    return runner;
  }
  const watch = () => ctx.sessionManager.getMergeWatch("child");
  const wakes = () => ctx.runners.get("parent")?.dispatched ?? [];
  const cards = () => ctx.chatHistoryManager.load("parent").flatMap((m) => (m.childMerged ? [m.childMerged] : []));
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it("req 3: an arm made inside the wake turn applies to the child's next PR", async () => {
    await armAsParent();
    const firstId = watch()?.watchId;
    const parent = heldParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    expect(watch()?.state).toBe("merge-observed");

    const result = await armAsParent();
    expect(result).toMatchObject({ state: "merge-observed", alreadyArmed: false, skipsPr: 7 });
    // The wake in delivery keeps its watch, and is not sent a second time.
    expect(watch()).toMatchObject({ state: "merge-observed", watchId: firstId });
    expect(wakes()).toHaveLength(1);

    parent.completeTurn();
    await flush();
    expect(watch()).toMatchObject({ state: "armed", reportedPr: { prNumber: 7, outcome: "merged" } });
    expect(watch()?.watchId).not.toBe(firstId);
    expect(wakes()).toHaveLength(1);

    await ctx.manager.handleChildPrTerminal(pr(8));
    expect(wakes()).toHaveLength(2);
    expect(wakes()[1].text).toContain("Child PR #8 merged");
    parent.completeTurn();
    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 8, outcome: "merged" } });
    expect(cards().map((c) => c.prNumber)).toEqual([7, 8]);
  });

  it("req 3: a second arm during the same delivery changes nothing and says so", async () => {
    await armAsParent();
    heldParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    await armAsParent();
    const queuedAt = watch()?.rearmedAt;

    const again = await armAsParent();
    expect(again).toMatchObject({ state: "merge-observed", alreadyArmed: true, skipsPr: 7 });
    expect(watch()?.rearmedAt).toBe(queuedAt);
    expect(wakes()).toHaveLength(1);
  });

  it("req 3: the old wake's settlement cannot mark the watch that follows it as delivered", async () => {
    await armAsParent();
    const parent = heldParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    await armAsParent();
    const settle = parent.dispatched[0].onTurnComplete!;

    settle(TURN_COMPLETED);
    await flush();
    expect(watch()?.state).toBe("armed");
    settle(TURN_COMPLETED);
    expect(watch()?.state).toBe("armed");
  });

  it("req 3: a PR that resolves while the previous wake is in delivery is reported by the queued arm", async () => {
    await armAsParent();
    const parent = heldParent();
    await ctx.manager.handleChildPrTerminal(pr(7));

    await ctx.manager.handleChildPrTerminal(pr(8));
    expect(watch()).toMatchObject({ state: "merge-observed", mergedPr: { prNumber: 7 } });
    expect(wakes()).toHaveLength(1);
    expect(cards()).toHaveLength(1);

    // The watch keeps PR #8 itself: the child's own wake clears the PR snapshot at once.
    expect(watch()?.unreportedPrs).toMatchObject([{ prNumber: 8, outcome: "merged" }]);
    await armAsParent();
    parent.completeTurn();
    await flush();

    expect(wakes()).toHaveLength(2);
    expect(wakes()[1].text).toContain("Child PR #8 merged");
    expect(watch()?.unreportedPrs).toBeUndefined();
    expect(cards().map((c) => c.prNumber)).toEqual([7, 8]);
  });

  it("req 2: two later PRs inside one delivery are both reported, in order", async () => {
    await armAsParent();
    const parent = heldParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    await armAsParent();

    // The child merges #8, continues, and closes #9, all before the parent's wake for #7 ends.
    // The watch keeps both: the child's stored PR state shows only the newest by then.
    await ctx.manager.handleChildPrTerminal(pr(8));
    await ctx.manager.handleChildPrTerminal(pr(9, "closed"));
    await ctx.manager.handleChildPrTerminal(pr(9, "closed"));
    expect(watch()?.unreportedPrs?.map((p) => [p.prNumber, p.outcome])).toEqual([[8, "merged"], [9, "closed"]]);

    parent.completeTurn();
    await flush();
    expect(wakes().map((w) => /Child PR #(\d+)/.exec(w.text)?.[1])).toEqual(["7", "8"]);

    await armAsParent();
    parent.completeTurn();
    await flush();
    expect(wakes().map((w) => /Child PR #(\d+)/.exec(w.text)?.[1])).toEqual(["7", "8", "9"]);
    expect(cards().map((c) => c.prNumber)).toEqual([7, 8, 9]);
  });

  it("req 2: a live event does not overtake the PR that the watch kept", async () => {
    await armAsParent();
    const parent = heldParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    await armAsParent();
    await ctx.manager.handleChildPrTerminal(pr(8));

    // The watch that follows is armed, and its own check has not run yet, when #9 arrives.
    parent.completeTurn();
    await ctx.manager.handleChildPrTerminal(pr(9));
    await flush();
    expect(wakes().map((w) => /Child PR #(\d+)/.exec(w.text)?.[1])).toEqual(["7", "8"]);
    expect(watch()).toMatchObject({ state: "merge-observed", mergedPr: { prNumber: 8 }, unreportedPrs: [{ prNumber: 9 }] });

    await armAsParent();
    parent.completeTurn();
    await flush();
    parent.completeTurn();
    expect(wakes().map((w) => /Child PR #(\d+)/.exec(w.text)?.[1])).toEqual(["7", "8", "9"]);
    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 9 } });
    expect(watch()?.unreportedPrs).toBeUndefined();
  });

  it("req 2: a PR that resolves after the watch fired is kept for an arm in a later turn", async () => {
    await armAsParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    await ctx.manager.handleChildPrTerminal(pr(8));
    expect(watch()).toMatchObject({ state: "delivered", unreportedPrs: [{ prNumber: 8 }] });
    expect(wakes()).toHaveLength(1);

    // No snapshot and no previous-merge record: the watch's own copy is the only one.
    await armAsParent();
    expect(wakes()).toHaveLength(2);
    expect(wakes()[1].text).toContain("Child PR #8 merged");
  });

  it("req 4: a terminal event that the poller repeats for a reported PR is not delivered again", async () => {
    await armAsParent();
    const parent = heldParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    await armAsParent();
    parent.completeTurn();
    await flush();
    expect(watch()?.state).toBe("armed");

    // Merge-claim recovery promotes a merged PR again, with `force`.
    await ctx.manager.handleChildPrTerminal(pr(7));
    expect(watch()?.state).toBe("armed");
    expect(wakes()).toHaveLength(1);

    // On a watch that fired, the repeat is not kept for the next arm either.
    await ctx.manager.handleChildPrTerminal(pr(8));
    parent.completeTurn();
    await ctx.manager.handleChildPrTerminal(pr(8));
    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 8 } });
    expect(watch()?.unreportedPrs).toBeUndefined();
  });

  it("req 3: an arm queued during a delivery survives an orchestrator restart", async () => {
    await armAsParent();
    const parent = heldParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    await armAsParent();
    const deliveryId = watch()!.deliveryId!;

    const restarted = () => {
      ctx.manager.stopRetryLoop();
      const fresh = new MergeWatchManager({
        sessionManager: ctx.sessionManager,
        runnerRegistry: ctx.registry,
        chatHistoryManager: ctx.chatHistoryManager,
        defaultAgentId: "claude",
      });
      fresh.setPrStatusLookup(() => undefined);
      return fresh;
    };

    // The wake turn outlived the restart: adoption binds its settlement again.
    const adopted = restarted();
    adopted.rebindDelivery(deliveryId)!(TURN_COMPLETED);
    await flush();
    adopted.stopRetryLoop();
    expect(watch()).toMatchObject({ state: "armed", reportedPr: { prNumber: 7, outcome: "merged" } });
    expect(wakes()).toHaveLength(1);

    // The queued turn was lost in a restart: reconcile sends the wake again, and the arm follows it.
    await ctx.manager.handleChildPrTerminal(pr(8));
    registerMergeWatch(ctx.sessionManager, "parent", "child");
    parent.simulateRestart();
    parent.autoCompleteTurn = true;
    const recovered = restarted();
    await recovered.reconcilePending();
    await flush();
    recovered.stopRetryLoop();
    expect(wakes().at(-1)?.text).toContain("Child PR #8 merged");
    expect(watch()).toMatchObject({ state: "armed", reportedPr: { prNumber: 8, outcome: "merged" } });
  });

  it("req 3: no watch follows for a parent that was archived during the delivery", async () => {
    await armAsParent();
    const parent = heldParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    await armAsParent();
    ctx.sessionManager.archive("parent");

    parent.completeTurn();
    await flush();
    expect(watch()?.state).toBe("delivered");
  });

  it("req 1: a PR that closes while a merge wake is in delivery does not replace that wake", async () => {
    await armAsParent();
    const parent = heldParent();
    await ctx.manager.handleChildPrTerminal(pr(7));

    await ctx.manager.handleChildPrTerminal(pr(8, "closed"));
    expect(watch()).toMatchObject({ state: "merge-observed", mergedPr: { prNumber: 7 } });
    expect(wakes()).toHaveLength(1);

    parent.completeTurn();
    expect(watch()?.state).toBe("delivered");
    expect(cards().map((c) => c.outcome)).toEqual(["merged"]);
  });

  it("req 3: an arm queued during a delivery that fails for good still watches the next PR", async () => {
    await armAsParent();
    ctx.control.failWake = true;
    await ctx.manager.handleChildPrTerminal(pr(7));
    await armAsParent();
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
      ctx.sessionManager.setMergeWatch("child", { ...watch()!, lastAttemptAt: new Date(0).toISOString() });
      await ctx.manager.retryStalledDeliveries();
    }
    await flush();

    expect(watch()).toMatchObject({ state: "armed", reportedPr: { prNumber: 7, outcome: "merged" } });
    expect(cards().at(-1)?.deliveryFailure?.attempts).toBe(MAX_DELIVERY_ATTEMPTS);

    ctx.control.failWake = false;
    await ctx.manager.handleChildPrTerminal(pr(8));
    expect(wakes().at(-1)?.text).toContain("Child PR #8 merged");
    expect(watch()?.state).toBe("delivered");
  });

  it("req 4: an arm made after the wake does not fire again for the PR already reported", async () => {
    await armAsParent();
    snapshot = status(7);
    await ctx.manager.handleChildPrTerminal(pr(7));
    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 7, outcome: "merged" } });

    const result = await armAsParent();
    expect(result).toMatchObject({ state: "armed", alreadyArmed: false, skipsPr: 7 });
    expect(watch()?.state).toBe("armed");
    expect(wakes()).toHaveLength(1);

    // Neither does a restart, nor a second arm call.
    await ctx.manager.reconcilePending();
    expect(await armAsParent()).toMatchObject({ alreadyArmed: true, skipsPr: 7 });
    expect(wakes()).toHaveLength(1);
    expect(cards()).toHaveLength(1);

    await ctx.manager.handleChildPrTerminal(pr(8));
    expect(wakes()).toHaveLength(2);
  });

  it("req 2: an arm made after the wake reports a PR that merged in the meantime", async () => {
    await armAsParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    // The poller's event for #8 finds a watch that already fired.
    await ctx.manager.handleChildPrTerminal(pr(8));
    expect(wakes()).toHaveLength(1);

    snapshot = status(8);
    await armAsParent();
    expect(wakes()).toHaveLength(2);
    expect(wakes()[1].text).toContain("Child PR #8 merged");
    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 8 } });
  });

  it("req 2: it finds that PR after the child continued and cleared its PR snapshot", async () => {
    await armAsParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    // The child's own wake resets its branch: no snapshot, and #8 is now its previous merge.
    ctx.sessionManager.markMerged("child");
    ctx.sessionManager.clearMerged("child", {
      number: 8, url: "https://github.com/o/r/pull/8", title: "Step 8", baseBranch: "main",
    });

    await armAsParent();
    expect(wakes()).toHaveLength(2);
    expect(wakes()[1].text).toContain("Child PR #8 merged");
    expect(cards().at(-1)).toMatchObject({ prNumber: 8, prUrl: "https://github.com/o/r/pull/8" });

    // The same record must not report #8 a second time.
    await armAsParent();
    expect(wakes()).toHaveLength(2);
    expect(watch()?.state).toBe("armed");
  });

  it("req 4: nothing is reported when the child's previous merge is the reported one and its next PR is open", async () => {
    await armAsParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    ctx.sessionManager.markMerged("child");
    ctx.sessionManager.clearMerged("child", {
      number: 7, url: "https://github.com/o/r/pull/7", title: "Step 7", baseBranch: "main",
    });
    snapshot = status(8, "open");

    await armAsParent();
    expect(wakes()).toHaveLength(1);
    expect(watch()?.state).toBe("armed");
  });

  it("req 2: an open PR of the child does not hide an unreported merge before it", async () => {
    await armAsParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    ctx.sessionManager.markMerged("child");
    ctx.sessionManager.clearMerged("child", {
      number: 8, url: "https://github.com/o/r/pull/8", title: "Step 8", baseBranch: "main",
    });
    snapshot = status(9, "open");

    await armAsParent();
    expect(wakes().at(-1)?.text).toContain("Child PR #8 merged");
  });

  it("req 2: the previous merge is reported before a newer PR in the snapshot", async () => {
    await armAsParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    ctx.sessionManager.markMerged("child");
    ctx.sessionManager.clearMerged("child", {
      number: 8, url: "https://github.com/o/r/pull/8", title: "Step 8", baseBranch: "main",
    });
    snapshot = status(9, "closed");

    await armAsParent();
    expect(wakes().at(-1)?.text).toContain("Child PR #8 merged");
    await armAsParent();
    expect(wakes().at(-1)?.text).toContain("Child PR #9 closed without merging");
    expect(wakes()).toHaveLength(3);
  });

  it("a first arm waits for the next PR: it does not read the child's previous merge", async () => {
    ctx.sessionManager.markMerged("child");
    ctx.sessionManager.clearMerged("child", {
      number: 5, url: "https://github.com/o/r/pull/5", title: "Old", baseBranch: "main",
    });

    await armAsParent();
    expect(watch()?.state).toBe("armed");
    expect(wakes()).toHaveLength(0);
  });

  it("req 4: an arm after a closed PR was reported does not fire again for it", async () => {
    await armAsParent();
    snapshot = status(7, "closed");
    await ctx.manager.handleChildPrTerminal(pr(7, "closed"));
    expect(watch()).toMatchObject({ state: "closed-unmerged", reportedPr: { prNumber: 7, outcome: "closed" } });

    expect(await armAsParent()).toMatchObject({ state: "armed", skipsPr: 7 });
    expect(wakes()).toHaveLength(1);

    // The same PR, reopened and merged, is news.
    snapshot = status(7);
    await ctx.manager.reconcilePending();
    expect(wakes()).toHaveLength(2);
    expect(wakes()[1].text).toContain("Child PR #7 merged");
  });

  it("req 2: a PR reported as closed, then reopened and merged, is reported", async () => {
    await armAsParent();
    await ctx.manager.handleChildPrTerminal(pr(7, "closed"));
    expect(watch()?.reportedPr).toEqual({ prNumber: 7, outcome: "closed" });

    // The poller's event finds a watch that already fired, and the watch keeps it.
    await ctx.manager.handleChildPrTerminal(pr(7));
    await armAsParent();
    expect(wakes()).toHaveLength(2);
    expect(wakes()[1].text).toContain("Child PR #7 merged");
  });

  it("req 2: …also when only the child's previous-merge record still shows it", async () => {
    await armAsParent();
    await ctx.manager.handleChildPrTerminal(pr(7, "closed"));
    ctx.sessionManager.markMerged("child");
    ctx.sessionManager.clearMerged("child", {
      number: 7, url: "https://github.com/o/r/pull/7", title: "Step 7", baseBranch: "main",
    });

    await armAsParent();
    expect(wakes()).toHaveLength(2);
    expect(wakes()[1].text).toContain("Child PR #7 merged");
    await armAsParent();
    expect(wakes()).toHaveLength(2);
  });

  it("req 4: a close whose dispatch fails late leaves the watch that followed it as it is", async () => {
    await armAsParent();
    ctx.control.failWake = true;
    // The wake for #7 is rejected, and its handler runs only after what follows here.
    const first = ctx.manager.handleChildPrTerminal(pr(7, "closed"));
    ctx.control.failWake = false;
    registerMergeWatch(ctx.sessionManager, "parent", "child");
    const followingId = watch()?.watchId;
    const second = ctx.manager.handleChildPrTerminal(pr(8, "closed"));
    await Promise.all([first, second]);

    expect(watch()).toMatchObject({
      state: "closed-unmerged", watchId: followingId, reportedPr: { prNumber: 8, outcome: "closed" },
    });
    expect(watch()?.lastDeliveryError).toBeUndefined();
  });

  it("an arm after a wake that was never delivered reports that PR again", async () => {
    await armAsParent();
    snapshot = status(7, "closed");
    ctx.control.failWake = true;
    await ctx.manager.handleChildPrTerminal(pr(7, "closed"));
    expect(watch()).toMatchObject({ state: "closed-unmerged" });
    expect(watch()?.reportedPr).toBeUndefined();
    ctx.control.failWake = false;

    expect((await armAsParent()).skipsPr).toBeUndefined();
    expect(wakes().at(-1)?.text).toContain("closed without merging");
  });

  it("an arm after delivery-failed reports the merge again, and not the one before it", async () => {
    await armAsParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    await armAsParent();
    snapshot = status(8);
    ctx.control.failWake = true;
    await ctx.manager.handleChildPrTerminal(pr(8));
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
      ctx.sessionManager.setMergeWatch("child", { ...watch()!, lastAttemptAt: new Date(0).toISOString() });
      await ctx.manager.retryStalledDeliveries();
    }
    expect(watch()).toMatchObject({ state: "delivery-failed", reportedPr: { prNumber: 7 } });
    ctx.control.failWake = false;

    expect(await armAsParent()).toMatchObject({ alreadyArmed: false, skipsPr: 7 });
    expect(wakes().at(-1)?.text).toContain("Child PR #8 merged");
    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 8 } });
  });

  it("an arm after delivery-failed reports the failed merge before a PR that was kept in the meantime", async () => {
    await armAsParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    await armAsParent();
    ctx.control.failWake = true;
    await ctx.manager.handleChildPrTerminal(pr(8));
    await ctx.manager.handleChildPrTerminal(pr(9));
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
      ctx.sessionManager.setMergeWatch("child", { ...watch()!, lastAttemptAt: new Date(0).toISOString() });
      await ctx.manager.retryStalledDeliveries();
    }
    expect(watch()).toMatchObject({ state: "delivery-failed", unreportedPrs: [{ prNumber: 9 }] });
    ctx.control.failWake = false;
    // The child's stored state has moved on: only the watch still knows #8 and #9.
    snapshot = status(10, "open");

    await armAsParent();
    expect(watch()?.unreportedPrs?.map((p) => p.prNumber)).toEqual([9]);
    await armAsParent();
    expect(wakes().map((w) => /Child PR #(\d+)/.exec(w.text)?.[1])).toEqual(["7", "8", "9"]);
  });

  it("a kept PR that the parent already knows is not reported again", async () => {
    await armAsParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    ctx.sessionManager.setMergeWatch("child", {
      ...watch()!,
      unreportedPrs: [{ outcome: "merged", prNumber: 7, prUrl: "u", prTitle: "t", branch: "b" }],
    });

    await armAsParent();
    await ctx.manager.handleChildPrTerminal(pr(8));
    expect(wakes().map((w) => /Child PR #(\d+)/.exec(w.text)?.[1])).toEqual(["7", "8"]);
  });

  it("a close that could not be dispatched goes back in front of the PRs kept behind it", async () => {
    await armAsParent();
    const parent = heldParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    await armAsParent();
    await ctx.manager.handleChildPrTerminal(pr(8, "closed"));
    parent.completeTurn();

    // The watch that follows owes #8. Its wake cannot start, and #9 arrives in the same moment.
    ctx.control.failWake = true;
    await ctx.manager.handleChildPrTerminal(pr(9));
    await flush();
    expect(watch()).toMatchObject({ state: "closed-unmerged", reportedPr: { prNumber: 7 } });
    expect(watch()?.unreportedPrs?.map((p) => p.prNumber)).toEqual([8, 9]);

    ctx.control.failWake = false;
    parent.autoCompleteTurn = true;
    await armAsParent();
    await armAsParent();
    expect(wakes().slice(1).map((w) => w.text.split(":")[0])).toEqual([
      "Child PR #8 closed without merging",
      "Child PR #9 merged",
    ]);
  });

  it("a repeated event still drops the watch of a parent that was archived", async () => {
    await armAsParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    await armAsParent();
    ctx.sessionManager.archive("parent");

    await ctx.manager.handleChildPrTerminal(pr(7));
    expect(watch()).toBeUndefined();
  });

  it("a watch that fired keeps nothing for a parent that was archived", async () => {
    await armAsParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    ctx.sessionManager.archive("parent");

    await ctx.manager.handleChildPrTerminal(pr(8));
    expect(watch()?.state).toBe("delivered");
    expect(watch()?.unreportedPrs).toBeUndefined();
  });

  it("the next event drops what a fired watch kept before its parent was archived", async () => {
    await armAsParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    await ctx.manager.handleChildPrTerminal(pr(8));
    expect(watch()?.unreportedPrs).toHaveLength(1);
    ctx.sessionManager.archive("parent");

    await ctx.manager.handleChildPrTerminal(pr(9));
    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 7 } });
    expect(watch()?.unreportedPrs).toBeUndefined();
  });

  it("a close whose dispatch fails after the parent was archived keeps nothing, and adds no card", async () => {
    await armAsParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    await ctx.manager.handleChildPrTerminal(pr(8, "closed"));
    await ctx.manager.handleChildPrTerminal(pr(9));
    registerMergeWatch(ctx.sessionManager, "parent", "child");
    expect(watch()?.unreportedPrs?.map((p) => p.prNumber)).toEqual([8, 9]);

    // The wake for #8 is rejected; the parent is archived before that rejection is handled.
    ctx.control.failWake = true;
    const dispatch = ctx.manager.checkAndFireNow("child");
    ctx.sessionManager.archive("parent");
    await dispatch;

    expect(watch()).toMatchObject({ state: "closed-unmerged", reportedPr: { prNumber: 7 } });
    expect(watch()?.unreportedPrs).toBeUndefined();
    expect(cards().filter((c) => c.deliveryFailure)).toHaveLength(0);
  });

  it("a kept PR that the parent already knows does not come back when the next PR settles", async () => {
    const keptPr = (prNumber: number) => {
      const { sessionId: _session, ...kept } = pr(prNumber);
      return kept;
    };
    await armAsParent();
    const parent = heldParent();
    await ctx.manager.handleChildPrTerminal(pr(7));
    parent.completeTurn();
    await armAsParent();
    await ctx.manager.handleChildPrTerminal(pr(8));
    // A list that still holds the PR already reported, as an earlier write could have left it.
    ctx.sessionManager.setMergeWatch("child", { ...watch()!, unreportedPrs: [keptPr(7), keptPr(9)] });

    parent.completeTurn();
    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 8 } });
    expect(watch()?.unreportedPrs?.map((p) => p.prNumber)).toEqual([9]);

    // The same through the watch that follows a queued arm.
    await armAsParent();
    ctx.sessionManager.setMergeWatch("child", { ...watch()!, unreportedPrs: [keptPr(8), keptPr(10)] });
    await armAsParent();
    parent.completeTurn();
    await flush();
    parent.completeTurn();
    expect(wakes().map((w) => /Child PR #(\d+)/.exec(w.text)?.[1])).toEqual(["7", "8", "9", "10"]);
  });

  it("a watch that older code armed, with no id, still settles and hands over what it reported", async () => {
    arm(ctx.sessionManager);
    const parent = heldParent();
    snapshot = status(7);
    await ctx.manager.handleChildPrTerminal(pr(7));
    expect(watch()?.deliveryId).toBe("child:1");
    await armAsParent();

    parent.completeTurn();
    await flush();
    expect(watch()).toMatchObject({ state: "armed", reportedPr: { prNumber: 7 } });
    expect(watch()?.watchId).toBeTypeOf("string");
    expect(wakes()).toHaveLength(1);
  });
});
