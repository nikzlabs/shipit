import type { AgentId } from "../shared/types.js";
import {
  compactedThisMerge,
  isResetEligible,
  mergeContinueAnchor,
  type ResetEligibleSignalDeps,
} from "./services/pre-turn-reset.js";
import {
  recheckMergeBeforeTurn,
  type PreTurnMergeRecheckDeps,
} from "./services/pre-turn-merge-recheck.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import { getAgentCapabilities } from "../shared/agent-registry.js";
import { AUTOMATIC_COMPACTION_MIN_CONTEXT_TOKENS } from "../shared/compaction-threshold.js";
import { emitNoticePostTurn } from "./chat-card-persistence.js";
import type { PersistedMessage } from "./chat-history.js";

export const POST_MERGE_COMPACTION_INSTRUCTIONS =
  "The pull request for the work in this conversation has been merged, so that work is finished "
  + "and is already in the base branch. Summarize for a session that is about to start NEW work in "
  + "the same repository: keep the user's standing preferences and instructions, the repository "
  + "conventions established here, and any question still unresolved. Reduce the shipped work to a "
  + "short statement of what it changed, and drop its step-by-step implementation detail.";

export const POST_MERGE_COMPACT_PROMPT = `/compact ${POST_MERGE_COMPACTION_INSTRUCTIONS}`;

export const MISSED_COMPACTION_NOTICE =
  "The context was not compacted; the agent continues with the context as it was.";

export interface CompactBeforeTurnDeps extends ResetEligibleSignalDeps {
  mergeRecheckDeps?: Pick<PreTurnMergeRecheckDeps, "verifyPrState" | "awaitMergeHandling">;
  getAutoResetMergedBranch: () => boolean;
  /** docs/218 req 6 — record that this merge's compaction offer is spent (`setMergeContinueCompacted`). */
  markCompacted: (sessionId: string, anchor: string) => void;
  /** The context size after the last turn (`UsageManager.latestContextTokens`); undefined when unknown. */
  getContextTokens: (sessionId: string) => number | undefined;
}

export interface CompactBeforeTurnArgs {
  deps: CompactBeforeTurnDeps;
  runner: SessionRunnerInterface;
  agentId: AgentId;
  sessionId: string;
  sessionDir: string;
  /** Requeued messages use false to prevent a second compaction. Absent: the session's own choice. */
  intent?: boolean;
}

export async function shouldCompactBeforeTurn(args: CompactBeforeTurnArgs): Promise<boolean> {
  const { deps, runner, agentId, sessionId, sessionDir, intent } = args;
  // An untick answers this merge's compaction offer too, so it still reaches the record below.
  // The session's own choice is that untick, kept for every turn (docs/295 reqs 5, 17). A send
  // carries a value only while the user's last click is still being saved, so that value wins.
  const unticked = intent === undefined
    ? deps.getSession(sessionId)?.compactAfterMergeOff === true
    : !intent;

  if (!deps.getAutoResetMergedBranch()) return false;
  if (!(getAgentCapabilities(agentId)?.supportsCompaction ?? false)) return false;

  // docs/295 req 15, also with the box ticked; an unknown size compacts. Not recorded against
  // the merge: nothing is spent.
  const context = deps.getContextTokens(sessionId);
  if (context !== undefined && context < AUTOMATIC_COMPACTION_MIN_CONTEXT_TOKENS) {
    console.log(
      `[compact-before-turn] skipping for ${sessionId}: the context is ${context} tokens `
      + `(minimum ${AUTOMATIC_COMPACTION_MIN_CONTEXT_TOKENS})`,
    );
    return false;
  }

  if (!unticked) {
    // Compaction would consume the replay seed intended for the next user turn.
    if (deps.getSession(sessionId)?.conversationReplay) return false;

    // A turn of the CLI's own for that work could come between the compaction and the message.
    if (runner.getAgent() !== null && runner.backgroundWorkDescriptions.length > 0) {
      console.log(
        `[compact-before-turn] skipping for ${sessionId}: the resident process holds `
        + `${runner.backgroundWorkDescriptions.length} background task(s)`,
      );
      return false;
    }
  }

  try {
    if (!unticked && deps.mergeRecheckDeps) {
      const recheck = await recheckMergeBeforeTurn(
        { ...deps, ...deps.mergeRecheckDeps },
        sessionId,
        sessionDir,
      );
      // Without the reset's merge prefix, compaction could lose the completed-work boundary.
      if (recheck === "unsettled") return false;
    }
    if (compactedThisMerge(deps.getSession(sessionId))) return false;
    if (!(await isResetEligible(deps, sessionId, sessionDir))) return false;
    // docs/218 req 6 — the offer is spent here, by the untick or by the compaction this
    // answer starts. Before it runs, so a compaction that fails is not tried again either.
    const anchor = mergeContinueAnchor(deps.getSession(sessionId));
    if (anchor) deps.markCompacted(sessionId, anchor);
    return !unticked;
  } catch (err) {
    console.error(`[compact-before-turn] decision failed for ${sessionId}:`, err);
    return false;
  }
}

export interface CompactionCardLog {
  append(sessionId: string, message: PersistedMessage): unknown;
  latestCompactionCard?(sessionId: string): { id: string } | undefined;
}

/** The newest compaction card on record, before a compaction turn starts. */
export function compactionCardBefore(chatHistory: CompactionCardLog, sessionId: string): string | null {
  return chatHistory.latestCompactionCard?.(sessionId)?.id ?? null;
}

export function noteMissedCompaction(
  runner: Pick<SessionRunnerInterface, "recordedCards" | "emitMessage">,
  chatHistory: CompactionCardLog,
  sessionId: string,
  cardBefore?: string | null,
): void {
  if (runner.recordedCards.some((c) => c.message.compaction !== undefined)) return;
  // A turn the CLI starts on the same process resets the runner's cards; the record keeps it.
  if (cardBefore !== undefined && chatHistory.latestCompactionCard
    && compactionCardBefore(chatHistory, sessionId) !== cardBefore) return;
  emitNoticePostTurn(
    (m) => runner.emitMessage(m),
    chatHistory,
    sessionId,
    MISSED_COMPACTION_NOTICE,
    "warn",
  );
}
