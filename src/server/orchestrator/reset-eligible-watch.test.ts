import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { wireResetEligibleOnFileChange, type ResetEligibleWatchRunner } from "./reset-eligible-watch.js";
import type { GitManager } from "../shared/git.js";
import type { SessionInfo } from "../shared/types.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { WsServerMessage } from "../shared/types/ws-server-messages.js";

/**
 * planning#341 — the composer's "start from the latest base" control was painted from
 * a signal computed at three moments and never again, so anything that dirtied
 * the working tree in between left the UI promising an operation the pre-turn
 * gate would refuse with `dirty-tree`. These pin the file-watcher recompute that
 * closes it — and the three gates that keep a chatty watcher from shelling out
 * to git on every session.
 */

const MERGED_SHA = "a1f3c9d0000000000000000000000000000000aa";
const DEBOUNCE = 750;

function makeSession(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    title: "Fix login redirect",
    createdAt: "2026-06-01T00:00:00.000Z",
    lastUsedAt: "2026-06-01T00:00:00.000Z",
    remoteUrl: "https://github.com/o/r.git",
    branch: "shipit/fix-login",
    mergedAt: "2026-06-02 12:00:00",
    mergedHeadSha: MERGED_SHA,
    ...over,
  };
}

function makePrStatus(): PrStatusSummary {
  return {
    sessionId: "s1",
    prNumber: 482,
    prUrl: "https://github.com/o/r/pull/482",
    prTitle: "Fix login redirect",
    prBody: "",
    prState: "merged",
    baseBranch: "main",
    headBranch: "shipit/fix-login",
    insertions: 1,
    deletions: 0,
    checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
    mergeable: "unknown",
    reviewDecision: "none",
    autoMergeEnabled: false,
  };
}

function makeGit(over: Partial<Record<keyof GitManager, unknown>> = {}): GitManager {
  return {
    isClean: vi.fn().mockResolvedValue(true),
    uncommittedPaths: vi.fn().mockResolvedValue([]),
    currentBranchOrNull: vi.fn().mockResolvedValue("shipit/fix-login"),
    isRebaseInProgress: vi.fn().mockResolvedValue(false),
    isMergeOrSequencerInProgress: vi.fn().mockResolvedValue(false),
    getHeadHash: vi.fn().mockResolvedValue(MERGED_SHA),
    ...over,
  } as unknown as GitManager;
}

/** The slice of a runner the watcher touches, over a bare EventEmitter. */
class FakeRunner extends EventEmitter implements ResetEligibleWatchRunner {
  sessionId = "s1";
  sessionDir = "/ws";
  running = false;
  emitted: WsServerMessage[] = [];
  emitMessage(msg: WsServerMessage): void {
    this.emitted.push(msg);
  }
  changed(paths = ["src/app.ts"]): void {
    this.emit("message", { type: "files_changed", paths } as WsServerMessage);
  }
}

function wire(over: {
  session?: SessionInfo | undefined;
  git?: GitManager;
} = {}) {
  const runner = new FakeRunner();
  const createGitManager = vi.fn(() => over.git ?? makeGit());
  wireResetEligibleOnFileChange(
    {
      getSession: () => ("session" in over ? over.session : makeSession()),
      getPrStatus: () => makePrStatus(),
      createGitManager,
    },
    runner,
  );
  return { runner, createGitManager };
}

/** Fire the debounce and let the async recompute settle. */
async function settle(ms = DEBOUNCE + 10): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("wireResetEligibleOnFileChange", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("pushes a fresh signal after the workspace changes", async () => {
    const { runner } = wire();
    runner.changed();
    await settle();
    expect(runner.emitted).toEqual([{ type: "reset_eligible", sessionId: "s1", eligible: true }]);
  });

  it("turns the control off the moment the tree goes dirty — the false promise this fixes", async () => {
    const isClean = vi.fn().mockResolvedValue(false);
    const { runner } = wire({ git: makeGit({ isClean }) });
    runner.changed(["src/approved.json"]);
    await settle();
    expect(runner.emitted).toEqual([{ type: "reset_eligible", sessionId: "s1", eligible: false }]);
  });

  it("debounces a burst into a single recompute", async () => {
    const { runner, createGitManager } = wire();
    for (let i = 0; i < 20; i++) {
      runner.changed([`src/f${i}.ts`]);
      await vi.advanceTimersByTimeAsync(50);
    }
    await settle();
    expect(createGitManager).toHaveBeenCalledTimes(1);
    expect(runner.emitted).toHaveLength(1);
  });

  it("does not touch git for a session with no merged pull request", async () => {
    const s = makeSession();
    delete s.mergedAt;
    const { runner, createGitManager } = wire({ session: s });
    runner.changed();
    await settle();
    expect(createGitManager).not.toHaveBeenCalled();
    expect(runner.emitted).toEqual([]);
  });

  it("skips while a turn is running — the agent rewrites files and post-turn recomputes anyway", async () => {
    const { runner, createGitManager } = wire();
    runner.running = true;
    runner.changed();
    await settle();
    expect(createGitManager).not.toHaveBeenCalled();
    expect(runner.emitted).toEqual([]);
  });

  it("stays silent while the answer is unchanged, and speaks up on a transition", async () => {
    const isClean = vi.fn().mockResolvedValue(true);
    const { runner } = wire({ git: makeGit({ isClean }) });

    runner.changed();
    await settle();
    expect(runner.emitted).toHaveLength(1);

    // Same answer twice more — a watcher firing against an unchanging fact
    // should not fill the WS stream or the log.
    runner.changed();
    await settle();
    runner.changed();
    await settle();
    expect(runner.emitted).toHaveLength(1);

    // Now the tree goes dirty: that IS news.
    isClean.mockResolvedValue(false);
    runner.changed();
    await settle();
    expect(runner.emitted).toHaveLength(2);
    expect(runner.emitted[1]).toEqual({ type: "reset_eligible", sessionId: "s1", eligible: false });
  });

  it("cancels a pending recompute when the runner is disposed", async () => {
    const { runner, createGitManager } = wire();
    runner.changed();
    runner.emit("disposed");
    await settle();
    expect(createGitManager).not.toHaveBeenCalled();
    expect(runner.emitted).toEqual([]);
  });

  it("is fail-safe: a git throw neither emits nor escapes the timer callback", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const git = makeGit({ isClean: vi.fn().mockRejectedValue(new Error("git boom")) });
    const { runner } = wire({ git });
    runner.changed();
    await settle();
    // `computeResetEligibility` swallows to false, so the honest signal is "not
    // eligible" rather than a crashed timer.
    expect(runner.emitted).toEqual([{ type: "reset_eligible", sessionId: "s1", eligible: false }]);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
