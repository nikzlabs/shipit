import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrStatusSummary } from "../shared/types.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { SessionRunnerInterface } from "./session-runner.js";

const { emitChatCard, emitNoticePostTurn } = vi.hoisted(() => ({
  emitChatCard: vi.fn(),
  emitNoticePostTurn: vi.fn(),
}));

vi.mock("./chat-card-persistence.js", () => ({ emitChatCard, emitNoticePostTurn }));

import {
  presentExplicitResetSuccess,
  recordManualResetAgentNotice,
  reportSyncFailure,
} from "./api-routes-git.js";
import { markSyncFailureExplained } from "./services/rebase-driver.js";

const prStatus: PrStatusSummary = {
  sessionId: "session-1",
  prNumber: 1798,
  prUrl: "https://example.test/pull/1798",
  prTitle: "Test self-merge wake notification",
  prBody: "",
  prState: "merged",
  baseBranch: "main",
  headBranch: "shipit/test",
  insertions: 1,
  deletions: 0,
  mergeable: "mergeable",
  reviewDecision: "none",
  autoMergeEnabled: false,
  checks: { state: "success", total: 0, passed: 0, failed: 0, pending: 0 },
};

describe("presentExplicitResetSuccess", () => {
  beforeEach(() => emitChatCard.mockClear());

  it("clears composer eligibility, re-arms PR state, and persists the branch-updated card", async () => {
    const emitMessage = vi.fn();
    const reArmResetSession = vi.fn(async () => {});
    const runner = { emitMessage } as unknown as SessionRunnerInterface;
    const chatHistoryManager = {} as ChatHistoryManager;

    await presentExplicitResetSuccess({
      runner,
      chatHistoryManager,
      sessionId: "session-1",
      prStatus,
      outcome: {
        outcome: "reset",
        base: "main",
        fromSha: "aaaaaaaaaaaaaaaa",
        toSha: "bbbbbbbbbbbbbbbb",
      },
      reArmResetSession,
    });

    expect(emitMessage).toHaveBeenCalledWith({
      type: "reset_eligible",
      sessionId: "session-1",
      eligible: false,
    });
    expect(reArmResetSession).toHaveBeenCalledOnce();
    expect(emitChatCard).toHaveBeenCalledOnce();
    expect(emitChatCard.mock.calls[0]?.[1]).toMatchObject({
      type: "branch_auto_reset_card",
      sessionId: "session-1",
      card: {
        base: "main",
        prNumber: 1798,
        fromSha: "aaaaaaaaaaaaaaaa",
        toSha: "bbbbbbbbbbbbbbbb",
      },
    });
  });

  it("does not change UI state when the guarded reset refuses", async () => {
    const emitMessage = vi.fn();
    const reArmResetSession = vi.fn(async () => {});

    await presentExplicitResetSuccess({
      runner: { emitMessage } as unknown as SessionRunnerInterface,
      chatHistoryManager: {} as ChatHistoryManager,
      sessionId: "session-1",
      prStatus,
      outcome: { outcome: "refused", reason: "dirty tree" },
      reArmResetSession,
    });

    expect(emitMessage).not.toHaveBeenCalled();
    expect(reArmResetSession).not.toHaveBeenCalled();
    expect(emitChatCard).not.toHaveBeenCalled();
  });
});

describe("recordManualResetAgentNotice", () => {
  const resetOutcome = {
    outcome: "reset" as const,
    base: "main",
    fromSha: "aaaaaaaaaaaaaaaa",
    toSha: "bbbbbbbbbbbbbbbb",
  };

  it("parks a notice when the reset came from the UI (no turn running)", () => {
    const setPendingAgentNotice = vi.fn();
    recordManualResetAgentNotice({
      setPendingAgentNotice,
      runner: { running: false } as unknown as SessionRunnerInterface,
      sessionId: "session-1",
      outcome: resetOutcome,
      prNumber: 1798,
    });

    expect(setPendingAgentNotice).toHaveBeenCalledOnce();
    const [sessionId, notice] = setPendingAgentNotice.mock.calls[0] as [string, string];
    expect(sessionId).toBe("session-1");
    expect(notice).toContain("[System]");
    expect(notice).toContain("origin/main");
    expect(notice).toContain("#1798");
  });

  it("stays silent when the agent itself ran the reset mid-turn", () => {
    const setPendingAgentNotice = vi.fn();
    recordManualResetAgentNotice({
      setPendingAgentNotice,
      runner: { running: true } as unknown as SessionRunnerInterface,
      sessionId: "session-1",
      outcome: resetOutcome,
    });
    expect(setPendingAgentNotice).not.toHaveBeenCalled();
  });

  it("stays silent when nothing moved", () => {
    const setPendingAgentNotice = vi.fn();
    for (const outcome of [
      { outcome: "refused" as const, reason: "dirty tree" },
      { outcome: "already-at-base" as const, base: "main" },
    ]) {
      recordManualResetAgentNotice({
        setPendingAgentNotice,
        runner: undefined,
        sessionId: "session-1",
        outcome,
      });
    }
    expect(setPendingAgentNotice).not.toHaveBeenCalled();
  });

  it("does not fail the reset when the notice write throws", () => {
    const setPendingAgentNotice = vi.fn(() => { throw new Error("db closed"); });
    expect(() => recordManualResetAgentNotice({
      setPendingAgentNotice,
      runner: undefined,
      sessionId: "session-1",
      outcome: resetOutcome,
    })).not.toThrow();
  });
});

describe("reportSyncFailure", () => {
  beforeEach(() => emitNoticePostTurn.mockClear());

  const gitStderr = [
    "warning: unable to access '/root/.config/git/attributes': Permission denied",
    "Rebasing (1/8)\rerror: The following untracked working tree files would be overwritten by merge:",
    "\tapp/.vite/deps/a.js",
    "\tapp/.vite/deps/b.js",
    "\tapp/.vite/deps/c.js",
    "\tapp/.vite/deps/d.js",
    "Please move or remove them before you merge.",
    "Aborting",
    "hint: Could not execute the todo command",
  ].join("\n");

  async function report(err: unknown, rebaseInProgress: boolean | null) {
    const emitMessage = vi.fn();
    await reportSyncFailure({
      runner: { emitMessage } as unknown as SessionRunnerInterface,
      chatHistoryManager: {} as ChatHistoryManager,
      git: { rebaseInProgressState: async () => rebaseInProgress },
      sessionId: "session-1",
      baseBranch: "main",
      err,
    });
    const notice = emitNoticePostTurn.mock.calls[0]?.[3] as string | undefined;
    return { emitMessage, notice };
  }

  it("clears the banner with git's error line rather than its raw stderr", async () => {
    const { emitMessage } = await report(new Error(gitStderr), false);
    expect(emitMessage).toHaveBeenCalledWith({
      type: "rebase_aborted",
      sessionId: "session-1",
      reason: "error: The following untracked working tree files would be overwritten by merge: "
        + "`app/.vite/deps/a.js`, `app/.vite/deps/b.js`, `app/.vite/deps/c.js` and 1 more",
    });
  });

  it("explains an untracked-overwrite failure and says the branch is unchanged", async () => {
    const { notice } = await report(new Error(gitStderr), false);
    expect(notice).toMatch(/^Sync with `main` failed: a commit being replayed adds files/);
    expect(notice).toContain("Your branch was not changed by ShipIt.");
    expect(notice).not.toContain("Permission denied");
  });

  it("says the workspace is still mid-rebase when the abort did not take, in the notice and the banner", async () => {
    const { emitMessage, notice } = await report(new Error(gitStderr), true);
    expect(notice).toContain("still mid-rebase");
    expect(notice).not.toContain("was not changed");
    const banner = emitMessage.mock.calls.find(([m]) => (m as { type: string }).type === "rebase_aborted")?.[0] as
      { reason: string } | undefined;
    expect(banner?.reason).toContain("still mid-rebase");
  });

  it("does not call the branch unchanged when git cannot say whether a rebase is in progress", async () => {
    const { notice } = await report(new Error(gitStderr), null);
    expect(notice).toContain("could not check whether the rebase was aborted");
    expect(notice).not.toContain("was not changed");
  });

  it("adds no second notice for a failure the driver already explained", async () => {
    const { emitMessage, notice } = await report(markSyncFailureExplained(new Error("interrupted")), false);
    expect(notice).toBeUndefined();
    expect(emitMessage).toHaveBeenCalledWith({ type: "rebase_aborted", sessionId: "session-1", reason: "interrupted" });
  });
});
