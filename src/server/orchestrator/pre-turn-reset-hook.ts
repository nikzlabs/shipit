import { randomUUID } from "node:crypto";
import type { BranchAutoResetCard, WsServerMessage } from "../shared/types.js";
import { autoResetMergedBranchOnContinue, clearResetSkipEpisode } from "./services/pre-turn-reset.js";
import { recheckMergeBeforeTurn } from "./services/pre-turn-merge-recheck.js";
import { detectAndReArmResetSession, type ReArmDeps } from "./services/pr-rearm.js";
import {
  emitChatCard,
  emitNoticeInTurn,
  emitNoticePostTurn,
  type InProgressPersister,
} from "./chat-card-persistence.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import { onWorkspaceRewritten } from "./workspace-rewrite.js";

export interface PreTurnResetHookDeps extends ReArmDeps {
  chatHistoryManager: InProgressPersister;
  getAutoResetMergedBranch: () => boolean;
}

export type PreTurnResetRunner = Pick<
  SessionRunnerInterface,
  | "emitMessage"
  | "running"
  | "chatMessageGroups"
  | "recordedCards"
  | "steeredMessages"
  | "getTurnEventBuffer"
  | "lastPersistedBufferIndex"
  | "reevaluateWorkspaceConfig"
  | "notifyWorkspaceRewritten"
>;

export interface PreTurnResetHookResult {
  agentPrefix: string;
  afterUserMessagePersisted?: (sessionId: string) => void;
  // Call in the turn's finally: an early failure must not erase the reset's record.
  ensureRecorded?: (sessionId: string) => void;
}

const NO_RESET: PreTurnResetHookResult = { agentPrefix: "" };

export async function applyPreTurnReset(args: {
  deps: PreTurnResetHookDeps;
  runner: PreTurnResetRunner;
  sessionId: string;
  sessionDir: string;
  // Absent per-send intent follows the global setting.
  intent?: boolean;
}): Promise<PreTurnResetHookResult> {
  const { deps, runner, sessionId, sessionDir, intent } = args;

  // Refresh merge state before evaluating the reset gate; polling may lag this turn.
  const recheck = await recheckMergeBeforeTurn(
    {
      getSession: (id) => deps.sessionManager.get(id),
      getPrStatus: (id) => deps.sessionManager.getPrStatus(id),
      createGitManager: deps.createGitManager,
      verifyPrState: (id) =>
        deps.prStatusPoller.forceVerifySessionPrState(id, { armAbsentDebounce: false }),
      awaitMergeHandling: (id) => deps.prStatusPoller.awaitMergeHandling(id),
    },
    sessionId,
    sessionDir,
  );
  // Pending merge cleanup could delete the branch that a reset would recreate.
  if (recheck === "unsettled") return NO_RESET;

  const reset = await autoResetMergedBranchOnContinue(
    {
      getSession: (id) => deps.sessionManager.get(id),
      getPrStatus: (id) => deps.sessionManager.getPrStatus(id),
      createGitManager: deps.createGitManager,
      getAutoResetMergedBranch: deps.getAutoResetMergedBranch,
    },
    sessionId,
    sessionDir,
    intent,
  );

  if (!reset.moved && !reset.skip) return NO_RESET;

  let card: BranchAutoResetCard | null = null;

  if (reset.moved) {
    // Config reevaluation can start an asynchronous install that overlaps the turn.
    onWorkspaceRewritten(runner, "pre-turn-reset");

    card = {
      cardId: `branch-reset-${randomUUID()}`,
      base: reset.base!,
      prNumber: reset.prNumber!,
      prUrl: reset.prUrl!,
      fromSha: reset.fromSha!,
      toSha: reset.toSha!,
      createdAt: new Date().toISOString(),
    };
    // The branch already moved. Bookkeeping failures must not lose the delivery callbacks.
    try {
      await detectAndReArmResetSession({
        deps,
        sessionId,
        sessionDir,
        emit: (msg) => runner.emitMessage(msg),
        // Reset just fetched the base.
        skipFetch: true,
      });
      runner.emitMessage({ type: "reset_eligible", sessionId, eligible: false });
    } catch (err) {
      console.error(
        `[pre-turn-reset] post-reset bookkeeping failed for ${sessionId} ` +
          `(branch WAS moved to origin/${reset.base}; PR card may lag until post-turn):`,
        err,
      );
    }
  }

  const skipNotice = reset.skip?.notice
    ? { notice: reset.skip.notice, level: reset.skip.level }
    : null;

  // The fallback appends directly: an early failure may leave the previous turn's
  // state on the runner. In-band persistence would revive and later delete that turn.
  // Close the latch only after success so an anchored failure can retry in finally.
  let recorded = false;
  const record = (sid: string, anchored: boolean): void => {
    if (recorded) return;
    try {
      if (card) {
        const wsMessage: WsServerMessage = { type: "branch_auto_reset_card", sessionId: sid, card };
        const persisted = { role: "assistant" as const, text: "", branchAutoReset: card };
        if (anchored) {
          emitChatCard(runner, wsMessage, persisted, {
            chatHistoryManager: deps.chatHistoryManager,
            sessionId: sid,
          });
        } else {
          runner.emitMessage(wsMessage);
          deps.chatHistoryManager.append(sid, persisted);
        }
      }
      if (skipNotice) {
        if (anchored) {
          emitNoticeInTurn(runner, sid, skipNotice.notice, deps.chatHistoryManager, skipNotice.level);
        } else {
          emitNoticePostTurn(
            (m) => runner.emitMessage(m),
            deps.chatHistoryManager,
            sid,
            skipNotice.notice,
            skipNotice.level,
          );
        }
      }
      recorded = true;
    } catch (err) {
      // Release deduplication only after the fallback fails, so a later turn can retry.
      if (!anchored && skipNotice) clearResetSkipEpisode(sid);
      console.error(
        `[pre-turn-reset] pre-turn transcript record failed for ${sid}` +
          `${anchored ? " (will retry on the post-turn fallback)" : ""}:`,
        err,
      );
    }
  };

  return {
    agentPrefix: reset.agentPrefix ?? "",
    afterUserMessagePersisted: (sid) => { record(sid, true); },
    ensureRecorded: (sid) => { record(sid, false); },
  };
}
