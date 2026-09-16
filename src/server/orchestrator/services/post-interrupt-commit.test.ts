import { describe, it, expect, vi } from "vitest";
import {
  runPostInterruptCommit,
  postInterruptCommitDepsFrom,
  type PostInterruptCommitDeps,
} from "./post-interrupt-commit.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import { withWorkspaceLock } from "./marketplace.js";
import type { SessionInfo, WorkspaceBlockKind } from "../../shared/types.js";

/**
 * docs/298-broken-workspace-visibility req 6 — the interrupt fallback is a real
 * clearing path: an agent that aborts the rebase and is then interrupted never
 * reaches the ordinary post-turn commit, so this is the run that withdraws the
 * marker. It must publish the change like every other one.
 */
describe("runPostInterruptCommit — broken-workspace marker", () => {
  function harness(block: WorkspaceBlockKind | undefined) {
    let stored = block;
    const sseBroadcast = vi.fn();
    const deps = {
      sessionManager: {
        get: vi.fn(() => ({ id: "s1", ...(stored ? { workspaceBlock: stored } : {}) } as SessionInfo)),
        list: vi.fn(() => [{ id: "s1" } as SessionInfo]),
        setWorkspaceBlock: vi.fn((_id: string, kind: WorkspaceBlockKind | null) => {
          if (stored === (kind ?? undefined)) return false;
          stored = kind ?? undefined;
          return true;
        }),
        getSecretBlock: vi.fn(() => undefined),
        setSecretBlock: vi.fn(),
      },
      chatHistoryManager: { updateLastMessage: vi.fn(() => null), indexOfMessageId: vi.fn(() => -1), append: vi.fn() },
      createGitManager: vi.fn(() => ({
        // No commit: an already-repaired tree has nothing left to record.
        autoCommit: vi.fn(async () => ({
          commitHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [],
        })),
        getHeadHash: vi.fn(async () => "head"),
        isRebaseInProgress: vi.fn(async () => false),
        isMergeOrSequencerInProgress: vi.fn(async () => false),
      })),
      sseBroadcast,
    } as unknown as PostInterruptCommitDeps;
    const runner = {
      sessionId: "s1",
      sessionDir: "/workspace",
      disposed: false,
      turnSummary: "aborted the rebase",
      emitMessage: vi.fn(),
    } as unknown as SessionRunnerInterface;
    return { deps, runner, sseBroadcast, blockNow: () => stored };
  }

  it("clears the marker and publishes the new session list", async () => {
    const { deps, runner, sseBroadcast, blockNow } = harness("conflict");
    await runPostInterruptCommit({ deps, runner });
    expect(blockNow()).toBeUndefined();
    expect(sseBroadcast).toHaveBeenCalledWith("session_list", { sessions: [{ id: "s1" }] });
  });

  it("publishes nothing when there was no marker", async () => {
    const { deps, runner, sseBroadcast } = harness(undefined);
    await runPostInterruptCommit({ deps, runner });
    expect(sseBroadcast).not.toHaveBeenCalled();
  });
});

describe("postInterruptCommitDepsFrom", () => {
  const complete = {
    prStatusPoller: {},
    sessionManager: {},
    chatHistoryManager: {},
    githubAuthManager: {},
    credentialStore: {},
    generateText: () => "",
    createGitManager: () => ({}),
  } as unknown as Parameters<typeof postInterruptCommitDepsFrom>[0];

  // Every call site assembled this by hand and every one forgot the push, so an
  // interrupted turn committed and then sat unpushed forever.
  it("carries scheduleAutoPush through, so an interrupted turn's commit still reaches the remote", () => {
    const scheduleAutoPush = vi.fn();
    const built = postInterruptCommitDepsFrom({ ...complete, scheduleAutoPush });
    expect(built.postInterruptCommitDeps?.scheduleAutoPush).toBe(scheduleAutoPush);
  });

  it("carries sseBroadcast through", () => {
    const sseBroadcast = vi.fn();
    const built = postInterruptCommitDepsFrom({ ...complete, sseBroadcast });
    expect(built.postInterruptCommitDeps?.sseBroadcast).toBe(sseBroadcast);
  });

  it("builds nothing without a PR poller, leaving the commit optional", () => {
    const { prStatusPoller: _omitted, ...withoutPoller } = complete as Record<string, unknown>;
    expect(postInterruptCommitDepsFrom(withoutPoller)).toEqual({});
  });
});

/**
 * The entry `if (runner.disposed) return` is checked before the workspace lock.
 * A restart's flush that loses a race for that lock can win it after the runner
 * has been replaced — and then `git add -A` sweeps the replacement's edits into
 * a commit carrying the dead turn's summary.
 */
describe("runPostInterruptCommit — a flush that outlives its runner", () => {
  function harness() {
    const autoCommit = vi.fn(async () => ({
      commitHash: "abc1234", parentHash: null, conflictedFiles: [],
      rebaseInProgress: false, secretFindings: [], unreadable: null,
    }));
    const runner = {
      sessionId: "s1",
      sessionDir: "/tmp/flush-race",
      turnSummary: "the dead turn",
      disposed: false,
      emitMessage: vi.fn(),
    } as unknown as SessionRunnerInterface;
    const deps = {
      sessionManager: {
        get: vi.fn(() => ({ id: "s1" } as SessionInfo)),
        getPrStatus: vi.fn(() => null),
        getSecretBlock: vi.fn(() => undefined),
        setSecretBlock: vi.fn(),
        setWorkspaceBlock: vi.fn(() => false),
      },
      chatHistoryManager: { updateLastMessage: vi.fn(() => null), indexOfMessageId: vi.fn(() => -1), append: vi.fn() },
      createGitManager: vi.fn(() => ({
        autoCommit,
        getHeadHash: vi.fn(async () => "head1"),
        currentBranchOrNull: vi.fn(async () => "shipit/abc"),
        aheadBehind: vi.fn(async () => ({ ahead: 0, behind: 0 })),
        isRebaseInProgress: vi.fn(async () => false),
        isMergeOrSequencerInProgress: vi.fn(async () => false),
      })),
      prStatusPoller: {},
      githubAuthManager: {},
      credentialStore: {},
      generateText: vi.fn(async () => ""),
      scheduleAutoPush: vi.fn(),
    } as unknown as PostInterruptCommitDeps;
    return { deps, runner, autoCommit };
  }

  // Contend for the real lock, which is what a restart's flush does.
  async function flushBehindTheLock(
    deps: PostInterruptCommitDeps,
    runner: SessionRunnerInterface,
    whileHeld: () => void,
  ): Promise<void> {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holder = withWorkspaceLock(runner.sessionDir, () => held);
    const flush = runPostInterruptCommit({ deps, runner });
    whileHeld();
    release();
    await holder;
    await flush;
  }

  it("commits when its runner is still the live one", async () => {
    const { deps, runner, autoCommit } = harness();
    await flushBehindTheLock(deps, runner, () => {});
    expect(autoCommit).toHaveBeenCalledTimes(1);
  });

  it("abandons the commit when the runner was replaced while it waited", async () => {
    const { deps, runner, autoCommit } = harness();
    await flushBehindTheLock(deps, runner, () => {
      (runner as { disposed: boolean }).disposed = true;
    });
    expect(autoCommit).not.toHaveBeenCalled();
  });
});
