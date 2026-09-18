import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { wireResetEligibleOnFileChange, type ResetEligibleWatchRunner } from "./reset-eligible-watch.js";
import type { GitManager } from "../shared/git.js";
import type { SessionInfo } from "../shared/types.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { WsServerMessage } from "../shared/types/ws-server-messages.js";

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
    isAncestor: vi.fn().mockResolvedValue(false),
    ...over,
  } as unknown as GitManager;
}

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

function gatedGit(): { git: GitManager; release: () => void } {
  let release = (): void => {};
  const gate = new Promise<void>((r) => { release = r; });
  return {
    git: makeGit({ isClean: vi.fn(async () => { await gate; return true; }) }),
    release: () => release(),
  };
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

  it("re-pushes an unchanged value, because an unconditional emitter may have overwritten the client", async () => {
    const isClean = vi.fn().mockResolvedValue(false);
    const { runner } = wire({ git: makeGit({ isClean }) });

    runner.changed();
    await settle();
    runner.changed();
    await settle();
    runner.changed();
    await settle();

    expect(runner.emitted).toHaveLength(3);
    expect(runner.emitted.every((m) => m.type === "reset_eligible" && !m.eligible)).toBe(true);
  });

  it("fires at the max-wait ceiling instead of starving under a continuous writer", async () => {
    const { runner, createGitManager } = wire();
    for (let i = 0; i < 30; i++) {
      runner.changed([`src/f${i}.ts`]);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(runner.emitted.length).toBeGreaterThanOrEqual(2);
    expect(createGitManager).toHaveBeenCalledTimes(runner.emitted.length);
  });

  it("re-runs after an in-flight recompute rather than dropping the change behind it", async () => {
    const { git, release } = gatedGit();
    const { runner, createGitManager } = wire({ git });

    runner.changed();
    await settle();
    expect(createGitManager).toHaveBeenCalledTimes(1);

    runner.changed();
    await settle();
    expect(createGitManager).toHaveBeenCalledTimes(1);

    release();
    await settle();
    expect(createGitManager).toHaveBeenCalledTimes(2);
    expect(runner.emitted).toHaveLength(2);
  });

  it("cancels a pending recompute when the runner is disposed", async () => {
    const { runner, createGitManager } = wire();
    runner.changed();
    runner.emit("disposed");
    await settle();
    expect(createGitManager).not.toHaveBeenCalled();
    expect(runner.emitted).toEqual([]);
  });

  it("a dispose DURING an in-flight recompute suppresses the push and the follow-up", async () => {
    const { git, release } = gatedGit();
    const { runner, createGitManager } = wire({ git });

    runner.changed();
    await settle();
    runner.changed();
    runner.emit("disposed");
    release();
    await settle();

    expect(runner.emitted).toEqual([]);
    expect(createGitManager).toHaveBeenCalledTimes(1);
  });

  it("restores the one max-listener slot its permanent listener consumes", () => {
    const runner = new FakeRunner();
    expect(runner.getMaxListeners()).toBe(EventEmitter.defaultMaxListeners);
    wireResetEligibleOnFileChange(
      { getSession: () => makeSession(), getPrStatus: () => makePrStatus(), createGitManager: () => makeGit() },
      runner,
    );
    expect(runner.getMaxListeners()).toBe(EventEmitter.defaultMaxListeners + 1);
  });

  it("is fail-safe: a git throw neither emits nor escapes the timer callback", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const git = makeGit({ isClean: vi.fn().mockRejectedValue(new Error("git boom")) });
    const { runner } = wire({ git });
    runner.changed();
    await settle();
    expect(runner.emitted).toEqual([{ type: "reset_eligible", sessionId: "s1", eligible: false }]);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
