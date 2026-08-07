import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrStatusSummary } from "../shared/types.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { SessionRunnerInterface } from "./session-runner.js";

const { emitChatCard } = vi.hoisted(() => ({ emitChatCard: vi.fn() }));

vi.mock("./chat-card-persistence.js", () => ({ emitChatCard }));

import { presentExplicitResetSuccess, recordManualResetAgentNotice } from "./api-routes-git.js";

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

/**
 * docs/221 — the merged-session half of "the manual sync never told the agent".
 * The user's "Sync with main" click resets the branch through this route with no
 * turn in flight, so the notice is parked for the next one.
 */
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
