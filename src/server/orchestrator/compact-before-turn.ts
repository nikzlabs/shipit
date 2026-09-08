/**
 * docs/295 — should a merged session compact its context before the message the
 * user just sent?
 *
 * This is a DECISION and nothing else. What happens when the answer is yes is
 * what a user already gets by hand: ShipIt queues their message and runs a
 * `/compact` turn, and the queue drains into their turn when it ends. That is
 * the shipped docs/178 path, so the compaction is an ordinary turn — the
 * executor owns its `running`, its delivery, its readiness, its cancellation,
 * its transcript accumulators and its persistence, exactly as it owns every
 * other turn's.
 *
 * ## Why this file is so much smaller than the design it replaces
 *
 * The first implementation ran the compaction INSIDE the user's send, as work
 * nested between the message arriving and its turn starting. Five review rounds
 * were spent on the consequences, and they were all the same consequence: a
 * session in that phase is in a state the rest of the orchestrator has no name
 * for. `running` is true but no turn is accumulating, so every side-channel
 * card written during it was recorded against the previous turn and deleted by
 * the next one. The session reads busy to some consumers and idle to others, so
 * a predecessor's late `done` could clear the flag and `shipit session wait`
 * could report ready mid-compaction. Nothing owned cancellation, so a timeout
 * could not stop a spawn that was still starting. Each was patchable, and each
 * patch taught a different consumer about a phase that only this feature knew
 * existed.
 *
 * Sequencing removes the state instead of describing it. There is no phase: at
 * every instant the session is running exactly one ordinary turn, and the user's
 * message is in the queue, which is a place the whole system already understands.
 * `preTurnHold`, the admission checks that read it, the slot-owning operation,
 * its settle latch, its ownership re-checks, its credential teardown and its
 * persistence bypass are all gone — not fixed, gone, because the turn executor
 * was already doing every one of those jobs correctly.
 *
 * ## One gate, not two
 *
 * Eligibility is {@link isResetEligible} — the SAME predicate that drives the
 * composer's `reset_eligible` signal, and therefore the same one that put the
 * tick box in front of the user. Requirements 1 and 3 say the second control is
 * offered whenever the first is; requirement 13 says a continuation the user did
 * not type compacts "in the same conditions in which its branch is reset".
 * Asking the same function is how those hold.
 *
 * The docs/218 reset runs on the USER's turn, after this one — which is both
 * where it has always run and what protects requirement 7: the merge prefix is
 * built after the compaction has produced its summary and is handed only to the
 * turn that carries the user's message, so it cannot be absorbed into that
 * summary. The two gates do not need to share a merge probe: this one's
 * `recheckMergeBeforeTurn` PERSISTS what it learns, so the reset's own probe on
 * the next turn cheap-exits on the state this one recorded.
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
 * The post-merge summarization brief.
 *
 * A default summary ends with the shipped work's next steps, which is precisely
 * the wrong emphasis for a session whose work just merged — that is the context
 * this compaction exists to drop. Two of the four harnesses honour it (Claude
 * passes it to `/compact <instructions>`; Grok lifts it into `user_context` —
 * probed at 1.0.12, docs/276); Codex's `thread/compact/start` and OpenCode's
 * `summarize` route have no slot for instructions and ignore it.
 *
 * That asymmetry is why docs/295 req 7 is a requirement rather than a nicety:
 * on the other two harnesses the docs/218 merge prefix is the ONLY thing telling
 * the agent not to re-apply shipped work, and it rides the user's turn — never
 * this one.
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
  /**
   * docs/282's recheck deps, so the decision reads fresh merge state rather than
   * whatever the poller last saw. Optional: a runtime that cannot probe (minimal
   * test wiring) gates on the recorded state, exactly as docs/218 did.
   */
  mergeRecheckDeps?: Pick<PreTurnMergeRecheckDeps, "verifyPrState" | "awaitMergeHandling">;
  /** The shared docs/218 setting. Requirement 11: one switch governs both actions. */
  getAutoResetMergedBranch: () => boolean;
  /** Reads `conversationReplay` — see the gate below. */
  getSessionRow: (sessionId: string) => SessionInfo | undefined;
}

export interface CompactBeforeTurnArgs {
  deps: CompactBeforeTurnDeps;
  runner: SessionRunnerInterface;
  agentId: AgentId;
  sessionId: string;
  sessionDir: string;
  /**
   * The composer's per-send tick box. `false` = unticked for this message →
   * skip. Absent on every programmatic path (there is no box), so those follow
   * the global setting — requirement 13.
   *
   * Also how re-entry is prevented: when ShipIt takes a message over, it puts
   * the message back on the queue with `compactContext: false`, which says
   * exactly what is true — the compaction for this message has already happened.
   */
  intent?: boolean;
}

/**
 * Answer whether the message about to run should be preceded by a compaction
 * turn. Fail-safe false throughout: a message must never be held up because this
 * could not decide (requirement 9).
 */
export async function shouldCompactBeforeTurn(args: CompactBeforeTurnArgs): Promise<boolean> {
  const { deps, runner, agentId, sessionId, sessionDir, intent } = args;

  // Requirement 5 — the untick applies to this one message. Checked before
  // anything expensive: an unticked box must cost nothing, not merely change
  // nothing.
  if (intent === false) return false;
  // Requirement 11 — the shared setting. Off means neither control is offered,
  // so a stale `compactContext: true` from a client that has not seen the
  // setting change still cannot compact.
  if (!deps.getAutoResetMergedBranch()) return false;
  // Requirement 10 — a backend that cannot compact is not asked to.
  if (!(getAgentCapabilities(agentId)?.supportsCompaction ?? false)) return false;

  // An armed conversation replay (a rewind, a fork, a docs/153 recovery) means
  // the CLI-side conversation is absent or must not be continued, and the user's
  // turn is about to start a fresh one seeded from ShipIt's own transcript.
  // There is nothing to compact — and a compaction turn would DESTROY the seed,
  // because `buildAgentRunParams` consumes the replay read-and-clear: the
  // compaction would take it, summarize a conversation holding only that seed,
  // and hand the user's turn the result.
  if (deps.getSessionRow(sessionId)?.conversationReplay) return false;

  // docs/260 req 13 — a resident process holding background work (a sub-agent
  // review, agent-started background tasks) may not be displaced: a compaction
  // turn spawns fresh, and the fresh spawn retires the resident, losing the
  // tokens already spent on that work. Losing one compaction is a far smaller
  // harm than losing a running review.
  if (runner.getAgent() !== null && runner.backgroundWorkDescriptions.length > 0) {
    console.log(
      `[compact-before-turn] skipping for ${sessionId}: the resident process holds `
      + `${runner.backgroundWorkDescriptions.length} background task(s) that retiring it would lose`,
    );
    return false;
  }

  try {
    // docs/282 — merge detection is poll-driven, so a message admitted inside the
    // poll window reads a session that has not been noticed as merged yet. The
    // probe RECORDS what it finds, which is why the reset on the user's turn does
    // not need the answer handed to it: its own probe cheap-exits on `mergedAt`.
    if (deps.mergeRecheckDeps) {
      const recheck = await recheckMergeBeforeTurn(
        { ...deps, ...deps.mergeRecheckDeps },
        sessionId,
        sessionDir,
      );
      // The one outcome that is a decision rather than a refresh: the merge
      // landed but its bookkeeping did not finish. The reset stands down on it
      // too, and the two must agree — a compaction whose reset stands down
      // strips the context and leaves nothing telling the agent its work
      // shipped, which on Codex and OpenCode is requirement 7 gone.
      if (recheck === "unsettled") return false;
    }
    return await isResetEligible(deps, sessionId, sessionDir);
  } catch (err) {
    // `isResetEligible` is already fail-safe-false internally; this covers a
    // throw from the probe or from constructing its deps. "We could not tell"
    // means "do not compact".
    console.error(`[compact-before-turn] decision failed for ${sessionId}:`, err);
    return false;
  }
}
