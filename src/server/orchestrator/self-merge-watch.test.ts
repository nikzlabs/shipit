import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { ChatHistoryManager } from "./chat-history.js";
import { MergeWatchManager } from "./merge-watch.js";
import { armSelfMergeWatch, cancelSelfMergeWatch } from "./services/self-merge-watch.js";
import { ServiceError } from "./services/types.js";
import {
  createTurnSettlement,
  TURN_COMPLETED,
  turnInterrupted,
  turnNoResult,
  type TurnHandle,
  type TurnOutcome,
} from "./turn-settlement.js";
import type { AgentDispatchOptions, SessionRunnerInterface, SessionRunnerRegistry } from "./session-runner.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { GitManager } from "../shared/git.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { PrTerminalStateInfo } from "./pr-status-poller.js";

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

  const manager = new MergeWatchManager({
    sessionManager,
    runnerRegistry,
    chatHistoryManager,
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

  return { db, sessionManager, chatHistoryManager, runner, manager, armDeps, livePr };
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
    expect(ctx.sessionManager.getMergeWatch(SESSION_ID)).toBeUndefined();
  });

  it("anchors to the LIVE open PR, not the stale pr_status snapshot", async () => {
    ctx.sessionManager.setPrStatus(SESSION_ID, makePrStatus({ prNumber: 42, prState: "merged" }));
    const result = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    expect(result.prNumber).toBe(43);
    expect(ctx.sessionManager.getMergeWatch(SESSION_ID)?.prNumber).toBe(43);
  });

  it("refuses while a genuine parent→child watch holds the row", async () => {
    ctx.sessionManager.setMergeWatch(SESSION_ID, {
      parentSessionId: "some-parent",
      state: "armed",
      registeredAt: "t0",
    });
    await expect(armSelfMergeWatch(ctx.armDeps, SESSION_ID)).rejects.toThrow(/parent session/i);
  });

  it("always REPLACES an existing self-watch, including one mid-delivery", async () => {
    const first = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    const observed = ctx.sessionManager.getMergeWatch(SESSION_ID)!;
    ctx.sessionManager.setMergeWatch(SESSION_ID, { ...observed, state: "merge-observed" });
    ctx.livePr.value = { number: 44, url: "https://github.com/o/r/pull/44", base: "main", title: "Step three" };

    const second = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    expect(second.replaced).toBe(true);
    expect(second.watchId).not.toBe(first.watchId);
    const watch = ctx.sessionManager.getMergeWatch(SESSION_ID)!;
    expect(watch.state).toBe("armed");
    expect(watch.prNumber).toBe(44);
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
    expect(ctx.sessionManager.getMergeWatch(SESSION_ID)).toBeUndefined();
  });

  it("a stale card's Cancel does NOT cancel the newer watch", async () => {
    const stale = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    ctx.livePr.value = { number: 44, url: "https://github.com/o/r/pull/44", base: "main", title: "Step three" };
    const current = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);

    expect(cancelSelfMergeWatch(ctx.armDeps, SESSION_ID, stale.watchId))
      .toEqual({ cancelled: false, reason: "superseded" });
    expect(ctx.sessionManager.getMergeWatch(SESSION_ID)?.watchId).toBe(current.watchId);
  });
});

describe("delivering a self merge wake (docs/239)", () => {
  let ctx: ReturnType<typeof makeCtx>;
  beforeEach(() => { ctx = makeCtx(); });

  it("fires from the merge callback, after the merge bookkeeping is persisted", async () => {
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    markMerged(ctx, 43);

    await ctx.manager.handleSelfMerge(SESSION_ID);

    expect(ctx.sessionManager.getMergeWatch(SESSION_ID)?.state).toBe("merge-observed");
    expect(ctx.runner.dispatched).toHaveLength(1);
    expect(ctx.runner.dispatched[0]!.systemTurn).toBe(true);
    expect(ctx.runner.dispatched[0]!.text).toContain("#43");
    expect(ctx.runner.dispatched[0]!.text).toContain("shipit branch reset-to-base");
    expect(ctx.runner.dispatched[0]!.text.length).toBeLessThan(500);

    ctx.runner.completeTurns();
    expect(ctx.sessionManager.getMergeWatch(SESSION_ID)?.state).toBe("delivered");
  });

  it("does NOT wake from the earlier onPrTerminalState hook (it races branch deletion)", async () => {
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    const info: PrTerminalStateInfo = {
      sessionId: SESSION_ID, outcome: "merged", prNumber: 43,
      prUrl: "https://github.com/o/r/pull/43", prTitle: "Step two", branch: "shipit/s1",
    };
    await ctx.manager.handleChildPrTerminal(info);
    expect(ctx.runner.dispatched).toHaveLength(0);
    expect(ctx.sessionManager.getMergeWatch(SESSION_ID)?.state).toBe("armed");
  });

  it("an anchor mismatch appends a note and wakes nothing", async () => {
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    markMerged(ctx, 42);

    await ctx.manager.handleSelfMerge(SESSION_ID);

    expect(ctx.runner.dispatched).toHaveLength(0);
    expect(ctx.sessionManager.getMergeWatch(SESSION_ID)).toBeUndefined();
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
    expect(ctx.sessionManager.getMergeWatch(SESSION_ID)).toBeUndefined();
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

    const watch = ctx.sessionManager.getMergeWatch(SESSION_ID)!;
    expect(watch.watchId).toBe(next.watchId);
    expect(watch.state).toBe("armed");
  });

  it("restores an evicted checkout before waking", async () => {
    const restoreWorkspace = vi.fn(async () => true);
    const manager = new MergeWatchManager({
      sessionManager: ctx.sessionManager,
      runnerRegistry: ctx.armDeps.runnerRegistry,
      chatHistoryManager: ctx.chatHistoryManager,
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
    const watch = ctx.sessionManager.getMergeWatch(SESSION_ID)!;
    ctx.sessionManager.setMergeWatch(SESSION_ID, {
      ...watch,
      lastAttemptAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
  }

  it("an interrupted wake turn is terminal — the retry supervisor never re-sends it", async () => {
    await deliverWake();

    ctx.runner.completeTurns(turnInterrupted("the turn was interrupted before it produced a result"));

    expect(ctx.sessionManager.getMergeWatch(SESSION_ID)?.state).toBe("delivered");
    expireBackoff();
    await ctx.manager.retryStalledDeliveries();
    expect(ctx.runner.dispatched).toHaveLength(1);
  });

  it("a wake that genuinely never ran is still retried", async () => {
    await deliverWake();
    ctx.runner.completeTurns(turnNoResult("agent process exited without producing a turn result"));
    expect(ctx.sessionManager.getMergeWatch(SESSION_ID)?.state).toBe("merge-observed");

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
