import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { ChatHistoryManager } from "./chat-history.js";
import { MergeWatchManager } from "./merge-watch.js";
import type { SessionRunnerInterface, SessionRunnerRegistry, AgentDispatchOptions } from "./session-runner.js";
import type { PrTerminalStateInfo } from "./pr-status-poller.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";

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
 */
class FakeRunner {
  running = false;
  disposed = false;
  agentId = "claude" as const;
  dispatched: AgentDispatchOptions[] = [];
  emitted: unknown[] = [];
  autoCompleteTurn = true;
  private pendingComplete: (() => void)[] = [];
  constructor(public sessionDir: string) {}
  dispatch(opts: AgentDispatchOptions): void {
    this.dispatched.push(opts);
    if (!opts.onTurnComplete) return;
    const fire = () => opts.onTurnComplete!({ errored: false });
    // Busy parent → enqueued, runs (and completes) only on drain. Idle parent →
    // starts now (unless the test holds it via `autoCompleteTurn = false`).
    if (this.running || !this.autoCompleteTurn) { this.pendingComplete.push(fire); return; }
    fire();
  }
  /** Simulate held/queued wake-turns draining to completion. */
  completeTurn(): void {
    const pending = this.pendingComplete;
    this.pendingComplete = [];
    for (const fire of pending) fire();
  }
  emitMessage(msg: unknown): void { this.emitted.push(msg); }
}

function makeFakeRegistry(): { registry: SessionRunnerRegistry; runners: Map<string, FakeRunner> } {
  const runners = new Map<string, FakeRunner>();
  const registry = {
    get: (id: string) => runners.get(id) as unknown as SessionRunnerInterface | undefined,
    getOrCreate: (id: string, dir: string) => {
      let r = runners.get(id);
      if (!r) { r = new FakeRunner(dir); runners.set(id, r); }
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
  const { registry, runners } = makeFakeRegistry();
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
  return { sessionManager, chatHistoryManager, registry, runners, manager };
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
    expect(parentRunner?.dispatched[0].text).toContain("MERGED");
    expect(parentRunner?.dispatched[0].text).toContain("child");
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
    expect(parentRunner?.dispatched[0].text).toContain("CLOSED WITHOUT MERGING");
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

    // Restart: the queued turn was lost (no `completeTurn()`), parent idle again.
    parentRunner.running = false;
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
});
