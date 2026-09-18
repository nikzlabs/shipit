import type { AgentId } from "../shared/types.js";
import { isResetEligible, type ResetEligibleSignalDeps } from "./services/pre-turn-reset.js";
import {
  recheckMergeBeforeTurn,
  type PreTurnMergeRecheckDeps,
} from "./services/pre-turn-merge-recheck.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import { getAgentCapabilities } from "../shared/agent-registry.js";
import { emitNoticePostTurn } from "./chat-card-persistence.js";
import type { PersistedMessage } from "./chat-history.js";

export const POST_MERGE_COMPACTION_INSTRUCTIONS =
  "The pull request for the work in this conversation has been merged, so that work is finished "
  + "and is already in the base branch. Summarize for a session that is about to start NEW work in "
  + "the same repository: keep the user's standing preferences and instructions, the repository "
  + "conventions established here, and any question still unresolved. Reduce the shipped work to a "
  + "short statement of what it changed, and drop its step-by-step implementation detail.";

export const POST_MERGE_COMPACT_PROMPT = `/compact ${POST_MERGE_COMPACTION_INSTRUCTIONS}`;

export interface CompactBeforeTurnDeps extends ResetEligibleSignalDeps {
  mergeRecheckDeps?: Pick<PreTurnMergeRecheckDeps, "verifyPrState" | "awaitMergeHandling">;
  getAutoResetMergedBranch: () => boolean;
}

export interface CompactBeforeTurnArgs {
  deps: CompactBeforeTurnDeps;
  runner: SessionRunnerInterface;
  agentId: AgentId;
  sessionId: string;
  sessionDir: string;
  /** Requeued messages use false to prevent a second compaction. */
  intent?: boolean;
}

export async function shouldCompactBeforeTurn(args: CompactBeforeTurnArgs): Promise<boolean> {
  const { deps, runner, agentId, sessionId, sessionDir, intent } = args;

  if (intent === false) return false;
  if (!deps.getAutoResetMergedBranch()) return false;
  if (!(getAgentCapabilities(agentId)?.supportsCompaction ?? false)) return false;

  // Compaction would consume the replay seed intended for the next user turn.
  if (deps.getSession(sessionId)?.conversationReplay) return false;

  // A fresh compaction process would retire the resident and lose its background work.
  if (runner.getAgent() !== null && runner.backgroundWorkDescriptions.length > 0) {
    console.log(
      `[compact-before-turn] skipping for ${sessionId}: the resident process holds `
      + `${runner.backgroundWorkDescriptions.length} background task(s) that retiring it would lose`,
    );
    return false;
  }

  try {
    if (deps.mergeRecheckDeps) {
      const recheck = await recheckMergeBeforeTurn(
        { ...deps, ...deps.mergeRecheckDeps },
        sessionId,
        sessionDir,
      );
      // Without the reset's merge prefix, compaction could lose the completed-work boundary.
      if (recheck === "unsettled") return false;
    }
    return await isResetEligible(deps, sessionId, sessionDir);
  } catch (err) {
    console.error(`[compact-before-turn] decision failed for ${sessionId}:`, err);
    return false;
  }
}

export function noteMissedCompaction(
  runner: Pick<SessionRunnerInterface, "recordedCards" | "emitMessage">,
  chatHistory: { append(sessionId: string, message: PersistedMessage): unknown },
  sessionId: string,
): void {
  if (runner.recordedCards.some((c) => c.message.compaction !== undefined)) return;
  emitNoticePostTurn(
    (m) => runner.emitMessage(m),
    chatHistory,
    sessionId,
    "The context was not compacted before this message; it runs with the context as it was.",
    "warn",
  );
}
