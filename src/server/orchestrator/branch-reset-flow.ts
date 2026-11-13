import { randomUUID } from "node:crypto";
import type { BranchAutoResetCard, PrStatusSummary } from "../shared/types.js";
import type { GitManager } from "../shared/git.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { PrStatusPoller } from "./pr-status-poller.js";
import type { SessionManager } from "./sessions.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "./session-runner.js";
import { emitChatCard } from "./chat-card-persistence.js";
import { detectAndReArmResetSession } from "./services/pr-rearm.js";
import {
  buildManualResetAgentNotice,
  computeResetEligibility,
  resetBranchToBaseExplicit,
  type ExplicitResetOutcome,
  type ResetActor,
} from "./services/pre-turn-reset.js";
import { captureTurn, isSameTurn, type TurnToken } from "./services/agent-merge-settlement.js";
import { releaseQueuedTurn } from "./queue-drain.js";
import { onWorkspaceRewritten } from "./workspace-rewrite.js";
import { getErrorMessage } from "./validation.js";

export interface BranchResetFlowDeps {
  sessionManager: SessionManager;
  createGitManager: (dir: string) => GitManager;
  runnerRegistry?: SessionRunnerRegistry;
  chatHistoryManager: ChatHistoryManager;
  prStatusPoller?: PrStatusPoller;
  sseBroadcast: (event: string, data: unknown) => void;
}

interface ExplicitResetPresentationDeps {
  runner: SessionRunnerInterface | undefined;
  chatHistoryManager: ChatHistoryManager;
  sessionId: string;
  prStatus: PrStatusSummary | null | undefined;
  // reArm clears the live PR snapshot; retain its identity for the reset card.
  fallbackPr?: { prNumber: number; prUrl: string } | undefined;
  outcome: ExplicitResetOutcome;
  reArmResetSession: () => Promise<void>;
}

export function recordManualResetAgentNotice(deps: {
  setPendingAgentNotice: (sessionId: string, notice: string) => void;
  runner: SessionRunnerInterface | undefined;
  sessionId: string;
  outcome: ExplicitResetOutcome;
  prNumber?: number;
  by?: ResetActor;
}): void {
  const moved = deps.outcome.outcome === "reset" || deps.outcome.movedLocally === true;
  if (!moved || !deps.outcome.base) return;
  if (deps.runner?.running) return;
  const unpushed = deps.outcome.movedLocally
    ? " ShipIt could not update the remote branch to match: run `shipit branch reset-to-base` "
      + "to retry the push before you commit anything."
    : "";
  try {
    deps.setPendingAgentNotice(
      deps.sessionId,
      buildManualResetAgentNotice({
        base: deps.outcome.base,
        fromSha: deps.outcome.fromSha,
        toSha: deps.outcome.toSha,
        prNumber: deps.prNumber,
        ...(deps.by ? { by: deps.by } : {}),
      }) + unpushed,
    );
  } catch (err) {
    console.error("[reset-to-base] recording the agent notice failed:", getErrorMessage(err));
  }
}

export async function presentExplicitResetSuccess(
  deps: ExplicitResetPresentationDeps,
): Promise<void> {
  if (deps.outcome.outcome === "refused") return;

  deps.runner?.emitMessage({
    type: "reset_eligible",
    sessionId: deps.sessionId,
    eligible: false,
  });
  await deps.reArmResetSession();

  const pr = deps.prStatus ?? deps.fallbackPr;
  if (deps.outcome.outcome !== "reset" || !deps.runner || !pr
    || !deps.outcome.base || !deps.outcome.fromSha || !deps.outcome.toSha) return;

  const card: BranchAutoResetCard = {
    cardId: `branch-reset-${randomUUID()}`,
    base: deps.outcome.base,
    prNumber: pr.prNumber,
    prUrl: pr.prUrl,
    fromSha: deps.outcome.fromSha,
    toSha: deps.outcome.toSha,
    createdAt: new Date().toISOString(),
    ...(deps.outcome.forced
      ? { forced: true, ...(deps.outcome.forceReason ? { forceReason: deps.outcome.forceReason } : {}) }
      : {}),
  };
  emitChatCard(
    deps.runner,
    { type: "branch_auto_reset_card", sessionId: deps.sessionId, card },
    { role: "assistant", text: "", branchAutoReset: card },
    { chatHistoryManager: deps.chatHistoryManager, sessionId: deps.sessionId },
  );
}

/** `shipit branch reset-to-base`, and the reset after an agent's own merge. */
export async function runExplicitBranchReset(
  deps: BranchResetFlowDeps,
  args: { sessionId: string; sessionDir: string; force?: { reason: string }; by?: ResetActor },
): Promise<ExplicitResetOutcome> {
  const { sessionManager, createGitManager } = deps;
  const { sessionId, sessionDir } = args;
  const prStatus = sessionManager.getPrStatus(sessionId);
  const outcome = await resetBranchToBaseExplicit(
    {
      getSession: (id: string) => sessionManager.get(id),
      getPrStatus: (id: string) => sessionManager.getPrStatus(id),
      createGitManager,
    },
    sessionId,
    sessionDir,
    ...(args.force ? [{ force: args.force }] as const : []),
  );
  const previous = sessionManager.get(sessionId)?.previousMergedPr;

  if (outcome.outcome === "reset" || outcome.movedLocally) {
    onWorkspaceRewritten(deps.runnerRegistry?.get(sessionId), "reset-to-base");
  }

  recordManualResetAgentNotice({
    setPendingAgentNotice: (id, notice) => sessionManager.setPendingAgentNotice(id, notice),
    runner: deps.runnerRegistry?.get(sessionId),
    sessionId,
    outcome,
    prNumber: prStatus?.prNumber ?? previous?.number,
    ...(args.by ? { by: args.by } : {}),
  });

  await presentExplicitResetSuccess({
    runner: deps.runnerRegistry?.get(sessionId),
    chatHistoryManager: deps.chatHistoryManager,
    sessionId,
    prStatus,
    fallbackPr: previous ? { prNumber: previous.number, prUrl: previous.url } : undefined,
    outcome,
    reArmResetSession: async () => {
      if (!deps.prStatusPoller) return;
      await detectAndReArmResetSession({
        deps: {
          sessionManager,
          prStatusPoller: deps.prStatusPoller,
          createGitManager,
          sseBroadcast: deps.sseBroadcast,
        },
        sessionId,
        sessionDir,
        emit: (message) => deps.runnerRegistry?.get(sessionId)?.emitMessage(message),
        skipFetch: true,
      });
    },
  });
  return outcome;
}

export const MERGE_HANDLING_WAIT_MS = 30_000;

export type AfterMergeReset =
  | { kind: "done"; outcome: ExplicitResetOutcome }
  | { kind: "blocked"; reason: string }
  | { kind: "refused"; reason: string; movedLocally: boolean }
  | { kind: "not-recorded" }
  | { kind: "turn-ended" };

// The poller asks callers to bound this wait; the handling also delivers the self-merge wake.
export async function mergeHandlingSettled(
  poller: PrStatusPoller | undefined,
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> {
  if (!poller) return true;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const handled = async (): Promise<true> => {
    await poller.awaitMergeHandling(sessionId);
    return true;
  };
  try {
    return await Promise.race([handled(), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** docs/287-agent-merge-per-repo §6: call only after this session's own merge settled. */
export async function resetBranchAfterAgentMerge(
  deps: BranchResetFlowDeps,
  args: {
    sessionId: string;
    sessionDir: string;
    by: ResetActor;
    mergeHandlingWaitMs?: number;
    /** Asked before the reset: false abandons it, leaving the branch to the next message. */
    stillOwned?: () => boolean;
  },
): Promise<AfterMergeReset> {
  const { sessionId, sessionDir } = args;
  const recorded = await mergeHandlingSettled(
    deps.prStatusPoller, sessionId, args.mergeHandlingWaitMs ?? MERGE_HANDLING_WAIT_MS,
  );
  if (!recorded || !deps.sessionManager.get(sessionId)?.mergedAt) return { kind: "not-recorded" };

  const eligibility = await computeResetEligibility(
    {
      getSession: (id: string) => deps.sessionManager.get(id),
      getPrStatus: (id: string) => deps.sessionManager.getPrStatus(id),
      createGitManager: deps.createGitManager,
    },
    sessionId,
    sessionDir,
  );
  if (!eligibility.eligible) {
    return {
      kind: "blocked",
      reason: eligibility.blocker?.detail
        ?? `ShipIt could not check whether the reset is safe (${eligibility.error ?? "unknown error"})`,
    };
  }
  if (args.stillOwned && !args.stillOwned()) return { kind: "turn-ended" };

  const outcome = await runExplicitBranchReset(deps, { sessionId, sessionDir, by: args.by });
  if (outcome.outcome === "refused") {
    return { kind: "refused", reason: outcome.reason ?? "unknown reason", movedLocally: outcome.movedLocally === true };
  }
  return { kind: "done", outcome };
}

const NO_MANUAL_RESET =
  "Do not run a manual `git reset --hard` or `git push --force`; once that is resolved, run "
  + "`shipit branch reset-to-base`.";

export function describeResetForMergeAnswer(reset: AfterMergeReset): string {
  switch (reset.kind) {
    case "turn-ended":
      return "This branch was not moved to the latest base, because the turn that ran the merge has "
        + "ended. Run `shipit branch reset-to-base` before more work.";
    case "done": {
      const { outcome } = reset;
      const base = `origin/${outcome.base ?? "<base>"}`;
      if (outcome.outcome === "already-at-base") {
        return `This branch already matches ${base}; build the next change here.`;
      }
      const shas = outcome.fromSha && outcome.toSha
        ? ` (${outcome.fromSha.slice(0, 7)} → ${outcome.toSha.slice(0, 7)})`
        : "";
      return `ShipIt then moved this branch to the latest ${base}${shas}: it no longer contains the `
        + "merged commits, and files you read before the merge may have changed, so re-read them "
        + "before editing. Build the next change here and open its pull request with `gh pr create`.";
    }
    case "blocked":
      return `This branch was left on the merged commit, because ${reset.reason}. ${NO_MANUAL_RESET}`;
    case "refused":
      return `Moving this branch to the latest base did not complete: ${reset.reason}`;
    case "not-recorded":
      return "ShipIt could not finish recording the merge in time, so this branch was not moved. Wait "
        + "a moment, then run `shipit branch reset-to-base`.";
  }
}

/** The direct `gh pr merge`: reset inside the turn that merged, holding turn admission off. */
export async function resetBranchAfterDirectMerge(
  deps: BranchResetFlowDeps,
  args: { sessionId: string; sessionDir: string; turn: TurnToken | null; mergeHandlingWaitMs?: number },
): Promise<string> {
  const { sessionId } = args;
  const runner = deps.runnerRegistry?.get(sessionId);
  const stillOwned = (): boolean => {
    const active = captureTurn(deps.runnerRegistry, sessionId);
    return active !== null && isSameTurn(active, args.turn);
  };
  if (!runner || !stillOwned()) return describeResetForMergeAnswer({ kind: "turn-ended" });

  // The hold keeps a new turn out; the lease keeps the runner from being reclaimed mid-reset.
  const heldBefore = runner.mergeHold;
  runner.mergeHold = true;
  runner.beginPostTurnWork();
  try {
    const reset = await resetBranchAfterAgentMerge(deps, {
      sessionId,
      sessionDir: args.sessionDir,
      by: "agent-merge",
      stillOwned,
      ...(args.mergeHandlingWaitMs !== undefined ? { mergeHandlingWaitMs: args.mergeHandlingWaitMs } : {}),
    });
    return describeResetForMergeAnswer(reset);
  } catch (err) {
    console.error(`[agent-merge] resetting the branch after the merge failed for ${sessionId}:`, err);
    return describeResetForMergeAnswer({ kind: "refused", reason: getErrorMessage(err), movedLocally: false });
  } finally {
    runner.endPostTurnWork();
    if (!heldBefore) {
      runner.mergeHold = false;
      releaseQueuedTurn(runner);
    }
  }
}
