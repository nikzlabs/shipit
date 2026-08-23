/**
 * docs/218 — the per-turn WIRING of the merged-branch auto-reset, shared by
 * every transport that starts a turn.
 *
 * `services/pre-turn-reset.ts` owns the decision and the git move. This module
 * owns what a turn has to do around it: prepend the agent-facing prefix, emit
 * the persisted "branch updated" card (or the planning#297 skip notice) at its true
 * transcript anchor, re-arm the stale merged PR card, and push
 * `reset_eligible: false` so the composer control disappears the moment the
 * branch moves.
 *
 * ## Why it is shared (planning#333)
 *
 * docs/218 scoped the reset to the INTERACTIVE path (`runAgentWithMessage`) and
 * wrote the wiring inline there, with "if we later want programmatic continues
 * to reset too, factor a shared helper then." Later is now: the Agent Interface
 * SDK (docs/242) turns a click inside an agent-built page into a real agent
 * turn, and that message is dispatched — so it reached `runDispatchedTurn`,
 * which had none of this, and the agent went on working on a branch still
 * sitting on already-merged commits. Every other programmatic continue (`shipit
 * session message`, a notify-on-merge wake, a Create-PR button) had the same
 * hole.
 *
 * So the hook is transport-agnostic and BOTH adapters call it. Nothing narrows
 * it by who sent the message: the safety gate
 * ({@link import("./services/pre-turn-reset.js").computeResetBlocker}) is what
 * decides, and it already refuses everything a per-caller carve-out would have
 * — a CI-fix turn runs on an open PR (`not-merged`), a rebase-driver turn runs
 * mid-sequencer (`rebase-in-progress`), and any branch carrying unshipped work
 * fails `head-moved`. Adding a second, weaker gate keyed on the caller would
 * only let those two disagree.
 *
 * The per-send intent (`resetMergedBranch`, the composer's tick box) is a
 * composer concept and stays one: a dispatched turn passes no intent, so it
 * follows the global `autoResetMergedBranch` setting — which is exactly what
 * the box shows when it is ticked.
 *
 * ## Freshness comes first (docs/282)
 *
 * The gate is only ever as right as the merge state it reads, and that state is
 * poll-driven — so a turn admitted within the poll window of a merge used to
 * evaluate it against a session that did not read as merged yet, and run on the
 * merged tip. {@link recheckMergeBeforeTurn} refreshes it here, ahead of the
 * gate, in the narrow state where a fresh answer could change the outcome. It
 * decides nothing itself: the gate still owns whether the branch moves.
 */

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

/**
 * Everything the hook needs: the re-arm deps (session manager, PR poller, git,
 * SSE) plus chat history to persist the card/notice and the global setting.
 */
export interface PreTurnResetHookDeps extends ReArmDeps {
  chatHistoryManager: InProgressPersister;
  getAutoResetMergedBranch: () => boolean;
}

/** The runner surface the hook touches — emit + the card-recording state, plus
 * the two optional #2429 hooks a tree rewrite has to fire. */
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
  /** Prepend to this turn's prompt (empty when there is nothing to say). */
  agentPrefix: string;
  /**
   * Pass through as `TurnInput.afterUserMessagePersisted` so the card / notice
   * lands right after the user row, inside the fresh turn. Undefined when the
   * turn has no transcript record to write.
   */
  afterUserMessagePersisted?: (sessionId: string) => void;
  /**
   * Safety net — call from a `finally` around the turn. A branch that moved
   * MUST leave a visible record: it is a destructive operation the user did not
   * watch happen, and the card is the only durable evidence of it. The anchored
   * hook above is the preferred delivery (it interleaves right after the user
   * bubble), but it only fires if the turn gets far enough to persist that row,
   * and a turn can die before it — an admission refusal, a spawn failure, a
   * throw in env prep. This emits the same record late (appended at the end of
   * the transcript) rather than not at all. Latched with the hook, so exactly
   * one of the two ever writes.
   */
  ensureRecorded?: (sessionId: string) => void;
}

const NO_RESET: PreTurnResetHookResult = { agentPrefix: "" };

/**
 * Run the docs/218 pre-turn reset for a turn that is about to start, and return
 * the two things the caller has to thread into it.
 *
 * Fail-safe throughout: the service swallows its own git errors, and a throw in
 * the transcript work is logged rather than allowed to abort the turn (a
 * missing notice is a regression; a notice that kills the turn is a worse one).
 */
export async function applyPreTurnReset(args: {
  deps: PreTurnResetHookDeps;
  runner: PreTurnResetRunner;
  sessionId: string;
  sessionDir: string;
  /**
   * The composer's per-send tick box. `false` = unticked for this message →
   * skip. Absent on every programmatic path (there is no box), so those follow
   * the global setting.
   */
  intent?: boolean;
}): Promise<PreTurnResetHookResult> {
  const { deps, runner, sessionId, sessionDir, intent } = args;

  // docs/282 — the gate below reads the session's merge state, and that state is
  // poll-driven: a turn admitted inside the poll window would evaluate it
  // against a pull request ShipIt has not noticed merging yet, run on the merged
  // tip, and strand its commit there. Refresh it first, in the narrow state
  // where a fresh answer could change the outcome. Fail-safe and bounded — a
  // refusal or an error leaves the state as the poller had it, which is what
  // every turn ran on before this.
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
  // The one case the recheck does not merely inform: the merge landed inside
  // this call but its bookkeeping did not finish, and part of that bookkeeping
  // is deleting the merged head branch on GitHub. Resetting now would recreate
  // that branch for the pending delete to remove. The turn runs un-reset — the
  // pre-docs/282 behaviour — and the next one, against settled state, resets.
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
    // #2429 — the reset re-materialized the whole worktree from the
    // orchestrator, so the compose stack and the dependency tree this container
    // is running may both belong to the pre-reset checkout.
    //
    // The reinstall is asynchronous and the turn starts as soon as this returns,
    // so the agent's first minute can overlap it: gated services are held down
    // by the `setInstallRunning` bracket, and an agent that runs `npm run dev`
    // straight away can collide with npm writing `node_modules`. That is not a
    // new failure class — the file-watcher path (#1622) has the same shape
    // whenever the agent's own edit triggers a reinstall — but this call site
    // concentrates it, because there is no human pause between the trigger and
    // the agent's first command.
    //
    // Awaiting it instead would be worse: an install is minutes on a cold tree,
    // and blocking the user's turn on one is a far larger behaviour change than
    // this bug warrants. The overlap is recoverable and self-announcing (the
    // install streams `install_status` / `install_log`, and the services come
    // back when it lands); a silently stale `node_modules` is neither.
    //
    // Before the card, not after: this cannot throw (`onWorkspaceRewritten`
    // swallows both halves), so it cannot displace the durable record the block
    // below exists to guarantee.
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
    // Everything from here to the return is BOOKKEEPING about a move that has
    // ALREADY happened — the branch is reset and the remote force-pushed. So it
    // must not be able to reject: an exception here would propagate out of this
    // function, past both callers' `try/finally` (which are established AFTER
    // this returns), aborting the turn AND destroying the delivery callbacks —
    // leaving a destructively-moved branch with no card, no notice, and no way
    // to reconstruct one (the re-arm may already have cleared `mergedAt`).
    // `detectAndReArmResetSession` catches only its own git checks; the
    // `clearMerged` / `reArm` / SSE / emit work after them can still throw.
    try {
      // docs/216 + docs/218 — the branch now sits at the clean base, so the
      // lingering "merged" PR card no longer reflects reality. Re-arm NOW (clear
      // merged + reArm poller + emit a gray "ready" card carrying the
      // previousMergedPr breadcrumb) so the PR card flips to the no-current-PR
      // state the moment the branch-updated card appears — rather than lagging
      // until the post-turn `postTurnReArmReset` runs after the whole turn. That
      // post-turn call stays as a fail-safe for the manual-`git reset` path and
      // no-ops here, having already cleared `mergedAt`.
      await detectAndReArmResetSession({
        deps,
        sessionId,
        sessionDir,
        emit: (msg) => runner.emitMessage(msg),
        // The reset itself just fetched and moved the branch onto `origin/<base>`,
        // so the base ref is current — skip the helper's own freshening fetch
        // rather than pay for it in front of the user's turn.
        skipFetch: true,
      });
      // docs/218 — the branch now sits at the fresh base (HEAD !== mergedHeadSha),
      // so the session is no longer reset-eligible. Push `reset_eligible: false`
      // NOW so the composer's "start from the latest base" control disappears the
      // moment the reset runs — rather than lingering for the entire turn until
      // the post-turn recompute fires.
      runner.emitMessage({ type: "reset_eligible", sessionId, eligible: false });
    } catch (err) {
      // The stale merged PR card and the composer control are self-healing (the
      // post-turn `postTurnReArmReset` recomputes both). The transcript record
      // is not, which is why it must survive this.
      console.error(
        `[pre-turn-reset] post-reset bookkeeping failed for ${sessionId} ` +
          `(branch WAS moved to origin/${reset.base}; PR card may lag until post-turn):`,
        err,
      );
    }
  }

  // docs/266 — `skip.notice` is absent when merge detection (or an earlier turn
  // in the same refusal episode) already showed the user this exact paragraph.
  // The skip's agent prefix still rides the turn; only the repeat is dropped.
  const skipNotice = reset.skip?.notice
    ? { notice: reset.skip.notice, level: reset.skip.level }
    : null;

  // One delivery, two triggers, one latch. `emitChatCard` persists in the same
  // call, so whichever fires first is the durable record and the other must not
  // double it. Wrapped: the anchored trigger is called un-awaited and unguarded
  // by the executor, so a throw here would abort the turn setup. A missing card
  // is a regression; a card that kills the turn is a worse one.
  //
  // The two triggers take DIFFERENT persistence routes, and that is not a
  // detail. In-band recording (`recordChatCard` + `persistTurnInProgress`,
  // which `emitChatCard` chooses on `runner.running`) is only correct inside a
  // live turn whose state the executor has already reset. The `ensureRecorded`
  // trigger fires exactly when the turn DIED before reaching the anchor — often
  // before `executeAgentTurn` ran at all, so `resetRunnerTurnState` never
  // cleared the runner and `chatMessageGroups` may still hold the PREVIOUS
  // turn's messages while `running` is still true. Recording in-band there would
  // rewrite that finished turn as `in_progress=1` rows, which the next turn's
  // `replaceInProgress` then deletes wholesale — the docs/236 failure. So the
  // late trigger appends directly instead, landing the record at the current end
  // of history (the same route `emitNoticePostTurn` takes, for the same reason).
  //
  // The latch closes on SUCCESS, not on attempt. Closing it first made the
  // guarantee hollow in exactly the case it exists for: `emitChatCard` emits
  // before it records or persists, so a throwing WS listener consumed the only
  // delivery and left the card in neither `recordedCards` nor durable history —
  // an emit-only transcript card, the failure class CLAUDE.md prohibits — while
  // the late trigger no-opped on a latch that had already flipped. A failed
  // attempt therefore leaves the latch OPEN so the `finally` can retry on the
  // direct-append route. That accepts a duplicate row in one narrow case (the
  // in-band write threw *after* `recordChatCard`, and the turn later flushes
  // its `recordedCards`) — a visible duplicate the client dedupes by `cardId`
  // is strictly better than a destructive move with no record at all.
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
      // docs/266 — the skip notice claimed the refusal episode when the outcome
      // was built, so a write that never lands would silence every later turn
      // under the same refusal as a duplicate. Give the claim back on the LATE
      // route only: the anchored one still has this fallback to retry on, and
      // releasing there would let both attempts write.
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
