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
 * Models the real runner's turn-completion contract: a dispatch that carries an
 * `onTurnComplete` callback represents a turn that STARTS NOW (the idle path),
 * so by default the fake fires that callback immediately to simulate the turn
 * running to completion. Set `autoCompleteTurn = false` to hold the callback
 * (`completeTurn()` fires it later) — that models the gap between a turn being
 * dispatched and actually finishing, where a restart would strand it.
 */
class FakeRunner {
  running = false;
  disposed = false;
  agentId = "claude" as const;
  dispatched: AgentDispatchOptions[] = [];
  emitted: unknown[] = [];
  autoCompleteTurn = true;
  private pendingComplete: (() => void) | undefined;
  constructor(public sessionDir: string) {}
  dispatch(opts: AgentDispatchOptions): void {
    this.dispatched.push(opts);
    if (!opts.onTurnComplete) return;
    const fire = () => opts.onTurnComplete!({ errored: false });
    if (this.autoCompleteTurn) fire();
    else this.pendingComplete = fire;
  }
  /** Simulate the held wake-turn finishing (manual-completion mode). */
  completeTurn(): void {
    const fire = this.pendingComplete;
    this.pendingComplete = undefined;
    fire?.();
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

  it("busy parent: wake-turn enqueued stays merge-observed; reconcile re-delivers without a second card", async () => {
    arm(ctx.sessionManager);
    // Mid-turn parent → dispatch enqueues; there is no completion signal.
    const parentRunner = ctx.registry.getOrCreate("parent", "/ws/parent", "claude") as unknown as FakeRunner;
    parentRunner.running = true;

    await ctx.manager.handleChildPrTerminal(MERGED);

    // Enqueued + card surfaced, but the queued turn lives only in memory, so the
    // watch must remain recoverable: NOT delivered.
    expect(parentRunner.dispatched).toHaveLength(1);
    expect(ctx.sessionManager.getMergeWatch("child")?.state).toBe("merge-observed");
    expect(ctx.chatHistoryManager.load("parent").filter((m) => m.childMerged)).toHaveLength(1);

    // Simulate the restart: the in-memory queued turn was lost; the parent is
    // idle again. `reconcilePending` re-derives the terminal PR and re-delivers.
    parentRunner.running = false;
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

    // Re-delivered to completion now — and NO second card surfaced (the
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
