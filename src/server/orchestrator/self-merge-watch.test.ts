/**
 * docs/239 — self-merge wake: arm, cancel, and delivery.
 *
 * The feature is docs/196's merge-watch pointed back at the same session, so the
 * tests here pin only what is genuinely new — one each, not a matrix. Every one
 * of them corresponds to a race a review round actually found:
 *
 *   - the arm must read the PR from a LIVE lookup, because at a chain boundary
 *     the `pr_status` snapshot still describes the previous, just-merged PR;
 *   - delivery fires from the merge callback, after the merge bookkeeping;
 *   - a merged PR that isn't the anchor is a note, not a wake;
 *   - a settlement from the PREVIOUS link must not mark the NEW watch delivered;
 *   - a Cancel from a stale card must not cancel the current watch.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { ChatHistoryManager } from "./chat-history.js";
import { MergeWatchManager } from "./merge-watch.js";
import { armSelfMergeWatch, cancelSelfMergeWatch } from "./services/self-merge-watch.js";
import { ServiceError } from "./services/types.js";
import { createTurnSettlement, TURN_COMPLETED, type TurnHandle, type TurnOutcome } from "./turn-settlement.js";
import type { AgentDispatchOptions, SessionRunnerInterface, SessionRunnerRegistry } from "./session-runner.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { GitManager } from "../shared/git.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { PrTerminalStateInfo } from "./pr-status-poller.js";

const SESSION_ID = "s1";

/** Minimal runner: records dispatches and the emitted WS messages. */
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
  /** SHI-264 — the delivery of the held wake-turn, so liveness is derivable. */
  activeDeliveryId: string | undefined;
  private pending: ((o: TurnOutcome) => void)[] = [];

  dispatch(opts: AgentDispatchOptions): TurnHandle {
    this.dispatched.push(opts);
    const settlement = createTurnSettlement();
    if (opts.deliveryId !== undefined) this.activeDeliveryId = opts.deliveryId;
    if (opts.onTurnComplete) this.pending.push(opts.onTurnComplete);
    return settlement;
  }
  hasDelivery(deliveryId: string): boolean { return this.activeDeliveryId === deliveryId; }
  /** Settle every held wake-turn — models the turn actually running. */
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

  // The LIVE open-PR lookup the arm must use. Distinct from the `pr_status`
  // snapshot on purpose — the two disagree at a chain boundary.
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

/** Mark the session merged exactly as the poller does before `onMergeDetectedCb`. */
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
    // The chain boundary: the previous PR (#42) just merged and its snapshot is
    // still what `pr_status` holds — the poller skips a session in
    // `mergedSessions`, and `gh pr create` returns before awaiting a refresh. The
    // live lookup already sees the new PR (#43).
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
    // Simulate the wake turn running: the watch is `merge-observed` when the
    // agent re-arms for the next PR. An idempotent "already armed" would make
    // chaining impossible.
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
    // The prompt is self-describing and leads with the reset.
    expect(ctx.runner.dispatched[0]!.text).toContain("#43");
    expect(ctx.runner.dispatched[0]!.text).toContain("shipit branch reset-to-base");

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
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID); // anchored to #43
    markMerged(ctx, 42); // a docs/202 re-arm replaced the work; #42 merged instead

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
    // The chain's core race: the wake turn re-arms for the NEXT PR before it
    // settles, so the old settlement arrives against a watch that is already a
    // different one.
    await armSelfMergeWatch(ctx.armDeps, SESSION_ID);
    markMerged(ctx, 43);
    await ctx.manager.handleSelfMerge(SESSION_ID);
    expect(ctx.runner.dispatched).toHaveLength(1);

    // The turn opens PR #44 and re-arms — still mid-turn.
    ctx.livePr.value = { number: 44, url: "https://github.com/o/r/pull/44", base: "main", title: "Step three" };
    const next = await armSelfMergeWatch(ctx.armDeps, SESSION_ID);

    // NOW the old turn finishes.
    ctx.runner.completeTurns();

    const watch = ctx.sessionManager.getMergeWatch(SESSION_ID)!;
    expect(watch.watchId).toBe(next.watchId);
    expect(watch.state).toBe("armed"); // NOT "delivered"
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
    // The merge landed while the orchestrator was down: the watch is still
    // `armed` and nothing in memory knows about it.
    await ctx.manager.reconcilePending();
    expect(ctx.runner.dispatched).toHaveLength(1);
  });
});
