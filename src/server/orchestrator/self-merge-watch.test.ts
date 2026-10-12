import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { ChatHistoryManager } from "./chat-history.js";
import { MergeWatchManager, MAX_DELIVERY_ATTEMPTS, MAX_QUOTA_REFUSALS } from "./merge-watch.js";
import { armSelfMergeWatch, cancelSelfMergeWatch } from "./services/self-merge-watch.js";
import { ServiceError } from "./services/types.js";
import {
  createTurnSettlement,
  TURN_COMPLETED,
  turnInterrupted,
  turnNoResult,
  turnQuotaRefused,
  type TurnHandle,
  type TurnOutcome,
} from "./turn-settlement.js";
import type { AgentDispatchOptions, SessionRunnerInterface, SessionRunnerRegistry } from "./session-runner.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { GitManager } from "../shared/git.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { PrTerminalStateInfo } from "./pr-status-poller.js";
import { storeOnlyInbox } from "./session-inbox-test-helpers.js";

const SESSION_ID = "s1";

class FakeRunner {
  running = false;
  disposed = false;
  agentId = "claude" as const;
  sessionDir = "/ws/s1";
  dispatched: AgentDispatchOptions[] = [];
  emitted: Record<string, unknown>[] = [];
  chatMessageGroups: unknown[] = [];
  recordedCards: { afterGroupIndex: number; message: Record<string, unknown> }[] = [];
  steeredMessages: unknown[] = [];
  lastPersistedBufferIndex = 0;
  activeDeliveryId: string | undefined;
  workerTurnActive = false;
  private pending: ((o: TurnOutcome) => void)[] = [];

  dispatch(opts: AgentDispatchOptions): TurnHandle {
    this.dispatched.push(opts);
    const settlement = createTurnSettlement();
    if (opts.deliveryId !== undefined) this.activeDeliveryId = opts.deliveryId;
    if (opts.onTurnComplete) this.pending.push(opts.onTurnComplete);
    return settlement;
  }
  hasDelivery(deliveryId: string): boolean { return this.activeDeliveryId === deliveryId; }
  async hasTurnInFlight(): Promise<boolean> { return this.running || this.workerTurnActive; }
  completeTurns(outcome: TurnOutcome = TURN_COMPLETED): void {
    const pending = this.pending;
    this.pending = [];
    this.activeDeliveryId = undefined;
    for (const fire of pending) fire(outcome);
  }
  emitMessage(msg: Record<string, unknown>): void { this.emitted.push(msg); }
  getTurnEventBuffer(): unknown[] { return []; }
}

function makePrStatus(over: Partial<PrStatusSummary> = {}): PrStatusSummary {
  return {
    sessionId: SESSION_ID,
    prNumber: 42,
    prUrl: "https://github.com/o/r/pull/42",
    prTitle: "Step one",
    prBody: "",
    prState: "open",
    baseBranch: "main",
    headBranch: "shipit/s1",
    insertions: 1,
    deletions: 0,
    checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
    mergeable: "unknown",
    reviewDecision: "none",
    autoMergeEnabled: false,
    ...over,
  };
}

function makeCtx() {
  const db = new DatabaseManager(":memory:");
  const sessionManager = new SessionManager(db);
  const chatHistoryManager = new ChatHistoryManager(db);
  sessionManager.track(SESSION_ID, "Chained work", "/ws/s1");
  sessionManager.setBranch(SESSION_ID, "shipit/s1");

  const runner = new FakeRunner();
  const runnerRegistry = {
    get: (id: string) => (id === SESSION_ID ? (runner as unknown as SessionRunnerInterface) : undefined),
    getOrCreate: () => runner as unknown as SessionRunnerInterface,
    dispose: () => { /* no teardown in these tests */ },
  } as unknown as SessionRunnerRegistry;

  const livePr = { value: { number: 43, url: "https://github.com/o/r/pull/43", base: "main", title: "Step two" } as { number: number; url: string; base: string; title: string } | null };
  const githubAuthManager = {
    authenticated: true,
    findPullRequest: vi.fn(async () => livePr.value),
  } as unknown as GitHubAuthManager;
  const createGitManager = (): GitManager => ({
    getRemotes: async () => [{ name: "origin", url: "https://github.com/o/r.git" }],
    addRemote: async () => undefined,
    getCurrentBranch: async () => "shipit/s1",
  } as unknown as GitManager);

  const { sessionInbox } = storeOnlyInbox(db);
  const manager = new MergeWatchManager({
    sessionManager,
    runnerRegistry,
    chatHistoryManager,
    sessionInbox,
    defaultAgentId: "claude",
  });

  const armDeps = {
    sessionManager,
    githubAuthManager,
    createGitManager,
    runnerRegistry,
    chatHistoryManager,
    mergeWatchManager: manager,
  };

  return { db, sessionManager, chatHistoryManager, runner, manager, armDeps, livePr, sessionInbox };
}

function markMerged(ctx: ReturnType<typeof makeCtx>, prNumber: number): void {
  ctx.sessionManager.setPrStatus(SESSION_ID, makePrStatus({ prNumber, prState: "merged" }));
  ctx.manager.setPrStatusLookup((id) => ctx.sessionManager.getPrStatus(id) ?? undefined);
}

describe("arming a self merge-watch (docs/239)", () => {
  let ctx: ReturnType<typeof makeCtx>;
  beforeEach(() => { ctx = makeCtx(); });

  it("refuses when the branch has no open PR", async () => {
    ctx.livePr.value = null;
    await expect(armSelfMergeWatch(ctx.armDeps, SESSION_ID)).rejects.toThrow(ServiceError);
    expect(ctx.sessionManager.getSelfMergeWatch(SESSION_ID)).toBeUndefined();
  });

  it("anchors to the LIVE open PR, not the stale pr_status snapshot", async () => {
    ctx.sessionManager.setPrStatus(SESSION_ID, makePrStatus({ prNumber: 42, prState: "merged" }));
    const result = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    expect(result.prNumber).toBe(43);
    expect(ctx.sessionManager.getSelfMergeWatch(SESSION_ID)?.prNumber).toBe(43);
  });

  it("arms beside a live parent→child watch and leaves that watch as it was", async () => {
    const parentWatch = { parentSessionId: "some-parent", state: "armed" as const, registeredAt: "t0" };
    ctx.sessionManager.setMergeWatch(SESSION_ID, parentWatch);

    const result = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);

    expect(result.replaced).toBe(false);
    expect(ctx.sessionManager.getSelfMergeWatch(SESSION_ID)).toMatchObject({
      kind: "self", prNumber: 43, state: "armed", parentSessionId: SESSION_ID,
    });
    expect(ctx.sessionManager.getMergeWatch(SESSION_ID)).toEqual(parentWatch);
  });

  it("re-arming while a parent watch is mid-delivery does not disturb that delivery", async () => {
    const delivering = {
      parentSessionId: "some-parent", state: "merge-observed" as const, registeredAt: "t0",
      observedAt: "t1", deliveryAttempts: 1, lastAttemptAt: "t1", deliveryId: `${SESSION_ID}:1`,
    };
    ctx.sessionManager.setMergeWatch(SESSION_ID, delivering);
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);

    expect(ctx.sessionManager.getMergeWatch(SESSION_ID)).toEqual(delivering);
    expect(ctx.manager.rebindDelivery(`${SESSION_ID}:1`)).toBeTypeOf("function");
  });

  it("always REPLACES an existing self-watch, including one mid-delivery", async () => {
    const first = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    const observed = ctx.sessionManager.getSelfMergeWatch(SESSION_ID)!;
    ctx.sessionManager.setSelfMergeWatch(SESSION_ID, { ...observed, state: "merge-observed" });
    ctx.livePr.value = { number: 44, url: "https://github.com/o/r/pull/44", base: "main", title: "Step three" };

    const second = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    expect(second.replaced).toBe(true);
    expect(second.watchId).not.toBe(first.watchId);
    const watch = ctx.sessionManager.getSelfMergeWatch(SESSION_ID)!;
    expect(watch.state).toBe("armed");
    expect(watch.prNumber).toBe(44);
  });

  const notes = () => ctx.chatHistoryManager.load(SESSION_ID).filter((m) => m.notice);

  it("replacing a watch that still waits on ANOTHER PR leaves a persisted note in the transcript", async () => {
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    ctx.livePr.value = { number: 44, url: "https://github.com/o/r/pull/44", base: "main", title: "Step three" };

    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);

    expect(notes()).toHaveLength(1);
    expect(notes()[0]!.text).toContain("#43");
    expect(notes()[0]!.text).toContain("#44");
  });

  it("a re-arm that loses nothing leaves no note: the same PR, or a watch that already saw its merge", async () => {
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);

    const observed = ctx.sessionManager.getSelfMergeWatch(SESSION_ID)!;
    ctx.sessionManager.setSelfMergeWatch(SESSION_ID, { ...observed, state: "merge-observed" });
    ctx.livePr.value = { number: 44, url: "https://github.com/o/r/pull/44", base: "main", title: "Step three" };
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);

    expect(notes()).toHaveLength(0);
  });

  it("persists the arm card so it round-trips a reload", async () => {
    const result = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    expect(ctx.runner.emitted.some((m) => m.type === "self_merge_watch_card")).toBe(true);
    const persisted = ctx.chatHistoryManager.load(SESSION_ID).find((m) => m.selfMergeWatch);
    expect(persisted?.selfMergeWatch?.watchId).toBe(result.watchId);
    expect(persisted?.selfMergeWatch?.prNumber).toBe(43);
    expect(persisted?.selfMergeWatch?.branch).toBe("shipit/s1");
  });
});

describe("cancelling a self merge-watch (docs/239)", () => {
  let ctx: ReturnType<typeof makeCtx>;
  beforeEach(() => { ctx = makeCtx(); });

  it("clears the watch when the watchId matches", async () => {
    const { watchId } = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    expect(cancelSelfMergeWatch(ctx.armDeps, SESSION_ID, watchId)).toEqual({ cancelled: true });
    expect(ctx.sessionManager.getSelfMergeWatch(SESSION_ID)).toBeUndefined();
  });

  it("leaves a parent's watch on this session in place", async () => {
    const parentWatch = { parentSessionId: "some-parent", state: "armed" as const, registeredAt: "t0" };
    ctx.sessionManager.setMergeWatch(SESSION_ID, parentWatch);
    const { watchId } = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);

    expect(cancelSelfMergeWatch(ctx.armDeps, SESSION_ID, watchId)).toEqual({ cancelled: true });
    expect(ctx.sessionManager.getSelfMergeWatch(SESSION_ID)).toBeUndefined();
    expect(ctx.sessionManager.getMergeWatch(SESSION_ID)).toEqual(parentWatch);
  });

  it("a stale card's Cancel does NOT cancel the newer watch", async () => {
    const stale = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    ctx.livePr.value = { number: 44, url: "https://github.com/o/r/pull/44", base: "main", title: "Step three" };
    const current = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);

    expect(cancelSelfMergeWatch(ctx.armDeps, SESSION_ID, stale.watchId))
      .toEqual({ cancelled: false, reason: "superseded" });
    expect(ctx.sessionManager.getSelfMergeWatch(SESSION_ID)?.watchId).toBe(current.watchId);
  });
});

describe("delivering a self merge wake (docs/239)", () => {
  let ctx: ReturnType<typeof makeCtx>;
  beforeEach(() => { ctx = makeCtx(); });

  it("fires from the merge callback, after the merge bookkeeping is persisted", async () => {
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    markMerged(ctx, 43);

    await ctx.manager.handleSelfMerge(SESSION_ID);

    expect(ctx.sessionManager.getSelfMergeWatch(SESSION_ID)?.state).toBe("merge-observed");
    expect(ctx.runner.dispatched).toHaveLength(1);
    expect(ctx.runner.dispatched[0]!.text).toContain("#43");
    expect(ctx.runner.dispatched[0]!.text).toContain("shipit branch reset-to-base");
    expect(ctx.runner.dispatched[0]!.text.length).toBeLessThan(500);

    ctx.runner.completeTurns();
    expect(ctx.sessionManager.getSelfMergeWatch(SESSION_ID)?.state).toBe("delivered");
  });

  it("does NOT wake from the earlier onPrTerminalState hook (it races branch deletion)", async () => {
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    const info: PrTerminalStateInfo = {
      sessionId: SESSION_ID, outcome: "merged", prNumber: 43,
      prUrl: "https://github.com/o/r/pull/43", prTitle: "Step two", branch: "shipit/s1",
    };
    await ctx.manager.handleChildPrTerminal(info);
    expect(ctx.runner.dispatched).toHaveLength(0);
    expect(ctx.sessionManager.getSelfMergeWatch(SESSION_ID)?.state).toBe("armed");
  });

  it("still wakes when a docs/202 re-arm clears the PR snapshot before the merge callback runs", async () => {
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    await ctx.manager.handleChildPrTerminal({
      sessionId: SESSION_ID, outcome: "merged", prNumber: 43,
      prUrl: "https://github.com/o/r/pull/43", prTitle: "Step two", branch: "shipit/s1",
    });
    ctx.manager.setPrStatusLookup(() => undefined);

    await ctx.manager.handleSelfMerge(SESSION_ID);

    expect(ctx.runner.dispatched).toHaveLength(1);
    expect(ctx.runner.dispatched[0]!.text).toContain("#43");
    ctx.runner.completeTurns();
    expect(ctx.sessionManager.getSelfMergeWatch(SESSION_ID)?.state).toBe("delivered");
  });

  it("an anchor mismatch appends a note and wakes nothing", async () => {
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    markMerged(ctx, 42);

    await ctx.manager.handleSelfMerge(SESSION_ID);

    expect(ctx.runner.dispatched).toHaveLength(0);
    expect(ctx.sessionManager.getSelfMergeWatch(SESSION_ID)).toBeUndefined();
    const note = ctx.chatHistoryManager.load(SESSION_ID).find((m) => m.notice);
    expect(note?.text).toContain("#42");
    expect(note?.text).toContain("#43");
  });

  it("closed-without-merge appends a note, clears the watch, and wakes nothing", async () => {
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    await ctx.manager.handleChildPrTerminal({
      sessionId: SESSION_ID, outcome: "closed", prNumber: 43,
      prUrl: "https://github.com/o/r/pull/43", prTitle: "Step two", branch: "shipit/s1",
    });

    expect(ctx.runner.dispatched).toHaveLength(0);
    expect(ctx.sessionManager.getSelfMergeWatch(SESSION_ID)).toBeUndefined();
    expect(ctx.chatHistoryManager.load(SESSION_ID).find((m) => m.notice)?.text)
      .toContain("closed without merging");
  });

  it("an OLD wake turn's settlement does not mark a newly-armed watch delivered", async () => {
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    markMerged(ctx, 43);
    await ctx.manager.handleSelfMerge(SESSION_ID);
    expect(ctx.runner.dispatched).toHaveLength(1);

    ctx.livePr.value = { number: 44, url: "https://github.com/o/r/pull/44", base: "main", title: "Step three" };
    const next = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);

    ctx.runner.completeTurns();

    const watch = ctx.sessionManager.getSelfMergeWatch(SESSION_ID)!;
    expect(watch.watchId).toBe(next.watchId);
    expect(watch.state).toBe("armed");
  });

  it("restores an evicted checkout before waking", async () => {
    const restoreWorkspace = vi.fn(async () => true);
    const manager = new MergeWatchManager({
      sessionManager: ctx.sessionManager,
      runnerRegistry: ctx.armDeps.runnerRegistry,
      chatHistoryManager: ctx.chatHistoryManager,
      sessionInbox: ctx.sessionInbox,
      defaultAgentId: "claude",
      restoreWorkspace,
    });
    manager.setPrStatusLookup((id) => ctx.sessionManager.getPrStatus(id) ?? undefined);
    await armSelfMergeWatch({ ...ctx.armDeps, mergeWatchManager: manager }, SESSION_ID);
    ctx.sessionManager.setPrStatus(SESSION_ID, makePrStatus({ prNumber: 43, prState: "merged" }));

    await manager.handleSelfMerge(SESSION_ID);

    expect(restoreWorkspace).toHaveBeenCalledWith(SESSION_ID);
    expect(ctx.runner.dispatched).toHaveLength(1);
  });

  it("reconcilePending re-fires a self-watch after a restart", async () => {
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    markMerged(ctx, 43);
    await ctx.manager.reconcilePending();
    expect(ctx.runner.dispatched).toHaveLength(1);
  });
});

describe("a wake that reached the agent is not re-delivered (planning#318)", () => {
  let ctx: ReturnType<typeof makeCtx>;
  beforeEach(() => { ctx = makeCtx(); });

  async function deliverWake(): Promise<void> {
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    markMerged(ctx, 43);
    await ctx.manager.handleSelfMerge(SESSION_ID);
    expect(ctx.runner.dispatched).toHaveLength(1);
  }

  function expireBackoff(): void {
    const watch = ctx.sessionManager.getSelfMergeWatch(SESSION_ID)!;
    ctx.sessionManager.setSelfMergeWatch(SESSION_ID, {
      ...watch,
      lastAttemptAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
  }

  it("an interrupted wake turn is terminal — the retry supervisor never re-sends it", async () => {
    await deliverWake();

    ctx.runner.completeTurns(turnInterrupted("the turn was interrupted before it produced a result"));

    expect(ctx.sessionManager.getSelfMergeWatch(SESSION_ID)?.state).toBe("delivered");
    expireBackoff();
    await ctx.manager.retryStalledDeliveries();
    expect(ctx.runner.dispatched).toHaveLength(1);
  });

  it("a wake that genuinely never ran is still retried", async () => {
    await deliverWake();
    ctx.runner.completeTurns(turnNoResult("agent process exited without producing a turn result"));
    expect(ctx.sessionManager.getSelfMergeWatch(SESSION_ID)?.state).toBe("merge-observed");

    expireBackoff();
    await ctx.manager.retryStalledDeliveries();
    expect(ctx.runner.dispatched).toHaveLength(2);
  });

  it("a retry does not dispatch over a turn the worker reports in flight", async () => {
    await deliverWake();
    ctx.runner.completeTurns(turnNoResult("agent process exited without producing a turn result"));
    expireBackoff();

    ctx.runner.running = false;
    ctx.runner.workerTurnActive = true;
    await ctx.manager.retryStalledDeliveries();
    expect(ctx.runner.dispatched).toHaveLength(1);

    ctx.runner.workerTurnActive = false;
    await ctx.manager.retryStalledDeliveries();
    expect(ctx.runner.dispatched).toHaveLength(2);
  });
});

describe("the arm card says when its watch is gone (docs/239)", () => {
  let ctx: ReturnType<typeof makeCtx>;
  beforeEach(() => { ctx = makeCtx(); });

  const NEXT_PR = { number: 44, url: "https://github.com/o/r/pull/44", base: "main", title: "Step three" };
  const storedCards = () =>
    ctx.chatHistoryManager.load(SESSION_ID).flatMap((m) => (m.selfMergeWatch ? [m.selfMergeWatch] : []));
  const emittedCards = () =>
    ctx.runner.emitted.filter((m) => m.type === "self_merge_watch_card").map((m) => m.card as { watchId: string; ended?: string });

  it("a new card has no end, and offers Cancel", async () => {
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    expect(storedCards()).toHaveLength(1);
    expect(storedCards()[0].ended).toBeUndefined();
  });

  it("replaced: a re-arm on another PR ends the older card, in history and for live viewers", async () => {
    const first = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    ctx.livePr.value = NEXT_PR;
    const second = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);

    expect(storedCards().map((c) => [c.watchId, c.ended])).toEqual([
      [first.watchId, "replaced"],
      [second.watchId, undefined],
    ]);
    expect(emittedCards().map((c) => [c.watchId, c.ended])).toEqual([
      [first.watchId, undefined],
      [first.watchId, "replaced"],
      [second.watchId, undefined],
    ]);
  });

  it("replaced: a re-arm on the same PR ends the older card too", async () => {
    const first = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    expect(storedCards().find((c) => c.watchId === first.watchId)?.ended).toBe("replaced");
  });

  it("replaced: of two arms that run at the same time, the one that lost ends its card", async () => {
    const [a, b] = await Promise.all([
      armSelfMergeWatch(ctx.armDeps, SESSION_ID),
      armSelfMergeWatch(ctx.armDeps, SESSION_ID),
    ]);
    const current = ctx.sessionManager.getSelfMergeWatch(SESSION_ID)?.watchId;
    const lost = current === a.watchId ? b.watchId : a.watchId;

    expect(storedCards().find((c) => c.watchId === lost)?.ended).toBe("replaced");
    expect(storedCards().find((c) => c.watchId === current)?.ended).toBeUndefined();
  });

  it("replaced: a card armed and replaced inside one running turn keeps its end when the turn is rebuilt", async () => {
    ctx.runner.running = true;
    const first = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    ctx.livePr.value = NEXT_PR;
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);

    const recorded = ctx.runner.recordedCards.map((c) => c.message.selfMergeWatch as { watchId: string; ended?: string });
    expect(recorded.find((c) => c.watchId === first.watchId)?.ended).toBe("replaced");
    expect(storedCards().find((c) => c.watchId === first.watchId)?.ended).toBe("replaced");
    expect(storedCards()).toHaveLength(2);
  });

  it("cancelled: Cancel ends the card", async () => {
    const { watchId } = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    cancelSelfMergeWatch(ctx.armDeps, SESSION_ID, watchId);

    expect(storedCards()[0].ended).toBe("cancelled");
    expect(emittedCards().at(-1)).toMatchObject({ watchId, ended: "cancelled" });
  });

  it("cancelled: the card changes in history with no runner for the session", async () => {
    const { watchId } = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    const noRunner = { get: () => undefined } as unknown as SessionRunnerRegistry;
    cancelSelfMergeWatch({ ...ctx.armDeps, runnerRegistry: noRunner }, SESSION_ID, watchId);

    expect(storedCards()[0].ended).toBe("cancelled");
  });

  it("a stale Cancel changes neither card", async () => {
    const stale = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    ctx.livePr.value = NEXT_PR;
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    cancelSelfMergeWatch(ctx.armDeps, SESSION_ID, stale.watchId);

    expect(storedCards().map((c) => c.ended)).toEqual(["replaced", undefined]);
  });

  it("merged: the card ends when the wake starts, and the re-arm inside the wake does not call it replaced", async () => {
    const first = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    markMerged(ctx, 43);
    await ctx.manager.handleSelfMerge(SESSION_ID);
    expect(storedCards()[0].ended).toBe("merged");
    expect(emittedCards().at(-1)).toMatchObject({ watchId: first.watchId, ended: "merged" });

    ctx.livePr.value = NEXT_PR;
    const second = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    ctx.runner.completeTurns();

    expect(storedCards().map((c) => [c.watchId, c.ended])).toEqual([
      [first.watchId, "merged"],
      [second.watchId, undefined],
    ]);
  });

  it("closed: a PR closed without a merge ends the card", async () => {
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    await ctx.manager.handleChildPrTerminal({
      sessionId: SESSION_ID, outcome: "closed", prNumber: 43,
      prUrl: "https://github.com/o/r/pull/43", prTitle: "Step two", branch: "shipit/s1",
    });
    expect(storedCards()[0].ended).toBe("closed");
  });

  it("other-pr-merged: a merge of a different PR ends the card", async () => {
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    markMerged(ctx, 42);
    await ctx.manager.handleSelfMerge(SESSION_ID);
    expect(storedCards()[0].ended).toBe("other-pr-merged");
  });

  it("wake-failed: a wake that is given up replaces the merged end", async () => {
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    markMerged(ctx, 43);
    await ctx.manager.handleSelfMerge(SESSION_ID);
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
      ctx.runner.completeTurns(turnNoResult("agent exited without a result"));
      const watch = ctx.sessionManager.getSelfMergeWatch(SESSION_ID)!;
      if (watch.state !== "merge-observed") break;
      ctx.sessionManager.setSelfMergeWatch(SESSION_ID, { ...watch, lastAttemptAt: new Date(0).toISOString() });
      await ctx.manager.retryStalledDeliveries();
    }
    ctx.manager.stopRetryLoop();

    expect(ctx.sessionManager.getSelfMergeWatch(SESSION_ID)?.state).toBe("delivery-failed");
    expect(storedCards()[0].ended).toBe("wake-failed");
  });

  it("a card that cannot be updated does not stop the wake", async () => {
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    markMerged(ctx, 43);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(ctx.chatHistoryManager, "findSelfMergeWatchCard").mockImplementation(() => {
      throw new Error("database is locked");
    });

    await ctx.manager.handleSelfMerge(SESSION_ID);

    expect(ctx.runner.dispatched).toHaveLength(1);
    expect(errors.mock.calls.some((call) => String(call[0]).includes("[merge-watch] could not mark the arm card"))).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("a wake that every credential refuses for quota (docs/306-quota-continuation)", () => {
  let ctx: ReturnType<typeof makeCtx>;
  // The production incident: refused at 15:03, accounts reset at 17:00 and 17:20.
  const REFUSED_AT = "2026-10-11T15:03:00.000Z";
  const RESET_A = "2026-10-11T17:00:00.000Z";
  const RESET_B = "2026-10-11T17:20:00.000Z";
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse(REFUSED_AT), toFake: ["Date"] });
    ctx = makeCtx();
    // As the dispatched turn does: the prompt becomes a transcript row unless it was shown before.
    const dispatch = ctx.runner.dispatch.bind(ctx.runner);
    ctx.runner.dispatch = (opts: AgentDispatchOptions) => {
      if (!opts.promptShown) ctx.chatHistoryManager.append(SESSION_ID, { role: "user", text: opts.text });
      return dispatch(opts);
    };
  });
  afterEach(() => { vi.useRealTimers(); });

  const notes = () => ctx.chatHistoryManager.load(SESSION_ID).filter((m) => m.notice);
  const promptRows = () => ctx.chatHistoryManager.load(SESSION_ID).filter((m) => m.role === "user" && m.text.includes("#43"));
  const watch = () => ctx.sessionManager.getSelfMergeWatch(SESSION_ID);

  async function deliverWake(): Promise<void> {
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    markMerged(ctx, 43);
    await ctx.manager.handleSelfMerge(SESSION_ID);
    expect(ctx.runner.dispatched).toHaveLength(1);
  }

  // As production orders it: the turn records its end, then settles.
  function refuse(resetsAt: (string | null)[]): void {
    ctx.sessionManager.setLastTurnOutcome(SESSION_ID, "quota-refused");
    ctx.runner.completeTurns(turnQuotaRefused(resetsAt));
  }

  async function retryAt(iso: string): Promise<void> {
    vi.setSystemTime(Date.parse(iso));
    await ctx.manager.retryStalledDeliveries();
  }

  it("waits for the earliest stated reset, then wakes once, and the merge prompt is in the transcript once", async () => {
    await deliverWake();
    refuse([RESET_A, RESET_B]);

    expect(watch()?.state).toBe("merge-observed");
    expect(notes().at(-1)?.text).toContain("2026-10-11 17:01 UTC");
    // The incident spent all five attempts by 15:20.
    for (const iso of ["2026-10-11T15:05:00.000Z", "2026-10-11T15:20:00.000Z", "2026-10-11T16:30:00.000Z", "2026-10-11T17:00:30.000Z"]) {
      await retryAt(iso);
    }
    expect(ctx.runner.dispatched).toHaveLength(1);

    await retryAt("2026-10-11T17:01:00.000Z");
    expect(ctx.runner.dispatched).toHaveLength(2);
    ctx.runner.completeTurns();
    expect(watch()?.state).toBe("delivered");
    expect(promptRows()).toHaveLength(1);
  });

  it("spends no delivery attempt: a refusal after four failed attempts does not give up", async () => {
    await deliverWake();
    let now = Date.parse(REFUSED_AT);
    for (let attempt = 1; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
      ctx.runner.completeTurns(turnNoResult("agent process exited without producing a turn result"));
      now += 11 * 60_000;
      await retryAt(new Date(now).toISOString());
    }
    expect(ctx.runner.dispatched).toHaveLength(MAX_DELIVERY_ATTEMPTS);

    refuse([null]);
    expect(watch()?.state).toBe("merge-observed");

    await retryAt(new Date(now + 31 * 60_000).toISOString());
    expect(ctx.runner.dispatched).toHaveLength(MAX_DELIVERY_ATTEMPTS + 1);
    ctx.runner.completeTurns();
    expect(watch()?.state).toBe("delivered");
  });

  it("gives up after MAX_QUOTA_REFUSALS refusals, so quota that never returns cannot wake it for ever", async () => {
    await deliverWake();
    let now = Date.parse(REFUSED_AT);
    for (let refusal = 1; refusal <= MAX_QUOTA_REFUSALS; refusal++) {
      refuse([null]);
      now += 31 * 60_000;
      await retryAt(new Date(now).toISOString());
    }

    expect(watch()?.state).toBe("delivery-failed");
    expect(ctx.runner.dispatched).toHaveLength(MAX_QUOTA_REFUSALS);
    expect(notes().at(-1)?.text).toContain("could not be resumed automatically");
    await retryAt(new Date(now + 24 * 60 * 60_000).toISOString());
    expect(ctx.runner.dispatched).toHaveLength(MAX_QUOTA_REFUSALS);
  });

  it("a turn that ran since the refusal makes the wake unnecessary", async () => {
    await deliverWake();
    refuse([RESET_A]);

    vi.setSystemTime(Date.parse("2026-10-11T16:00:00.000Z"));
    ctx.sessionManager.track(SESSION_ID);
    ctx.sessionManager.setLastTurnOutcome(SESSION_ID, "ok");
    await retryAt("2026-10-11T17:05:00.000Z");

    expect(ctx.runner.dispatched).toHaveLength(1);
    expect(watch()?.state).toBe("delivered");
  });

  it("a later message that no credential could run either supersedes the wake too", async () => {
    await deliverWake();
    refuse([RESET_A]);

    vi.setSystemTime(Date.parse("2026-10-11T16:00:00.000Z"));
    ctx.sessionManager.track(SESSION_ID);
    ctx.sessionManager.setLastTurnOutcome(SESSION_ID, "quota-refused");
    await retryAt("2026-10-11T17:05:00.000Z");

    expect(ctx.runner.dispatched).toHaveLength(1);
    expect(watch()?.state).toBe("delivered");
    // That turn can have worked and then run out, so the old "reset to base" prompt is not parked.
    expect(ctx.sessionManager.consumePendingAgentNotice(SESSION_ID)).toBeUndefined();
  });

  it("waits while a turn that started since is still running, and that turn decides", async () => {
    await deliverWake();
    refuse([RESET_A]);

    vi.setSystemTime(Date.parse("2026-10-11T16:00:00.000Z"));
    ctx.sessionManager.track(SESSION_ID);
    ctx.runner.running = true;
    vi.setSystemTime(Date.parse("2026-10-11T17:05:00.000Z"));
    await ctx.manager.reconcilePending();
    expect(ctx.runner.dispatched).toHaveLength(1);
    expect(watch()?.state).toBe("merge-observed");

    ctx.runner.running = false;
    ctx.sessionManager.setLastTurnOutcome(SESSION_ID, "ok");
    await ctx.manager.reconcilePending();
    expect(ctx.runner.dispatched).toHaveLength(1);
    expect(watch()?.state).toBe("delivered");
  });

  it("waits for a turn still in setup, which has not stamped the session yet", async () => {
    await deliverWake();
    refuse([RESET_A]);

    ctx.runner.running = true;
    vi.setSystemTime(Date.parse("2026-10-11T17:05:00.000Z"));
    await ctx.manager.reconcilePending();

    expect(ctx.runner.dispatched).toHaveLength(1);
  });

  it("the wake's own next attempt is not a turn that makes it unnecessary", async () => {
    await deliverWake();
    refuse([RESET_A]);
    await retryAt("2026-10-11T17:01:00.000Z");
    expect(ctx.runner.dispatched).toHaveLength(2);

    // That attempt starts a turn, which stamps the session, and then fails for another reason.
    ctx.sessionManager.track(SESSION_ID);
    ctx.sessionManager.setLastTurnOutcome(SESSION_ID, "errored");
    ctx.runner.completeTurns(turnNoResult("agent process exited without producing a turn result"));
    await retryAt("2026-10-11T17:13:00.000Z");

    expect(ctx.runner.dispatched).toHaveLength(3);
  });

  it("a retry after a failure of another kind does not show the prompt again either", async () => {
    await deliverWake();
    ctx.runner.completeTurns(turnNoResult("agent process exited without producing a turn result"));
    await retryAt("2026-10-11T15:05:00.000Z");

    expect(ctx.runner.dispatched).toHaveLength(2);
    expect(ctx.runner.dispatched[1]!.promptShown).toBe(true);
    expect(promptRows()).toHaveLength(1);
  });

  it("a rewind that took the prompt out of the transcript shows it again", async () => {
    await deliverWake();
    refuse([RESET_A]);
    ctx.chatHistoryManager.saveMessages(SESSION_ID, []);

    await retryAt("2026-10-11T17:01:00.000Z");

    expect(ctx.runner.dispatched).toHaveLength(2);
    expect(ctx.runner.dispatched[1]!.promptShown).toBeUndefined();
    expect(promptRows()).toHaveLength(1);
  });

  it("a code rollback that marked the prompt rolled back shows it again", async () => {
    await deliverWake();
    refuse([RESET_A]);
    ctx.chatHistoryManager.markRolledBackFromIndex(SESSION_ID, 0, "abc1234");

    await retryAt("2026-10-11T17:01:00.000Z");

    expect(ctx.runner.dispatched).toHaveLength(2);
    expect(ctx.runner.dispatched[1]!.promptShown).toBeUndefined();
  });

  it("does not ask the worker about its turns while the wait holds", async () => {
    await deliverWake();
    refuse([RESET_A]);
    const probe = vi.spyOn(ctx.runner, "hasTurnInFlight");

    await retryAt("2026-10-11T16:00:00.000Z");

    expect(probe).not.toHaveBeenCalled();
  });

  it("a restart during the wait does not wake the session before the reset", async () => {
    await deliverWake();
    refuse([RESET_A]);

    const restarted = new MergeWatchManager({
      sessionManager: ctx.sessionManager,
      runnerRegistry: ctx.armDeps.runnerRegistry,
      chatHistoryManager: ctx.chatHistoryManager,
      sessionInbox: ctx.sessionInbox,
      defaultAgentId: "claude",
    });
    restarted.setPrStatusLookup((id) => ctx.sessionManager.getPrStatus(id) ?? undefined);
    vi.setSystemTime(Date.parse("2026-10-11T15:10:29.000Z"));
    await restarted.reconcilePending();
    expect(ctx.runner.dispatched).toHaveLength(1);

    vi.setSystemTime(Date.parse("2026-10-11T17:01:00.000Z"));
    await restarted.reconcilePending();
    expect(ctx.runner.dispatched).toHaveLength(2);
    restarted.stopRetryLoop();
  });

  it("a restart does not send a wake past the attempt budget, and its retry loop ends the watch", async () => {
    await deliverWake();
    const spent = watch()!;
    ctx.sessionManager.setSelfMergeWatch(SESSION_ID, {
      ...spent,
      deliveryAttempts: MAX_DELIVERY_ATTEMPTS,
      deliveryId: `${spent.watchId}:${MAX_DELIVERY_ATTEMPTS}`,
    });
    ctx.runner.activeDeliveryId = undefined;
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date", "setInterval", "clearInterval"] });
    const restarted = new MergeWatchManager({
      sessionManager: ctx.sessionManager,
      runnerRegistry: ctx.armDeps.runnerRegistry,
      chatHistoryManager: ctx.chatHistoryManager,
      sessionInbox: ctx.sessionInbox,
      defaultAgentId: "claude",
    });
    restarted.setPrStatusLookup((id) => ctx.sessionManager.getPrStatus(id) ?? undefined);

    await restarted.reconcilePending();
    expect(ctx.runner.dispatched).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(watch()?.state).toBe("delivery-failed");
    expect(ctx.runner.dispatched).toHaveLength(1);
    restarted.stopRetryLoop();
  });

  it("a delivery rebound after a restart keeps the attempts that quota refusals did not spend", async () => {
    await deliverWake();
    const current = watch()!;
    const deliveryId = `${current.watchId}:${MAX_DELIVERY_ATTEMPTS}`;
    ctx.sessionManager.setSelfMergeWatch(SESSION_ID, {
      ...current,
      deliveryAttempts: MAX_DELIVERY_ATTEMPTS,
      quotaRefusals: 1,
      deliveryId,
    });

    ctx.manager.rebindDelivery(deliveryId)!(turnNoResult("agent process exited without producing a turn result"));

    expect(watch()?.state).toBe("merge-observed");
  });
});
