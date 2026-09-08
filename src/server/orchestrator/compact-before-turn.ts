/**
 * docs/295 — should a merged session compact its context before the message
 * that just arrived? A decision only. When the answer is yes the caller does
 * what a user does by hand: it queues the message and runs a `/compact` turn
 * (the shipped docs/178 path), and that turn's drain starts the message.
 *
 * Eligibility is {@link isResetEligible}, the same predicate that offers the
 * composer's reset tick box (reqs 1, 3, 13). The docs/218 reset itself runs on
 * the user's turn, after the compaction, so its merge prefix is built after the
 * summary exists and cannot be summarized away (req 7).
 */

import type { AgentId, SessionInfo } from "../shared/types.js";
import { isResetEligible, type ResetEligibleSignalDeps } from "./services/pre-turn-reset.js";
import {
  recheckMergeBeforeTurn,
  type PreTurnMergeRecheckDeps,
} from "./services/pre-turn-merge-recheck.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import { getAgentCapabilities } from "../shared/agent-registry.js";

/**
 * The post-merge summarization brief. A default summary ends with the shipped
 * work's next steps — the context this compaction exists to drop. Claude and
 * Grok honour it; Codex and OpenCode have no slot for instructions (docs/276),
 * which is why the merge prefix on the user's turn matters (req 7).
 */
export const POST_MERGE_COMPACTION_INSTRUCTIONS =
  "The pull request for the work in this conversation has been merged, so that work is finished "
  + "and is already in the base branch. Summarize for a session that is about to start NEW work in "
  + "the same repository: keep the user's standing preferences and instructions, the repository "
  + "conventions established here, and any question still unresolved. Reduce the shipped work to a "
  + "short statement of what it changed, and drop its step-by-step implementation detail.";

/** The prompt of the compaction turn ShipIt runs on the user's behalf. */
export const POST_MERGE_COMPACT_PROMPT = `/compact ${POST_MERGE_COMPACTION_INSTRUCTIONS}`;

export interface CompactBeforeTurnDeps extends ResetEligibleSignalDeps {
  /** docs/282 — refresh the merge state first. Optional: minimal wiring gates on recorded state. */
  mergeRecheckDeps?: Pick<PreTurnMergeRecheckDeps, "verifyPrState" | "awaitMergeHandling">;
  /** The shared docs/218 setting (req 11). */
  getAutoResetMergedBranch: () => boolean;
  /** Reads `conversationReplay`. */
  getSessionRow: (sessionId: string) => SessionInfo | undefined;
}

export interface CompactBeforeTurnArgs {
  deps: CompactBeforeTurnDeps;
  runner: SessionRunnerInterface;
  agentId: AgentId;
  sessionId: string;
  sessionDir: string;
  /**
   * The composer's tick box: `false` = skip for this message. Absent on
   * programmatic paths, which follow the global setting (req 13). A message
   * re-queued behind its compaction carries `false`, so it is not compacted twice.
   */
  intent?: boolean;
}

/** Fail-safe false throughout: a message is never held up by this (req 9). */
export async function shouldCompactBeforeTurn(args: CompactBeforeTurnArgs): Promise<boolean> {
  const { deps, runner, agentId, sessionId, sessionDir, intent } = args;

  // req 5 — unticked for this message. req 11 — the shared setting. req 10 —
  // a backend that cannot compact is not asked to.
  if (intent === false) return false;
  if (!deps.getAutoResetMergedBranch()) return false;
  if (!(getAgentCapabilities(agentId)?.supportsCompaction ?? false)) return false;

  // An armed conversation replay (rewind, fork, docs/153 recovery) is consumed
  // read-and-clear by the next spawn; a compaction turn would take the seed and
  // summarize a conversation holding only that.
  if (deps.getSessionRow(sessionId)?.conversationReplay) return false;

  // docs/260 req 13 — a compaction turn spawns fresh, which retires a resident
  // holding background work. Losing one compaction is the smaller harm.
  if (runner.getAgent() !== null && runner.backgroundWorkDescriptions.length > 0) {
    console.log(
      `[compact-before-turn] skipping for ${sessionId}: the resident process holds `
      + `${runner.backgroundWorkDescriptions.length} background task(s) that retiring it would lose`,
    );
    return false;
  }

  try {
    // docs/282 — merge detection is poll-driven; refresh before deciding. The
    // probe records what it finds, so the reset on the user's turn reads it.
    if (deps.mergeRecheckDeps) {
      const recheck = await recheckMergeBeforeTurn(
        { ...deps, ...deps.mergeRecheckDeps },
        sessionId,
        sessionDir,
      );
      // The merge landed but its bookkeeping did not finish: the reset stands
      // down, and a compaction without the reset's prefix loses req 7.
      if (recheck === "unsettled") return false;
    }
    return await isResetEligible(deps, sessionId, sessionDir);
  } catch (err) {
    console.error(`[compact-before-turn] decision failed for ${sessionId}:`, err);
    return false;
  }
}
