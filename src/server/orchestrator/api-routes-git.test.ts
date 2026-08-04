import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrStatusSummary } from "../shared/types.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { SessionRunnerInterface } from "./session-runner.js";

const { emitChatCard } = vi.hoisted(() => ({ emitChatCard: vi.fn() }));

vi.mock("./chat-card-persistence.js", () => ({ emitChatCard }));

import { presentExplicitResetSuccess } from "./api-routes-git.js";

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
