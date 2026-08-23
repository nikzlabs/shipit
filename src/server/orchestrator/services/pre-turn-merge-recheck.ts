/**
 * docs/282 — close the poll-window race between a merge and the turn that
 * follows it, by refreshing the merge state AT turn admission.
 *
 * ## The race
 *
 * Merge detection is poll-driven (`PR_STATUS_POLL_INTERVAL_MS = 15_000`), so the
 * orchestrator can learn about a merge up to a poll interval after GitHub
 * records it. The docs/218 reset is, by construction, a PRE-turn gate. A turn
 * admitted inside that window therefore evaluates the gate against a session
 * that does not read as merged yet, gets the `not-merged` clause — the ordinary
 * state of nearly every session, and correctly silent — and runs on the branch
 * exactly as it was. Its post-turn commit then lands stacked on already-shipped
 * history, the docs/266 merged-push guard (correctly) refuses the push, and the
 * session is stranded on a branch it cannot ship from.
 *
 * The production incident (session 15ff6abd, PR #101 of nicolasalt/reward-tag,
 * 2026-08-22) took 1.5 seconds to hit: the user clicked merge at 19:32:02 and
 * typed their next message at 19:32:03.54; the poller reached the merge at
 * 19:32:05.27, 1.7 s after the gate had already answered. Nothing about that
 * sequence is unusual — "merge, then say what's next" is the normal way to use
 * the product, and the whole 15-second window is exposed to it.
 *
 * ## What this does about it
 *
 * One definitive, single-session probe of the PR's true state, run before the
 * gate, in the narrow state where the answer could change the outcome. If it
 * comes back merged, the ordinary docs/218 reset runs in its ordinary place with
 * its ordinary safety gate, card, agent prefix and re-arm — this module decides
 * nothing about the branch and never touches it.
 *
 * Deliberately NOT the alternative of resetting when the merge is detected
 * mid-turn: at that moment an agent is running against the worktree, and a
 * `reset --hard` under it re-materializes files it has already read and may have
 * begun editing. Moving the *freshness* problem is enough; moving the
 * destructive move into the turn is not.
 *
 * ## Why it is affordable
 *
 * Two gates stand in front of the network, and both are free or nearly so:
 *
 *   - the poller's last observation must say this session has an **open** PR.
 *     No open PR ⇒ nothing could have merged out from under us. In-memory.
 *   - a reset must be **applicable**: the branch fully pushed (HEAD equals the
 *     local `origin/<session-branch>` ref, so if the PR merged then HEAD *is* the
 *     merged head), plus {@link checkResetPreconditions} — the same clean-tree /
 *     on-branch / no-sequencer clauses the reset itself requires. When any of
 *     these fails the gate would refuse the reset anyway, so a fresh merge state
 *     could not change what happens.
 *
 * So the cost lands on turns of sessions with an open PR and a clean, pushed
 * branch: one REST probe (plus the canonical-owner GraphQL probe
 * `forceVerifySessionPrState` needs for transferred repos), bounded by
 * {@link MERGE_RECHECK_TIMEOUT_MS}. It is NOT gated on the
 * `autoResetMergedBranch` setting: with the setting off the reset is skipped but
 * the skip's transcript notice and agent prefix still fire, and "your pull
 * request merged, this branch is dead, do not commit here" is exactly the fact
 * whose absence produced the incident.
 *
 * Fail-safe in one direction only: any refusal, error or timeout leaves the
 * merge state exactly as the poller had it, and the turn proceeds as it does
 * today.
 */

import type { SessionInfo } from "../../shared/types.js";
import type { GitManager } from "../../shared/git.js";
import type { PrStatusSummary } from "../../shared/types/github-types.js";
import { checkResetPreconditions } from "./pre-turn-reset.js";

/**
 * How long the recheck will wait on GitHub plus the merge bookkeeping before
 * giving up and letting the turn start.
 *
 * It bounds two calls whose own failure modes are not this feature's to fix: a
 * REST probe with no client-side deadline, and `onMergeDetectedCb`, which does
 * container pruning, a remote branch delete and a bare-cache refresh. Neither
 * may be able to strand a user's turn — an expired budget costs the reset for
 * this one turn (the poller reports the merge moments later, exactly as it does
 * today), while a hang would cost the turn entirely.
 */
export const MERGE_RECHECK_TIMEOUT_MS = 8_000;

export interface PreTurnMergeRecheckDeps {
  getSession: (id: string) => SessionInfo | undefined;
  /** The poller's last observation for this session (persisted snapshot). */
  getPrStatus: (id: string) => PrStatusSummary | null;
  createGitManager: (dir: string) => GitManager;
  /**
   * The definitive any-state probe of ONE session's PR —
   * `PrStatusPoller.forceVerifySessionPrState` with the `verifiedAbsent`
   * debounce left un-armed (see that method for why arming here would delay
   * detection of the NEXT merge).
   */
  verifyPrState: (sessionId: string) => Promise<void>;
  /**
   * `PrStatusPoller.awaitMergeHandling` — resolves once the callback that stamps
   * `merged_at` has settled. Without it the probe can resolve on a session that
   * has been found merged but does not read as merged yet, which is the very
   * distinction this module exists to stop turning on timing.
   */
  awaitMergeHandling: (sessionId: string) => Promise<void>;
}

/**
 * Refresh this session's merge state before the docs/218 gate runs. Returns
 * true only when the recheck itself discovered the merge — the caller uses that
 * for one log line; the reset decision stays entirely with the gate, which reads
 * the session state this may have just updated.
 */
export async function recheckMergeBeforeTurn(
  deps: PreTurnMergeRecheckDeps,
  sessionId: string,
  sessionDir: string,
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  try {
    const session = deps.getSession(sessionId);
    // Already merged as far as ShipIt is concerned: the gate has everything it
    // needs and a probe would tell it nothing new. Same for a session with no
    // branch or no remote — there is no pull request to have merged.
    if (!session || session.mergedAt || !session.branch || !session.remoteUrl) return false;

    // The cheapest and most selective clause, and the only in-memory one: a
    // session whose last observation is anything but an OPEN pull request has
    // nothing that could have merged since.
    if (deps.getPrStatus(sessionId)?.prState !== "open") return false;

    const git = deps.createGitManager(sessionDir);

    // Would a reset be applicable at all? Cheapest first: a branch carrying
    // unpushed commits fails the gate's `head-moved` clause however fresh the
    // merge state is, and the equality also buys the fact the gate will need —
    // HEAD is the commit GitHub would have merged.
    const head = await git.getHeadHash();
    if (!head || head !== (await git.getRefHash(`origin/${session.branch}`))) return false;
    if (await checkResetPreconditions(session, git)) return false;

    // The only network in this module. Both halves are bounded together: the
    // probe records the merge, the wait lets `merged_at` land (see the dep).
    await withTimeout(
      (async () => {
        await deps.verifyPrState(sessionId);
        await deps.awaitMergeHandling(sessionId);
      })(),
      opts.timeoutMs ?? MERGE_RECHECK_TIMEOUT_MS,
      sessionId,
    );

    const merged = Boolean(deps.getSession(sessionId)?.mergedAt);
    if (merged) {
      // The ops line for this race. An investigation that finds a turn running
      // on a freshly-reset branch needs to see that the merge was discovered
      // HERE and not by the poller, because the poller's own line lands after.
      console.log(
        `[pre-turn-reset] merge observed at turn admission for ${sessionId} — the poller had not `
          + "seen it yet; the branch reset is decided against the fresh state",
      );
    }
    return merged;
  } catch (err) {
    console.warn(
      `[pre-turn-reset] merge recheck failed for ${sessionId} (running the turn on the poller's `
        + "last known state):",
      err,
    );
    return false;
  }
}

/**
 * Resolve `work`, or reject once `ms` has passed. The timer is always cleared,
 * so a fast path leaves nothing holding the event loop open.
 *
 * The bare `catch` is not redundant with the race: on a timeout the race is
 * already settled, so a LATER rejection from `work` has no handler and would
 * surface as an unhandled rejection. Attaching one leaves the race's own view of
 * `work` untouched, so a rejection that arrives *before* the deadline still
 * propagates to the caller.
 */
async function withTimeout(work: Promise<void>, ms: number, sessionId: string): Promise<void> {
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => { reject(new Error(`merge recheck for ${sessionId} exceeded ${ms}ms`)); },
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
