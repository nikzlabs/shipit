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
