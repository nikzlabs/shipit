import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { ChatHistoryManager } from "./chat-history.js";
import { MergeWatchManager, MAX_DELIVERY_ATTEMPTS } from "./merge-watch.js";
import { registerMergeWatch } from "./services/child-sessions.js";
import type { SessionRunnerInterface, SessionRunnerRegistry, AgentDispatchOptions } from "./session-runner.js";
import type { PrTerminalStateInfo } from "./pr-status-poller.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { SessionMergeWatch } from "../shared/types.js";
import {
  createTurnSettlement,
  TURN_COMPLETED,
  turnNoResult,
  type TurnHandle,
  type TurnOutcome,
} from "./turn-settlement.js";
import { storeOnlyInbox } from "./session-inbox-test-helpers.js";

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

interface Control {
  /** A session that cannot be started: its wake turn is not dispatched. */
  failWake: boolean;
  /** An inbox that cannot be written. */
  failStore: boolean;
  /** A transaction that fails at its end, after the notice and the watch were written in it. */
  failCommit: boolean;
  /** How many times a sender tried to store a notice. */
  stores: number;
}

function makeFakeRegistry(control: Control): {
  registry: SessionRunnerRegistry;
  runners: Map<string, FakeRunner>;
} {
  const runners = new Map<string, FakeRunner>();
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
  return { registry, runners };
}

function makeManager() {
  const db = new DatabaseManager(":memory:");
  const sessionManager = new SessionManager(db);
  const chatHistoryManager = new ChatHistoryManager(db);
  const control: Control = { failWake: false, failStore: false, failCommit: false, stores: 0 };
  const { registry, runners } = makeFakeRegistry(control);
  const inbox = storeOnlyInbox(db);
  const sessionInbox: typeof inbox.sessionInbox = {
    add: (sessionId, message, alongside) => {
      control.stores += 1;
      if (control.failStore) throw new Error("database is locked");
      inbox.sessionInbox.add(sessionId, message, () => {
        alongside?.();
        if (control.failCommit) throw new Error("disk I/O error");
      });
    },
    tell: inbox.sessionInbox.tell,
  };
  // A second manager over the same state is the orchestrator after a restart.
  const newManager = () =>
    new MergeWatchManager({
      sessionManager,
      runnerRegistry: registry,
      chatHistoryManager,
      sessionInbox,
      defaultAgentId: "claude",
    });
  sessionManager.track("parent", "Parent", "/ws/parent");
  sessionManager.track("child", "Child API", "/ws/child");
  sessionManager.setParentSession("child", "parent");
  return {
    sessionManager, chatHistoryManager, registry, runners, control, newManager,
    manager: newManager(), store: inbox.store, told: inbox.told,
  };
}

type Ctx = ReturnType<typeof makeManager>;

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

const MERGED_STATUS = {
  sessionId: "child", prNumber: 7, prUrl: MERGED.prUrl, prTitle: "Foundation", prBody: "",
  prState: "merged", baseBranch: "main", headBranch: "shipit/child", insertions: 1, deletions: 0,
  checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
  mergeable: "unknown", reviewDecision: "none", autoMergeEnabled: false,
} as PrStatusSummary;

const SELF_ID = "self-watch-1";

function arm(sessionManager: SessionManager) {
  sessionManager.setMergeWatch("child", { parentSessionId: "parent", state: "armed", registeredAt: "t0" });
}

function armSelf(sessionManager: SessionManager) {
  sessionManager.setSelfMergeWatch("child", {
    parentSessionId: "child", kind: "self", watchId: SELF_ID, prNumber: 7, state: "armed", registeredAt: "t0",
  });
}

/** What the parent's agent reads in its inbox, oldest first. */
const notices = (ctx: Ctx) => ctx.store.all("parent").map((m) => m.body);
/** The PR that each notice is about. */
const reported = (ctx: Ctx) => notices(ctx).map((n) => /Child PR #(\d+)/.exec(n)?.[1]);
const cards = (ctx: Ctx) =>
  ctx.chatHistoryManager.load("parent").flatMap((m) => (m.childMerged ? [m.childMerged] : []));

describe("a parent's watch on a child (docs/196-session-notify-on-merge, docs/328-session-message-inbox req 6)", () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = makeManager(); });
  afterEach(() => {
    ctx.manager.stopRetryLoop();
    vi.useRealTimers();
  });

  const state = () => ctx.sessionManager.getMergeWatch("child")?.state;

  it("merged: a persisted card, the notice in the parent's inbox, and a delivered watch", async () => {
    arm(ctx.sessionManager);
    await ctx.manager.handleChildPrTerminal(MERGED);

    expect(ctx.sessionManager.getMergeWatch("child")).toMatchObject({
      state: "delivered",
      reportedPr: { prNumber: 7, outcome: "merged" },
    });

    const [card] = cards(ctx);
    expect(card.outcome).toBe("merged");
    expect(card.prNumber).toBe(7);
    expect(card.mergeSha).toBe("deadbeefcafe1234");

    const stored = ctx.store.all("parent");
    expect(stored).toHaveLength(1);
    // ShipIt's own notice names no sending session.
    expect(stored[0].origin).toBeUndefined();
    expect(stored[0].body).toContain("Child PR #7 merged");
    expect(stored[0].body).toContain("child");
    expect(stored[0].body.length).toBeLessThan(240);
    expect(ctx.told).toEqual(["parent"]);
  });

  it("docs/328 req 1: the watch starts no turn in the parent, idle or busy", async () => {
    arm(ctx.sessionManager);
    await ctx.manager.handleChildPrTerminal(MERGED);
    expect(ctx.runners.get("parent")).toBeUndefined();

    ctx.sessionManager.setMergeWatch("child", { parentSessionId: "parent", state: "armed", registeredAt: "t1" });
    const parentRunner = ctx.registry.getOrCreate("parent", "/ws/parent", "claude") as unknown as FakeRunner;
    parentRunner.running = true;
    await ctx.manager.handleChildPrTerminal({ ...MERGED, prNumber: 8 });

    expect(parentRunner.dispatched).toHaveLength(0);
    expect(parentRunner.disposed).toBe(false);
    // A busy parent does not hold the watch open: the stored notice is the delivery.
    expect(state()).toBe("delivered");
    expect(reported(ctx)).toEqual(["7", "8"]);
  });

  it("is fire-once: a repeated event adds no notice and no card", async () => {
    arm(ctx.sessionManager);
    await ctx.manager.handleChildPrTerminal(MERGED);
    await ctx.manager.handleChildPrTerminal(MERGED);

    expect(notices(ctx)).toHaveLength(1);
    expect(cards(ctx)).toHaveLength(1);
  });

  it("closed-unmerged: a distinct card and notice, and a terminal state", async () => {
    arm(ctx.sessionManager);
    await ctx.manager.handleChildPrTerminal(CLOSED);

    expect(ctx.sessionManager.getMergeWatch("child")).toMatchObject({
      state: "closed-unmerged",
      reportedPr: { prNumber: 7, outcome: "closed" },
    });
    expect(cards(ctx).map((c) => c.outcome)).toEqual(["closed-unmerged"]);
    expect(notices(ctx)).toHaveLength(1);
    expect(notices(ctx)[0]).toContain("closed without merging");
    expect(ctx.told).toEqual(["parent"]);
  });

  it("drops the watch silently when the parent was archived", async () => {
    arm(ctx.sessionManager);
    ctx.sessionManager.archive("parent");
    await ctx.manager.handleChildPrTerminal(MERGED);

    expect(ctx.sessionManager.getMergeWatch("child")).toBeUndefined();
    expect(notices(ctx)).toHaveLength(0);
    expect(ctx.told).toEqual([]);
    expect(cards(ctx)).toHaveLength(0);
  });

  it("no-ops when the child carries no watch", async () => {
    await ctx.manager.handleChildPrTerminal(MERGED);
    expect(ctx.chatHistoryManager.load("parent")).toHaveLength(0);
    expect(notices(ctx)).toHaveLength(0);
  });

  it("reconcilePending reports an armed watch whose child PR already merged", async () => {
    arm(ctx.sessionManager);
    ctx.manager.setPrStatusLookup((id) => (id === "child" ? MERGED_STATUS : undefined));
    await ctx.manager.reconcilePending();

    expect(state()).toBe("delivered");
    expect(reported(ctx)).toEqual(["7"]);
  });

  it("regression: a delivered watch is never reported again across repeated restarts", async () => {
    arm(ctx.sessionManager);
    await ctx.manager.handleChildPrTerminal(MERGED);
    expect(state()).toBe("delivered");

    ctx.manager.setPrStatusLookup((id) => (id === "child" ? MERGED_STATUS : undefined));
    await ctx.manager.reconcilePending();
    await ctx.manager.reconcilePending();
    await ctx.manager.retryStalledDeliveries();

    expect(notices(ctx)).toHaveLength(1);
    expect(cards(ctx)).toHaveLength(1);
  });

  it("checkAndFireNow reports a PR that already resolved at registration time", async () => {
    arm(ctx.sessionManager);
    ctx.manager.setPrStatusLookup(() => MERGED_STATUS);
    await ctx.manager.checkAndFireNow("child");
    expect(state()).toBe("delivered");
    expect(reported(ctx)).toEqual(["7"]);
  });

  describe("the notice and the end of the watch are one write", () => {
    for (const [name, event, ended] of [
      ["merged", MERGED, "delivered"],
      ["closed", CLOSED, "closed-unmerged"],
    ] as const) {
      it(`${name}: when the watch cannot be ended, no notice and no card are kept`, async () => {
        arm(ctx.sessionManager);
        const write = vi.spyOn(ctx.sessionManager, "setMergeWatch")
          .mockImplementationOnce(() => { throw new Error("database is locked"); });

        await expect(ctx.manager.handleChildPrTerminal(event)).rejects.toThrow("database is locked");
        expect(notices(ctx)).toHaveLength(0);
        expect(cards(ctx)).toHaveLength(0);
        expect(ctx.told).toEqual([]);
        expect(state()).toBe("armed");
        write.mockRestore();

        // Nothing was half-written, so the next check reports the PR as if it were new.
        ctx.manager.setPrStatusLookup(() => ({ ...MERGED_STATUS, prState: name }));
        await ctx.manager.checkAndFireNow("child");
        expect(state()).toBe(ended);
        expect(notices(ctx)).toHaveLength(1);
        expect(cards(ctx)).toHaveLength(1);
      });

      it(`${name}: when the notice cannot be stored, the watch stays armed, with no card`, async () => {
        arm(ctx.sessionManager);
        ctx.control.failStore = true;

        await expect(ctx.manager.handleChildPrTerminal(event)).rejects.toThrow("database is locked");
        expect(state()).toBe("armed");
        expect(cards(ctx)).toHaveLength(0);
        expect(ctx.told).toEqual([]);
      });

      it(`${name}: a transaction that fails at its end keeps neither`, async () => {
        arm(ctx.sessionManager);
        ctx.control.failCommit = true;

        await expect(ctx.manager.handleChildPrTerminal(event)).rejects.toThrow("disk I/O error");
        expect(notices(ctx)).toHaveLength(0);
        expect(state()).toBe("armed");
        expect(cards(ctx)).toHaveLength(0);
      });
    }
  });
});

// A wake turn is what a session's watch on its own PR sends (docs/239). A parent's notice has
// no attempt to count: it is stored.
describe("a wake turn that cannot be delivered is retried (planning#260)", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeManager();
    armSelf(ctx.sessionManager);
    ctx.sessionManager.setPrStatus("child", MERGED_STATUS);
    ctx.manager.setPrStatusLookup((id) => ctx.sessionManager.getPrStatus(id) ?? undefined);
  });
  afterEach(() => {
    ctx.manager.stopRetryLoop();
    vi.useRealTimers();
  });

  const watch = () => ctx.sessionManager.getSelfMergeWatch("child");
  const wakes = () => ctx.runners.get("child")?.dispatched ?? [];

  function rewindLastAttempt(ms = 60 * 60 * 1000): void {
    const current = watch();
    if (!current) throw new Error("no watch to rewind");
    ctx.sessionManager.setSelfMergeWatch("child", {
      ...current,
      lastAttemptAt: new Date(Date.now() - ms).toISOString(),
    });
  }

  function busyRunner(): FakeRunner {
    const runner = ctx.registry.getOrCreate("child", "/ws/child", "claude") as unknown as FakeRunner;
    runner.running = true;
    return runner;
  }

  it("records the failed attempt and leaves the watch retryable instead of throwing", async () => {
    ctx.control.failWake = true;

    await expect(ctx.manager.handleSelfMerge("child")).resolves.toBeUndefined();

    expect(watch()?.state).toBe("merge-observed");
    expect(watch()?.deliveryAttempts).toBe(1);
    expect(watch()?.lastAttemptAt).toBeTypeOf("string");
    expect(watch()?.lastDeliveryError).toContain("could not be resumed");
    expect(wakes()).toHaveLength(0);
  });

  it("retries in-process and reaches delivered once an attempt succeeds — no restart", async () => {
    ctx.control.failWake = true;
    await ctx.manager.handleSelfMerge("child");
    expect(watch()?.state).toBe("merge-observed");

    ctx.control.failWake = false;
    rewindLastAttempt();
    await ctx.manager.retryStalledDeliveries();

    expect(watch()?.state).toBe("delivered");
    expect(wakes()).toHaveLength(1);
    expect(wakes()[0].systemTurn).toBeUndefined();
  });

  it("the retry supervisor's own timer drives the recovery (no external caller)", async () => {
    vi.useFakeTimers();
    ctx.control.failWake = true;
    await ctx.manager.handleSelfMerge("child");
    expect(watch()?.state).toBe("merge-observed");

    ctx.control.failWake = false;
    await vi.advanceTimersByTimeAsync(61_000);

    expect(watch()?.state).toBe("delivered");
    expect(wakes()).toHaveLength(1);
  });

  it("honors the backoff: a just-failed delivery is not re-attempted immediately", async () => {
    ctx.control.failWake = true;
    await ctx.manager.handleSelfMerge("child");

    ctx.control.failWake = false;
    await ctx.manager.retryStalledDeliveries();

    expect(watch()?.state).toBe("merge-observed");
    expect(watch()?.deliveryAttempts).toBe(1);
    expect(wakes()).toHaveLength(0);
  });

  it("REGRESSION: a wake-turn queued behind a busy session is never re-fired by the retry pass", async () => {
    const runner = busyRunner();

    await ctx.manager.handleSelfMerge("child");
    expect(runner.dispatched).toHaveLength(1);
    expect(watch()?.state).toBe("merge-observed");

    for (let i = 0; i < 5; i++) {
      rewindLastAttempt();
      await ctx.manager.retryStalledDeliveries();
    }

    expect(runner.dispatched).toHaveLength(1);
    expect(watch()?.state).toBe("merge-observed");
    expect(watch()?.deliveryAttempts).toBe(1);

    runner.running = false;
    runner.completeTurn();
    expect(watch()?.state).toBe("delivered");
    expect(runner.dispatched).toHaveLength(1);
  });

  it("re-delivers a queued wake-turn whose runner was disposed under it", async () => {
    const runner = busyRunner();
    await ctx.manager.handleSelfMerge("child");
    expect(runner.dispatched).toHaveLength(1);

    ctx.registry.dispose("child");
    rewindLastAttempt();
    await ctx.manager.retryStalledDeliveries();

    expect(watch()?.state).toBe("delivered");
    expect(wakes()).toHaveLength(1);
  });

  it("caps attempts: the watch reaches delivery-failed and leaves a persisted note", async () => {
    ctx.control.failWake = true;
    await ctx.manager.handleSelfMerge("child");

    for (let i = 1; i < MAX_DELIVERY_ATTEMPTS; i++) {
      rewindLastAttempt();
      await ctx.manager.retryStalledDeliveries();
    }

    expect(watch()?.state).toBe("delivery-failed");
    expect(watch()?.deliveryAttempts).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(watch()?.failedAt).toBeTypeOf("string");
    const note = ctx.chatHistoryManager.load("child").find((m) => m.notice);
    expect(note?.text).toContain(`${MAX_DELIVERY_ATTEMPTS} attempts`);
    expect(note?.text).toContain("could not be resumed");
    expect(ctx.sessionManager.listPendingMergeWatches()).toHaveLength(0);
  });

  it("a delivery-failed watch is terminal: no further retries, no resurrection by reconcile", async () => {
    ctx.control.failWake = true;
    await ctx.manager.handleSelfMerge("child");
    for (let i = 1; i < MAX_DELIVERY_ATTEMPTS; i++) {
      rewindLastAttempt();
      await ctx.manager.retryStalledDeliveries();
    }
    expect(watch()?.state).toBe("delivery-failed");

    ctx.control.failWake = false;
    await ctx.manager.retryStalledDeliveries();
    await ctx.manager.reconcilePending();
    await ctx.manager.handleSelfMerge("child");

    expect(watch()?.state).toBe("delivery-failed");
    expect(wakes()).toHaveLength(0);
    expect(ctx.chatHistoryManager.load("child").filter((m) => m.notice)).toHaveLength(1);
  });

  it("drops the watch (no retry) when the session is archived between attempts", async () => {
    ctx.control.failWake = true;
    await ctx.manager.handleSelfMerge("child");

    ctx.sessionManager.archive("child");
    ctx.control.failWake = false;
    rewindLastAttempt();
    await ctx.manager.retryStalledDeliveries();

    expect(watch()).toBeUndefined();
    expect(wakes()).toHaveLength(0);
  });

  it("stamps a durable delivery id on every attempt and persists it WITH the attempt", async () => {
    ctx.control.failWake = true;
    await ctx.manager.handleSelfMerge("child");

    expect(watch()?.deliveryAttempts).toBe(1);
    expect(watch()?.deliveryId).toBe(`${SELF_ID}:1`);

    rewindLastAttempt();
    await ctx.manager.retryStalledDeliveries();
    expect(watch()?.deliveryId).toBe(`${SELF_ID}:2`);
  });

  it("a wake-turn queued behind a busy session is recognized by its DELIVERY, with no in-memory marker to trust", async () => {
    const runner = busyRunner();
    await ctx.manager.handleSelfMerge("child");

    const deliveryId = watch()?.deliveryId;
    expect(deliveryId).toBeTypeOf("string");
    expect(runner.dispatched[0].deliveryId).toBe(deliveryId);
    expect(runner.hasDelivery(deliveryId!)).toBe(true);

    const fresh = ctx.newManager();
    fresh.setPrStatusLookup((id) => ctx.sessionManager.getPrStatus(id) ?? undefined);
    rewindLastAttempt();
    await fresh.retryStalledDeliveries();
    await fresh.reconcilePending();
    fresh.stopRetryLoop();

    expect(runner.dispatched).toHaveLength(1);
    expect(watch()?.deliveryAttempts).toBe(1);
  });

  it("rebindDelivery hands back the settlement for a live delivery, and nothing for a stale one", async () => {
    const runner = ctx.registry.getOrCreate("child", "/ws/child", "claude") as unknown as FakeRunner;
    runner.autoCompleteTurn = false;
    await ctx.manager.handleSelfMerge("child");
    const deliveryId = watch()!.deliveryId!;

    expect(ctx.manager.rebindDelivery(`${SELF_ID}:99`)).toBeUndefined();

    const settle = ctx.manager.rebindDelivery(deliveryId);
    expect(settle).toBeTypeOf("function");
    settle!(TURN_COMPLETED);
    expect(watch()?.state).toBe("delivered");

    expect(ctx.manager.rebindDelivery(deliveryId)).toBeUndefined();
  });
});

describe("a session watched by its parent AND by itself (docs/196 + docs/239)", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeManager();
    arm(ctx.sessionManager);
    armSelf(ctx.sessionManager);
    ctx.sessionManager.setPrStatus("child", MERGED_STATUS);
    ctx.manager.setPrStatusLookup((id) => ctx.sessionManager.getPrStatus(id) ?? undefined);
  });
  afterEach(() => { ctx.manager.stopRetryLoop(); });

  const parentState = () => ctx.sessionManager.getMergeWatch("child")?.state;
  const selfState = () => ctx.sessionManager.getSelfMergeWatch("child")?.state;

  it("one merge tells the parent from the terminal hook and wakes the child from the merge callback", async () => {
    await ctx.manager.handleChildPrTerminal(MERGED);
    expect(reported(ctx)).toEqual(["7"]);
    expect(ctx.runners.get("child")).toBeUndefined();
    expect(parentState()).toBe("delivered");
    expect(selfState()).toBe("armed");

    await ctx.manager.handleSelfMerge("child");
    expect(ctx.runners.get("child")?.dispatched).toHaveLength(1);
    expect(ctx.runners.get("child")?.dispatched[0].text).toContain("shipit branch reset-to-base");
    // The child's wake is a turn of its own; the parent gets none.
    expect(ctx.runners.get("parent")).toBeUndefined();
    expect(reported(ctx)).toEqual(["7"]);
    expect(selfState()).toBe("delivered");
    expect(parentState()).toBe("delivered");
    expect(cards(ctx)).toHaveLength(1);
  });

  it("handles both when the two paths run at the same time, as the poller starts them", async () => {
    await Promise.all([ctx.manager.handleChildPrTerminal(MERGED), ctx.manager.handleSelfMerge("child")]);

    expect(reported(ctx)).toEqual(["7"]);
    expect(ctx.runners.get("child")?.dispatched).toHaveLength(1);
    expect(parentState()).toBe("delivered");
    expect(selfState()).toBe("delivered");
  });

  it("the child's wake turn in delivery does not hold the parent's notice", async () => {
    ctx.registry.getOrCreate("child", "/ws/child", "claude");
    const childRunner = ctx.runners.get("child")!;
    childRunner.autoCompleteTurn = false;
    await ctx.manager.handleChildPrTerminal(MERGED);
    await ctx.manager.handleSelfMerge("child");

    expect(parentState()).toBe("delivered");
    expect(ctx.sessionManager.getMergeWatch("child")?.deliveryId).toBeUndefined();
    expect(selfState()).toBe("merge-observed");
    expect(ctx.sessionManager.getSelfMergeWatch("child")?.deliveryId).toBe(`${SELF_ID}:1`);

    childRunner.completeTurn();
    expect(selfState()).toBe("delivered");
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

  it("a wake of the child that fails leaves the parent told, and is retried on its own count", async () => {
    ctx.control.failWake = true;
    await ctx.manager.handleChildPrTerminal(MERGED);
    await ctx.manager.handleSelfMerge("child");
    expect(parentState()).toBe("delivered");
    expect(ctx.sessionManager.getMergeWatch("child")?.deliveryAttempts).toBeUndefined();
    expect(ctx.sessionManager.getSelfMergeWatch("child")).toMatchObject({ state: "merge-observed", deliveryAttempts: 1 });

    ctx.control.failWake = false;
    ctx.sessionManager.setSelfMergeWatch("child", {
      ...ctx.sessionManager.getSelfMergeWatch("child")!,
      lastAttemptAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    await ctx.manager.retryStalledDeliveries();

    expect(ctx.sessionManager.getSelfMergeWatch("child")).toMatchObject({ state: "delivered", deliveryAttempts: 2 });
    expect(ctx.runners.get("child")?.dispatched[0].text).toContain("shipit branch reset-to-base");
    expect(reported(ctx)).toEqual(["7"]);
  });

  it("reconcilePending handles both after a restart", async () => {
    await ctx.manager.reconcilePending();
    expect(reported(ctx)).toEqual(["7"]);
    expect(ctx.runners.get("child")?.dispatched).toHaveLength(1);
    expect(parentState()).toBe("delivered");
    expect(selfState()).toBe("delivered");
  });

  // A restart keeps nothing in memory, and the child's own wake turn resets its branch, which
  // clears the PR snapshot. The watch's own record of the merge is then the only one left.
  function restartWithoutSnapshot(): MergeWatchManager {
    ctx.manager.stopRetryLoop();
    const fresh = ctx.newManager();
    fresh.setPrStatusLookup(() => undefined);
    return fresh;
  }

  it("a parent's notice that could not be stored is stored at the next startup, from the child's stored PR state", async () => {
    ctx.control.failStore = true;
    await expect(ctx.manager.handleChildPrTerminal(MERGED)).rejects.toThrow("database is locked");
    expect(parentState()).toBe("armed");
    ctx.control.failStore = false;

    const fresh = ctx.newManager();
    fresh.setPrStatusLookup((id) => ctx.sessionManager.getPrStatus(id) ?? undefined);
    await fresh.reconcilePending();
    fresh.stopRetryLoop();

    expect(parentState()).toBe("delivered");
    expect(reported(ctx)).toEqual(["7"]);
    expect(cards(ctx)).toHaveLength(1);
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
    expect(reported(ctx)).toEqual(["7"]);
    expect(ctx.runners.get("child")).toBeUndefined();
    expect(selfState()).toBe("armed");
  });

  it("closed without merging: the parent is told, and the child gets its note and loses its watch", async () => {
    await ctx.manager.handleChildPrTerminal(CLOSED);

    expect(parentState()).toBe("closed-unmerged");
    expect(notices(ctx)[0]).toContain("closed without merging");
    expect(ctx.sessionManager.getSelfMergeWatch("child")).toBeUndefined();
    expect(ctx.runners.get("child")).toBeUndefined();
    expect(ctx.chatHistoryManager.load("child").find((m) => m.notice)?.text).toContain("closed without merging");
  });

  it("an archived parent drops only its own watch; the child is still woken", async () => {
    ctx.sessionManager.archive("parent");
    await ctx.manager.handleChildPrTerminal(MERGED);
    await ctx.manager.handleSelfMerge("child");

    expect(ctx.sessionManager.getMergeWatch("child")).toBeUndefined();
    expect(notices(ctx)).toHaveLength(0);
    expect(ctx.runners.get("child")?.dispatched).toHaveLength(1);
    expect(selfState()).toBe("delivered");
  });
});

const pr = (prNumber: number, outcome: "merged" | "closed" = "merged"): PrTerminalStateInfo => ({
  sessionId: "child",
  outcome,
  prNumber,
  prUrl: `https://github.com/o/r/pull/${prNumber}`,
  prTitle: `Step ${prNumber}`,
  branch: "shipit/child",
});
const keptPr = (prNumber: number, outcome: "merged" | "closed" = "merged") => {
  const { sessionId: _session, ...kept } = pr(prNumber, outcome);
  return kept;
};
const status = (prNumber: number, prState: "merged" | "closed" | "open" = "merged") => ({
  sessionId: "child", prNumber, prUrl: `https://github.com/o/r/pull/${prNumber}`, prTitle: `Step ${prNumber}`,
  prState, headBranch: "shipit/child", baseBranch: "main",
}) as unknown as PrStatusSummary;
const flush = () => new Promise((resolve) => setImmediate(resolve));

// The arm as the route makes it: the service call, then the register-time check.
async function armAsParent(ctx: Ctx) {
  const result = registerMergeWatch(ctx.sessionManager, "parent", "child");
  await ctx.manager.checkAndFireNow("child");
  return result;
}

describe("a parent that follows a child across several PRs (docs/196-session-notify-on-merge)", () => {
  let ctx: Ctx;
  let snapshot: PrStatusSummary | undefined;
  beforeEach(() => {
    ctx = makeManager();
    snapshot = undefined;
    ctx.manager.setPrStatusLookup((id) => (id === "child" ? snapshot : undefined));
  });
  afterEach(() => { ctx.manager.stopRetryLoop(); });

  const watch = () => ctx.sessionManager.getMergeWatch("child");

  it("req 3: an arm made before the parent read the notice applies to the child's next PR", async () => {
    await armAsParent(ctx);
    const firstId = watch()?.watchId;
    await ctx.manager.handleChildPrTerminal(pr(7));
    expect(ctx.store.unread("parent")).toHaveLength(1);

    const result = await armAsParent(ctx);
    expect(result).toMatchObject({ state: "armed", alreadyArmed: false, skipsPr: 7 });
    expect(watch()).toMatchObject({ state: "armed", reportedPr: { prNumber: 7, outcome: "merged" } });
    expect(watch()?.watchId).not.toBe(firstId);
    expect(reported(ctx)).toEqual(["7"]);

    await ctx.manager.handleChildPrTerminal(pr(8));
    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 8, outcome: "merged" } });
    expect(cards(ctx).map((c) => c.prNumber)).toEqual([7, 8]);
    // docs/328-session-message-inbox req 4 — one read gives the parent both notices.
    expect(ctx.store.takeUnread("parent").map((m) => /Child PR #(\d+)/.exec(m.body)?.[1])).toEqual(["7", "8"]);
  });

  it("req 2: two later PRs after the watch reported are both reported, in order, one for each arm", async () => {
    await armAsParent(ctx);
    await ctx.manager.handleChildPrTerminal(pr(7));

    // The child merges #8, continues, and closes #9. The watch keeps both: the child's stored
    // PR state shows only the newest by then.
    await ctx.manager.handleChildPrTerminal(pr(8));
    await ctx.manager.handleChildPrTerminal(pr(9, "closed"));
    await ctx.manager.handleChildPrTerminal(pr(9, "closed"));
    expect(watch()?.unreportedPrs?.map((p) => [p.prNumber, p.outcome])).toEqual([[8, "merged"], [9, "closed"]]);
    expect(reported(ctx)).toEqual(["7"]);

    await armAsParent(ctx);
    expect(reported(ctx)).toEqual(["7", "8"]);

    await armAsParent(ctx);
    expect(reported(ctx)).toEqual(["7", "8", "9"]);
    expect(notices(ctx)[2]).toContain("closed without merging");
    expect(cards(ctx).map((c) => c.prNumber)).toEqual([7, 8, 9]);
    expect(watch()?.unreportedPrs).toBeUndefined();
  });

  it("req 2: a live event does not overtake the PR that the watch kept", async () => {
    await armAsParent(ctx);
    await ctx.manager.handleChildPrTerminal(pr(7));
    await ctx.manager.handleChildPrTerminal(pr(8));

    // The watch is armed again, and its own check has not run yet, when #9 arrives.
    registerMergeWatch(ctx.sessionManager, "parent", "child");
    await ctx.manager.handleChildPrTerminal(pr(9));
    expect(reported(ctx)).toEqual(["7", "8"]);
    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 8 }, unreportedPrs: [{ prNumber: 9 }] });

    await armAsParent(ctx);
    expect(reported(ctx)).toEqual(["7", "8", "9"]);
    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 9 } });
    expect(watch()?.unreportedPrs).toBeUndefined();
  });

  it("req 2: a PR that resolves after the watch reported is kept for an arm in a later turn", async () => {
    await armAsParent(ctx);
    await ctx.manager.handleChildPrTerminal(pr(7));
    await ctx.manager.handleChildPrTerminal(pr(8));
    expect(watch()).toMatchObject({ state: "delivered", unreportedPrs: [{ prNumber: 8 }] });
    expect(reported(ctx)).toEqual(["7"]);

    // No snapshot and no previous-merge record: the watch's own copy is the only one.
    await armAsParent(ctx);
    expect(reported(ctx)).toEqual(["7", "8"]);
  });

  it("req 4: a terminal event that the poller repeats for a reported PR is not reported again", async () => {
    await armAsParent(ctx);
    await ctx.manager.handleChildPrTerminal(pr(7));
    await armAsParent(ctx);
    expect(watch()?.state).toBe("armed");

    // Merge-claim recovery promotes a merged PR again, with `force`.
    await ctx.manager.handleChildPrTerminal(pr(7));
    expect(watch()?.state).toBe("armed");
    expect(reported(ctx)).toEqual(["7"]);

    // On a watch that reported, the repeat is not kept for the next arm either.
    await ctx.manager.handleChildPrTerminal(pr(8));
    await ctx.manager.handleChildPrTerminal(pr(8));
    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 8 } });
    expect(watch()?.unreportedPrs).toBeUndefined();
    expect(reported(ctx)).toEqual(["7", "8"]);
  });

  it("req 4: an arm made after the notice does not report again the PR already reported", async () => {
    await armAsParent(ctx);
    snapshot = status(7);
    await ctx.manager.handleChildPrTerminal(pr(7));
    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 7, outcome: "merged" } });

    const result = await armAsParent(ctx);
    expect(result).toMatchObject({ state: "armed", alreadyArmed: false, skipsPr: 7 });
    expect(watch()?.state).toBe("armed");
    expect(reported(ctx)).toEqual(["7"]);

    // Neither does a restart, nor a second arm call.
    await ctx.manager.reconcilePending();
    expect(await armAsParent(ctx)).toMatchObject({ alreadyArmed: true, skipsPr: 7 });
    expect(reported(ctx)).toEqual(["7"]);
    expect(cards(ctx)).toHaveLength(1);

    await ctx.manager.handleChildPrTerminal(pr(8));
    expect(reported(ctx)).toEqual(["7", "8"]);
  });

  it("req 2: an arm made after the notice reports a PR that merged in the meantime", async () => {
    await armAsParent(ctx);
    await ctx.manager.handleChildPrTerminal(pr(7));
    // The poller's event for #8 finds a watch that already reported.
    await ctx.manager.handleChildPrTerminal(pr(8));
    expect(reported(ctx)).toEqual(["7"]);

    snapshot = status(8);
    await armAsParent(ctx);
    expect(reported(ctx)).toEqual(["7", "8"]);
    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 8 } });
  });

  it("req 2: it finds that PR after the child continued and cleared its PR snapshot", async () => {
    await armAsParent(ctx);
    await ctx.manager.handleChildPrTerminal(pr(7));
    // The child's own wake resets its branch: no snapshot, and #8 is now its previous merge.
    ctx.sessionManager.markMerged("child");
    ctx.sessionManager.clearMerged("child", {
      number: 8, url: "https://github.com/o/r/pull/8", title: "Step 8", baseBranch: "main",
    });

    await armAsParent(ctx);
    expect(reported(ctx)).toEqual(["7", "8"]);
    expect(cards(ctx).at(-1)).toMatchObject({ prNumber: 8, prUrl: "https://github.com/o/r/pull/8" });

    // The same record must not report #8 a second time.
    await armAsParent(ctx);
    expect(reported(ctx)).toEqual(["7", "8"]);
    expect(watch()?.state).toBe("armed");
  });

  it("req 4: nothing is reported when the child's previous merge is the reported one and its next PR is open", async () => {
    await armAsParent(ctx);
    await ctx.manager.handleChildPrTerminal(pr(7));
    ctx.sessionManager.markMerged("child");
    ctx.sessionManager.clearMerged("child", {
      number: 7, url: "https://github.com/o/r/pull/7", title: "Step 7", baseBranch: "main",
    });
    snapshot = status(8, "open");

    await armAsParent(ctx);
    expect(reported(ctx)).toEqual(["7"]);
    expect(watch()?.state).toBe("armed");
  });

  it("req 2: an open PR of the child does not hide an unreported merge before it", async () => {
    await armAsParent(ctx);
    await ctx.manager.handleChildPrTerminal(pr(7));
    ctx.sessionManager.markMerged("child");
    ctx.sessionManager.clearMerged("child", {
      number: 8, url: "https://github.com/o/r/pull/8", title: "Step 8", baseBranch: "main",
    });
    snapshot = status(9, "open");

    await armAsParent(ctx);
    expect(notices(ctx).at(-1)).toContain("Child PR #8 merged");
  });

  it("req 2: the previous merge is reported before a newer PR in the snapshot", async () => {
    await armAsParent(ctx);
    await ctx.manager.handleChildPrTerminal(pr(7));
    ctx.sessionManager.markMerged("child");
    ctx.sessionManager.clearMerged("child", {
      number: 8, url: "https://github.com/o/r/pull/8", title: "Step 8", baseBranch: "main",
    });
    snapshot = status(9, "closed");

    await armAsParent(ctx);
    expect(notices(ctx).at(-1)).toContain("Child PR #8 merged");
    await armAsParent(ctx);
    expect(notices(ctx).at(-1)).toContain("Child PR #9 closed without merging");
    expect(notices(ctx)).toHaveLength(3);
  });

  it("a first arm waits for the next PR: it does not read the child's previous merge", async () => {
    ctx.sessionManager.markMerged("child");
    ctx.sessionManager.clearMerged("child", {
      number: 5, url: "https://github.com/o/r/pull/5", title: "Old", baseBranch: "main",
    });

    await armAsParent(ctx);
    expect(watch()?.state).toBe("armed");
    expect(notices(ctx)).toHaveLength(0);
  });

  it("req 4: an arm after a closed PR was reported does not report it again", async () => {
    await armAsParent(ctx);
    snapshot = status(7, "closed");
    await ctx.manager.handleChildPrTerminal(pr(7, "closed"));
    expect(watch()).toMatchObject({ state: "closed-unmerged", reportedPr: { prNumber: 7, outcome: "closed" } });

    expect(await armAsParent(ctx)).toMatchObject({ state: "armed", skipsPr: 7 });
    expect(notices(ctx)).toHaveLength(1);

    // The same PR, reopened and merged, is news.
    snapshot = status(7);
    await ctx.manager.reconcilePending();
    expect(notices(ctx)).toHaveLength(2);
    expect(notices(ctx)[1]).toContain("Child PR #7 merged");
  });

  it("req 2: a PR reported as closed, then reopened and merged, is reported", async () => {
    await armAsParent(ctx);
    await ctx.manager.handleChildPrTerminal(pr(7, "closed"));
    expect(watch()?.reportedPr).toEqual({ prNumber: 7, outcome: "closed" });

    // The poller's event finds a watch that already reported, and the watch keeps it.
    await ctx.manager.handleChildPrTerminal(pr(7));
    await armAsParent(ctx);
    expect(notices(ctx)).toHaveLength(2);
    expect(notices(ctx)[1]).toContain("Child PR #7 merged");
  });

  it("req 2: …also when only the child's previous-merge record still shows it", async () => {
    await armAsParent(ctx);
    await ctx.manager.handleChildPrTerminal(pr(7, "closed"));
    ctx.sessionManager.markMerged("child");
    ctx.sessionManager.clearMerged("child", {
      number: 7, url: "https://github.com/o/r/pull/7", title: "Step 7", baseBranch: "main",
    });

    await armAsParent(ctx);
    expect(notices(ctx)).toHaveLength(2);
    expect(notices(ctx)[1]).toContain("Child PR #7 merged");
    await armAsParent(ctx);
    expect(notices(ctx)).toHaveLength(2);
  });

  it("a kept PR that the parent already knows is not reported again", async () => {
    await armAsParent(ctx);
    await ctx.manager.handleChildPrTerminal(pr(7));
    ctx.sessionManager.setMergeWatch("child", { ...watch()!, unreportedPrs: [keptPr(7)] });

    await armAsParent(ctx);
    await ctx.manager.handleChildPrTerminal(pr(8));
    expect(reported(ctx)).toEqual(["7", "8"]);
  });

  it("a kept PR that the parent already knows does not come back when the next PR is reported", async () => {
    await armAsParent(ctx);
    await ctx.manager.handleChildPrTerminal(pr(7));
    registerMergeWatch(ctx.sessionManager, "parent", "child");
    // A list that still holds the PR already reported, as an earlier write could have left it.
    ctx.sessionManager.setMergeWatch("child", { ...watch()!, unreportedPrs: [keptPr(7), keptPr(9)] });

    await ctx.manager.handleChildPrTerminal(pr(8));
    expect(reported(ctx)).toEqual(["7", "9"]);
    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 9 } });
    expect(watch()?.unreportedPrs?.map((p) => p.prNumber)).toEqual([8]);

    await armAsParent(ctx);
    expect(reported(ctx)).toEqual(["7", "9", "8"]);
  });

  it("a repeated event still drops the watch of a parent that was archived", async () => {
    await armAsParent(ctx);
    await ctx.manager.handleChildPrTerminal(pr(7));
    await armAsParent(ctx);
    ctx.sessionManager.archive("parent");

    await ctx.manager.handleChildPrTerminal(pr(7));
    expect(watch()).toBeUndefined();
  });

  it("a watch that reported keeps nothing for a parent that was archived", async () => {
    await armAsParent(ctx);
    await ctx.manager.handleChildPrTerminal(pr(7));
    ctx.sessionManager.archive("parent");

    await ctx.manager.handleChildPrTerminal(pr(8));
    expect(watch()?.state).toBe("delivered");
    expect(watch()?.unreportedPrs).toBeUndefined();
  });

  it("the next event drops what a watch kept before its parent was archived", async () => {
    await armAsParent(ctx);
    await ctx.manager.handleChildPrTerminal(pr(7));
    await ctx.manager.handleChildPrTerminal(pr(8));
    expect(watch()?.unreportedPrs).toHaveLength(1);
    ctx.sessionManager.archive("parent");

    await ctx.manager.handleChildPrTerminal(pr(9));
    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 7 } });
    expect(watch()?.unreportedPrs).toBeUndefined();
  });

  it("a watch that older code armed, with no id, hands over what it reported", async () => {
    arm(ctx.sessionManager);
    snapshot = status(7);
    await ctx.manager.handleChildPrTerminal(pr(7));
    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 7 } });

    expect(await armAsParent(ctx)).toMatchObject({ state: "armed", skipsPr: 7 });
    expect(watch()?.watchId).toBeTypeOf("string");
    expect(reported(ctx)).toEqual(["7"]);
  });
});

// Before docs/328-session-message-inbox a parent's notice was a wake turn, and its watch
// stayed `merge-observed` until that turn ended. A watch can be in that state at the upgrade,
// with its turn still running or held for the user's answer.
describe("a parent's watch that an older ShipIt left with a wake turn in delivery", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeManager();
    ctx.manager.setPrStatusLookup(() => undefined);
  });
  afterEach(() => {
    ctx.manager.stopRetryLoop();
    vi.useRealTimers();
  });

  const LEGACY_ID = "legacy-watch";
  const DELIVERY = `${LEGACY_ID}:1`;
  const watch = () => ctx.sessionManager.getMergeWatch("child");

  /** The watch as older code stored it, and a parent runner that still holds its wake turn. */
  function inDelivery(over: Partial<SessionMergeWatch> = {}): FakeRunner {
    const stored: SessionMergeWatch = {
      parentSessionId: "parent",
      watchId: LEGACY_ID,
      state: "merge-observed",
      registeredAt: "t0",
      observedAt: "t1",
      mergedPr: keptPr(7),
      deliveryAttempts: 1,
      lastAttemptAt: new Date(0).toISOString(),
      deliveryId: DELIVERY,
      ...over,
    };
    ctx.sessionManager.setMergeWatch("child", stored);
    ctx.registry.getOrCreate("parent", "/ws/parent", "claude");
    const runner = ctx.runners.get("parent")!;
    runner.activeDeliveryId = stored.deliveryId;
    return runner;
  }

  it("stores no notice while that turn can still end, and the turn's end closes the watch", async () => {
    const runner = inDelivery();
    await ctx.manager.reconcilePending();
    await ctx.manager.retryStalledDeliveries();
    await ctx.manager.handleChildPrTerminal(pr(7));

    expect(notices(ctx)).toHaveLength(0);
    expect(watch()?.state).toBe("merge-observed");
    expect(runner.dispatched).toHaveLength(0);

    ctx.manager.rebindDelivery(DELIVERY)!(TURN_COMPLETED);
    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 7, outcome: "merged" } });
    // The wake turn told the agent.
    expect(notices(ctx)).toHaveLength(0);
  });

  it("a turn that did not survive the restart: the notice goes to the inbox, with no second card and no new wake turn", async () => {
    const runner = inDelivery();
    runner.simulateRestart();
    await ctx.manager.reconcilePending();

    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 7, outcome: "merged" } });
    expect(reported(ctx)).toEqual(["7"]);
    expect(ctx.told).toEqual(["parent"]);
    expect(cards(ctx)).toHaveLength(0);
    expect(runner.dispatched).toHaveLength(0);
  });

  it("a turn that ends with no result is not counted against the watch: the retry pass stores the notice", async () => {
    const lastId = `${LEGACY_ID}:${MAX_DELIVERY_ATTEMPTS}`;
    const runner = inDelivery({ deliveryAttempts: MAX_DELIVERY_ATTEMPTS, deliveryId: lastId, lastAttemptAt: new Date().toISOString() });
    // The child's own watch has a wake turn in delivery too. It is not the one that failed.
    ctx.sessionManager.setSelfMergeWatch("child", {
      parentSessionId: "child", kind: "self", watchId: SELF_ID, prNumber: 7, state: "merge-observed",
      registeredAt: "t0", deliveryAttempts: 1, lastAttemptAt: new Date().toISOString(),
    });
    const settle = ctx.manager.rebindDelivery(lastId)!;
    runner.simulateRestart();
    settle(turnNoResult("the agent exited"));

    expect(watch()).toMatchObject({ state: "merge-observed", lastDeliveryError: "the agent exited" });
    expect(ctx.sessionManager.getSelfMergeWatch("child")?.state).toBe("merge-observed");

    // Neither the backoff of a wake turn nor a busy parent holds the notice back.
    runner.running = true;
    await ctx.manager.retryStalledDeliveries();
    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 7, outcome: "merged" } });
    expect(reported(ctx)).toEqual(["7"]);
    expect(cards(ctx)).toHaveLength(0);
    expect(runner.dispatched).toHaveLength(0);
  });

  it("a turn that is held for the user's answer, with no runner, is a turn that can still end", async () => {
    const runner = inDelivery();
    runner.simulateRestart();
    ctx.registry.dispose("parent");
    ctx.sessionManager.holdTurn("parent", {
      text: "Child PR #7 merged", execution: "dispatched", automatic: true, deliveryId: DELIVERY,
    });

    await ctx.manager.reconcilePending();
    await ctx.manager.retryStalledDeliveries();

    expect(notices(ctx)).toHaveLength(0);
    expect(watch()?.state).toBe("merge-observed");

    // The user answers, the turn runs, and its settlement is bound again from the saved row.
    ctx.manager.rebindDelivery(DELIVERY)!(TURN_COMPLETED);
    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 7, outcome: "merged" } });
    expect(notices(ctx)).toHaveLength(0);
  });

  it("req 4: a watch that recorded no merge facts records the PR it reports, and the next arm does not repeat it", async () => {
    const runner = inDelivery({ mergedPr: undefined });
    runner.simulateRestart();
    ctx.manager.setPrStatusLookup((id) => (id === "child" ? status(7) : undefined));
    await ctx.manager.reconcilePending();

    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 7, outcome: "merged" } });
    expect(reported(ctx)).toEqual(["7"]);

    expect(await armAsParent(ctx)).toMatchObject({ state: "armed", skipsPr: 7 });
    expect(reported(ctx)).toEqual(["7"]);
  });

  it("a watch with no merge facts and no turn reports a later PR that closed, and does not hold the next arm", async () => {
    const runner = inDelivery({ mergedPr: undefined, deliveryId: undefined });
    runner.simulateRestart();
    // The child continued: its stored state shows only the PR that it closed after the merge.
    ctx.manager.setPrStatusLookup((id) => (id === "child" ? status(8, "closed") : undefined));
    await ctx.manager.reconcilePending();

    expect(watch()).toMatchObject({ state: "closed-unmerged", reportedPr: { prNumber: 8, outcome: "closed" } });
    expect(notices(ctx)).toHaveLength(1);
    expect(notices(ctx)[0]).toContain("Child PR #8 closed without merging");

    expect(await armAsParent(ctx)).toMatchObject({ state: "armed", alreadyArmed: false, skipsPr: 8 });
  });

  it("a watch with no merge facts whose turn can still end keeps a later PR for the next arm", async () => {
    inDelivery({ mergedPr: undefined });
    await ctx.manager.handleChildPrTerminal(pr(8, "closed"));

    expect(watch()).toMatchObject({ state: "merge-observed", unreportedPrs: [{ prNumber: 8, outcome: "closed" }] });
    expect(notices(ctx)).toHaveLength(0);
    expect(cards(ctx)).toHaveLength(0);
  });

  it("a store that fails at its end is not tried again at once: the watch's timer tries it, and a queued arm follows", async () => {
    vi.useFakeTimers();
    const runner = inDelivery();
    await armAsParent(ctx);
    runner.simulateRestart();
    ctx.control.failCommit = true;
    ctx.control.stores = 0;

    await ctx.manager.reconcilePending();
    await vi.advanceTimersByTimeAsync(1_000);

    // The watch that would follow was written in the transaction that failed, and went with it.
    expect(ctx.control.stores).toBe(1);
    expect(notices(ctx)).toHaveLength(0);
    expect(watch()).toMatchObject({ state: "merge-observed", watchId: LEGACY_ID });
    expect(watch()?.rearmedAt).toBeTypeOf("string");

    ctx.control.failCommit = false;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(reported(ctx)).toEqual(["7"]);
    expect(watch()).toMatchObject({ state: "armed", reportedPr: { prNumber: 7, outcome: "merged" } });
  });

  it("req 3: an arm made during that turn applies to the child's next PR, and a second one changes nothing", async () => {
    inDelivery();
    expect(await armAsParent(ctx)).toMatchObject({ state: "merge-observed", alreadyArmed: false, skipsPr: 7 });
    const queuedAt = watch()?.rearmedAt;
    expect(queuedAt).toBeTypeOf("string");
    expect(await armAsParent(ctx)).toMatchObject({ state: "merge-observed", alreadyArmed: true, skipsPr: 7 });
    expect(watch()).toMatchObject({ state: "merge-observed", watchId: LEGACY_ID, rearmedAt: queuedAt });

    const settle = ctx.manager.rebindDelivery(DELIVERY)!;
    settle(TURN_COMPLETED);
    await flush();
    expect(watch()).toMatchObject({ state: "armed", reportedPr: { prNumber: 7, outcome: "merged" } });
    expect(watch()?.watchId).not.toBe(LEGACY_ID);

    // The old turn's settlement cannot end the watch that follows it.
    settle(TURN_COMPLETED);
    expect(watch()?.state).toBe("armed");

    await ctx.manager.handleChildPrTerminal(pr(8));
    expect(reported(ctx)).toEqual(["8"]);
    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 8, outcome: "merged" } });
  });

  it("req 3: PRs that resolve during that turn are reported to the arms that follow, in order", async () => {
    inDelivery();
    await ctx.manager.handleChildPrTerminal(pr(8));
    await ctx.manager.handleChildPrTerminal(pr(9, "closed"));
    expect(watch()).toMatchObject({ state: "merge-observed", mergedPr: { prNumber: 7 } });
    expect(watch()?.unreportedPrs?.map((p) => p.prNumber)).toEqual([8, 9]);
    expect(notices(ctx)).toHaveLength(0);

    await armAsParent(ctx);
    ctx.manager.rebindDelivery(DELIVERY)!(TURN_COMPLETED);
    await flush();
    expect(reported(ctx)).toEqual(["8"]);
    expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 8 }, unreportedPrs: [{ prNumber: 9 }] });

    await armAsParent(ctx);
    expect(reported(ctx)).toEqual(["8", "9"]);
    expect(cards(ctx).map((c) => c.prNumber)).toEqual([8, 9]);
  });

  it("req 1: a PR that closes during that turn does not replace it", async () => {
    inDelivery();
    await ctx.manager.handleChildPrTerminal(pr(8, "closed"));
    expect(watch()).toMatchObject({ state: "merge-observed", mergedPr: { prNumber: 7 } });
    expect(notices(ctx)).toHaveLength(0);
    expect(cards(ctx)).toHaveLength(0);

    ctx.manager.rebindDelivery(DELIVERY)!(TURN_COMPLETED);
    expect(watch()?.state).toBe("delivered");
  });

  it("req 3: no watch follows for a parent that was archived during that turn", async () => {
    inDelivery();
    await armAsParent(ctx);
    ctx.sessionManager.archive("parent");

    ctx.manager.rebindDelivery(DELIVERY)!(TURN_COMPLETED);
    await flush();
    expect(watch()?.state).toBe("delivered");
  });

  it("req 3: an arm queued during that turn survives a restart that the turn outlived", async () => {
    inDelivery();
    await armAsParent(ctx);

    const adopted = ctx.newManager();
    adopted.setPrStatusLookup(() => undefined);
    adopted.rebindDelivery(DELIVERY)!(TURN_COMPLETED);
    await flush();
    adopted.stopRetryLoop();

    expect(watch()).toMatchObject({ state: "armed", reportedPr: { prNumber: 7, outcome: "merged" } });
    expect(notices(ctx)).toHaveLength(0);
  });

  it("req 3: …and a restart that lost the turn: the notice is stored, and the arm follows it", async () => {
    const runner = inDelivery();
    await armAsParent(ctx);
    runner.simulateRestart();

    const recovered = ctx.newManager();
    recovered.setPrStatusLookup(() => undefined);
    await recovered.reconcilePending();
    await flush();
    recovered.stopRetryLoop();

    expect(reported(ctx)).toEqual(["7"]);
    expect(watch()).toMatchObject({ state: "armed", reportedPr: { prNumber: 7, outcome: "merged" } });
  });

  it("a watch with no id still settles and hands over what it reported", async () => {
    inDelivery({ watchId: undefined, deliveryId: "child:1" });
    await armAsParent(ctx);

    ctx.manager.rebindDelivery("child:1")!(TURN_COMPLETED);
    await flush();
    expect(watch()).toMatchObject({ state: "armed", reportedPr: { prNumber: 7 } });
    expect(watch()?.watchId).toBeTypeOf("string");
    expect(notices(ctx)).toHaveLength(0);
  });

  describe("and one that it gave up on (`delivery-failed`)", () => {
    function gaveUp(over: Partial<SessionMergeWatch> = {}): void {
      ctx.sessionManager.setMergeWatch("child", {
        parentSessionId: "parent",
        watchId: LEGACY_ID,
        state: "delivery-failed",
        registeredAt: "t0",
        mergedPr: keptPr(8),
        reportedPr: { prNumber: 7, outcome: "merged" },
        failedAt: "t2",
        ...over,
      });
    }

    it("stays as it is: no retry pass and no restart reports it", async () => {
      gaveUp();
      await ctx.manager.retryStalledDeliveries();
      await ctx.manager.reconcilePending();
      await ctx.manager.handleChildPrTerminal(pr(8));

      expect(watch()?.state).toBe("delivery-failed");
      expect(notices(ctx)).toHaveLength(0);
    });

    it("the next arm reports its merge, and not the one before it", async () => {
      gaveUp();

      expect(await armAsParent(ctx)).toMatchObject({ alreadyArmed: false, skipsPr: 7 });
      expect(reported(ctx)).toEqual(["8"]);
      expect(watch()).toMatchObject({ state: "delivered", reportedPr: { prNumber: 8 } });
    });

    it("the next arm reports its merge before a PR that was kept in the meantime", async () => {
      gaveUp({ unreportedPrs: [keptPr(9)] });

      await armAsParent(ctx);
      expect(watch()?.unreportedPrs?.map((p) => p.prNumber)).toEqual([9]);
      await armAsParent(ctx);
      expect(reported(ctx)).toEqual(["8", "9"]);
    });
  });
});
