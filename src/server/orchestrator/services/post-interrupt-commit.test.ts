import { describe, it, expect, vi } from "vitest";
import { runPostInterruptCommit, type PostInterruptCommitDeps } from "./post-interrupt-commit.js";
import type { SessionRunnerInterface } from "../session-runner.js";
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
