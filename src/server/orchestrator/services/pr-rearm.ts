/**
 * docs/202 — re-arm a merged session for a new PR after a rebase.
 *
 * When a merged session's branch is rebased onto its base AND gains genuinely
 * new work, the stale merged PR state should be dropped and the session treated
 * as ready for a fresh PR. The detection is squash-safe (see
 * `GitManager.advancedBeyondMergedBase`) and **turn-gated**: it runs once per
 * assistant turn from the post-turn flow, never from a poller sweep, so a merged
 * session that isn't progressing costs zero GitHub API queries.
 *
 * Both detections are *base-relative*, so they first make sure `origin/<base>`
 * in the session clone is current — a stale remote-tracking ref inverts the
 * answer (see {@link freshenBaseRef}). A branch still sitting on the docs/218
 * merged-tip anchor short-circuits before that fetch ({@link unmovedSinceMerge}),
 * so a merged session that is merely being resumed still costs no network at all.
 *
 * This is factored into a shared helper because there are TWO post-turn entry
 * points that must both re-arm or a rebase in one of them silently fails to:
 *   - the interactive WS-handler path (`ws-handlers/agent-execution.ts`), and
 *   - the dispatch / system-turn path (`runner-registry-factory.ts`, used by
 *     spawned children, CI auto-fix, and programmatic `shipit session message`).
 * Both call this BEFORE delegating to `emitPrLifecycleAfterCommit` for the card,
 * because the re-arm needs `sseBroadcast` + the poller, neither of which is in
 * scope inside `emitPrLifecycleAfterCommit` (its deps only carry the WS `emit`).
 */

import type { PrStatusSummary, SessionInfo, WsServerMessage } from "../../shared/types.js";
import type { GitManager } from "../../shared/git.js";
import type { SessionManager } from "../sessions.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import { freshenBaseRef } from "./freshen-base-ref.js";

export interface ReArmDeps {
  sessionManager: SessionManager;
  prStatusPoller: PrStatusPoller;
  createGitManager: (dir: string) => GitManager;
  sseBroadcast: (event: string, data: unknown) => void;
}

/**
 * Cheap, network-free "this branch has not moved since the merge" check, using
 * the docs/218 anchor (`mergedHeadSha` = the SHA GitHub actually merged). When
 * HEAD still sits exactly on it, the branch carries nothing but already-shipped
 * commits, so NEITHER detection below can be true — the branch is neither
 * progressed past the base nor reset onto it. Short-circuiting here keeps the
 * overwhelmingly common case ("user resumes a merged session, the auto-advance
 * didn't fire") at zero network cost, and makes the decision immune to the
 * remote-tracking staleness described in {@link freshenBaseRef}.
 *
 * Returns false when no anchor is recorded (pre-docs/218 merge, or a merge whose
 * REST payload had no `head.sha`) — those sessions fall through to the
 * fetch-then-compare path, which is what makes them detect correctly at all.
 */
async function unmovedSinceMerge(session: SessionInfo, git: GitManager): Promise<boolean> {
  const anchor = session.mergedHeadSha;
  if (!anchor) return false;
  const head = await git.getHeadHash();
  return head !== null && head === anchor;
}

/**
 * The prior MERGED pull request, or undefined when there isn't one to un-merge.
 *
 * Both re-arm paths take the PR they are un-merging from the poller's live
 * snapshot, and both then hand it to `clearMerged` as the `previousMergedPr`
 * breadcrumb. `session.mergedAt` alone does NOT license that read: the two are
 * written by different subsystems and can disagree. `setPrStatus` overwrites the
 * snapshot with whatever PR the poller currently sees while clearing only
 * `closed_at`, never `merged_at` — so a session carrying a stale merge record
 * next to a freshly-opened PR presents an OPEN snapshot here, and the re-arm
 * would stamp that open PR into the durable `previous_merged_pr` column as if it
 * had merged.
 *
 * That is not a cosmetic mislabel. The breadcrumb seeds
 * `PrStatusPoller.reArm(sessionId, number)` → `supersededPrNumbers`, and
 * `loadPersisted` re-seeds it from the column on every restart; `verifyMissingPr`
 * then reports a terminal result carrying that number as `"suppressed"`. Naming
 * the session's *live* PR there means the poller refuses to promote it when it
 * genuinely merges, and the suppression only lifts once a DIFFERENT-numbered PR
 * appears — merge detection silently off until someone edits the database.
 * Observed in production on 2026-08-19 (session 72f83d85), where a stale
 * `merged_at` survived an unarchive and the re-arm wrote the live open PR #2484
 * as the previously-merged one.
 *
 * The unarchive path that created that stale record is fixed at its source
 * (`clearPriorPrState`); this guard is independent of it, because "the merge
 * record and the live snapshot disagree" must never be resolved in favour of the
 * snapshot. Fail safe: stay merged and let the state be corrected elsewhere.
 */
function priorMergedPr(deps: ReArmDeps, sessionId: string): PrStatusSummary | undefined {
  const prior = deps.prStatusPoller.getStatus(sessionId);
  if (!prior?.baseBranch) return undefined;
  if (prior.prState !== "merged") {
    console.warn(
      `[pr-rearm] ${sessionId} is marked merged but its PR snapshot (#${prior.prNumber}) `
      + `is ${prior.prState} — staying merged rather than recording an unmerged PR as the prior one`,
    );
    return undefined;
  }
  return prior;
}

/**
 * Detect whether a MERGED session's branch has progressed past its base and, if
 * so, re-arm it. Returns true when the session was re-armed, false (no-op) for a
 * non-merged session, one without a known prior base, or a branch that hasn't
 * progressed — the common case.
 *
 * On progress:
 *   1. `clearMerged` — un-merge (clears `merged_at`) and stash the prior PR's
 *      `previousMergedPr` breadcrumb (number + url + title + baseBranch). This
 *      alone pulls the session back into Active/gray and off the fast merged
 *      eviction ladder.
 *   2. `poller.reArm` — silently clear the poller's terminal state and record
 *      the superseded PR number so the immediate forced poll can't re-promote
 *      the old merged PR before the new one opens.
 *   3. SSE `session_list` rebroadcast — the sidebar regroups from the session
 *      list over SSE only, so without this the row would stay in "Recently
 *      resolved" with the merge icon until a reload.
 *
 * The card itself (ready/creating/open, carrying the breadcrumb) is emitted by
 * `emitPrLifecycleAfterCommit` afterwards — it re-reads the now-un-merged
 * session and threads `previousMergedPr` through.
 */
export async function detectAndReArmMergedSession(args: {
  deps: ReArmDeps;
  sessionId: string;
  sessionDir: string;
}): Promise<boolean> {
  const { deps, sessionId, sessionDir } = args;
  const session = deps.sessionManager.get(sessionId);
  if (!session?.mergedAt) return false;

  // The prior merged PR drives both the detection base and the breadcrumb.
  // `getStatus` holds the merged snapshot (seeded from persisted on restart) —
  // but only a snapshot that actually says "merged" may be used (see
  // {@link priorMergedPr}).
  const prior = priorMergedPr(deps, sessionId);
  if (!prior) return false; // no known base, or a non-merged snapshot — fail safe
  const baseBranch = prior.baseBranch;

  let progressed: boolean;
  try {
    const git = deps.createGitManager(sessionDir);
    // The branch still sitting on the merged tip can't have progressed — decide
    // locally and skip the fetch entirely (see `unmovedSinceMerge`).
    if (await unmovedSinceMerge(session, git)) return false;
    // `advancedBeyondMergedBase` is base-relative, so the base ref must be
    // current or it false-positives (see `freshenBaseRef`).
    if (!(await freshenBaseRef(git, sessionId))) return false;
    progressed = await git.advancedBeyondMergedBase(baseBranch);
  } catch {
    return false; // workspace evicted / git error — fail safe, stay merged
  }
  if (!progressed) return false;

  deps.sessionManager.clearMerged(sessionId, {
    number: prior.prNumber,
    url: prior.prUrl,
    title: prior.prTitle,
    baseBranch,
    // Carry the merged-tip anchor across the clear (see `PreviousMergedPr
    // .mergedHeadSha`): the column is nulled here, and the explicit
    // reset-to-base gate reads it, so without this a re-armed session is
    // force-only forever.
    ...(session.mergedHeadSha ? { mergedHeadSha: session.mergedHeadSha } : {}),
  });
  deps.prStatusPoller.reArm(sessionId, prior.prNumber);
  deps.sseBroadcast("session_list", { sessions: deps.sessionManager.list() });
  return true;
}

/**
 * docs/216 — re-arm a MERGED session whose branch was reset back to a clean
 * base (e.g. `git reset --hard origin/main` after the PR merged). The branch is
 * now identical to the base with no commits ahead, so the lingering "merged" PR
 * card no longer reflects the session's current state — it should show as a
 * clean session with no current PR, ready to start fresh work.
 *
 * Distinct from {@link detectAndReArmMergedSession} (rebased + new work) on two
 * axes:
 *   - **Trigger.** A reset leaves a clean tree, so the turn produces no
 *     auto-commit and the commit-gated post-turn PR flow never runs. This must
 *     therefore be driven from an EVERY-turn hook (like the release flow), not
 *     the commit-gated path.
 *   - **Outcome.** There is no new work to open a PR from, so this emits a clean
 *     "ready" card (0 diff) carrying the `previousMergedPr` breadcrumb instead
 *     of auto-creating a PR. The breadcrumb is what lets the card override the
 *     active viewer's stale terminal merged card in `pr-store.updateCard`'s
 *     regress guard — re-arm broadcasts no destructive `pr_status` removal, so
 *     this override is the sole path that clears the merged card live.
 *
 * The two detections are mutually exclusive: "at base" means zero commits ahead
 * (empty two-dot diff), while "progressed" requires a non-empty diff. So the
 * every-turn reset hook no-ops on a normal commit turn (HEAD is ahead of base).
 *
 * Returns true when the session was re-armed, false (no-op) for a non-merged
 * session, one without a known prior base, or a branch not sitting at the base.
 */
export async function detectAndReArmResetSession(args: {
  deps: ReArmDeps;
  sessionId: string;
  sessionDir: string;
  emit: (msg: WsServerMessage) => void;
  /**
   * Skip the base-ref freshening fetch because the caller just did one. Passed
   * by the docs/218 pre-turn reset path, which fetches, resets onto
   * `origin/<base>`, and then calls this immediately — a second fetch there
   * would add network latency in front of the user's turn for no new
   * information. Every other caller leaves it unset (see `freshenBaseRef`).
   */
  skipFetch?: boolean;
}): Promise<boolean> {
  const { deps, sessionId, sessionDir, emit } = args;
  const session = deps.sessionManager.get(sessionId);
  if (!session?.mergedAt) return false;

  // The prior merged PR drives both the detection base and the breadcrumb, and
  // only a snapshot that says "merged" qualifies (see {@link priorMergedPr}).
  const prior = priorMergedPr(deps, sessionId);
  if (!prior) return false; // no known base, or a non-merged snapshot — fail safe
  const baseBranch = prior.baseBranch;

  let atBase: boolean;
  try {
    const git = deps.createGitManager(sessionDir);
    // A branch still on the merged tip is not at the base — decide locally and
    // skip the fetch (see `unmovedSinceMerge`).
    if (await unmovedSinceMerge(session, git)) return false;
    // `headIsAtBase` compares against `origin/<base>`, so a stale ref would read
    // a branch reset onto an OLD base tip as "at base" (see `freshenBaseRef`).
    if (!args.skipFetch && !(await freshenBaseRef(git, sessionId))) return false;
    atBase = await git.headIsAtBase(baseBranch);
  } catch {
    return false; // workspace evicted / git error — fail safe, stay merged
  }
  if (!atBase) return false;

  const previousMergedPr = {
    number: prior.prNumber,
    url: prior.prUrl,
    title: prior.prTitle,
    baseBranch,
  };
  // The stored breadcrumb also carries the merged-tip anchor — see the sibling
  // call in `detectAndReArmMergedSession`. The card below deliberately does not:
  // the anchor is gate state, not something the client renders.
  deps.sessionManager.clearMerged(sessionId, {
    ...previousMergedPr,
    ...(session.mergedHeadSha ? { mergedHeadSha: session.mergedHeadSha } : {}),
  });
  deps.prStatusPoller.reArm(sessionId, prior.prNumber);
  deps.sseBroadcast("session_list", { sessions: deps.sessionManager.list() });

  // Emit a clean "ready" card (0 diff, no auto-create — the branch is at the
  // base with nothing to open a PR from). The `previousMergedPr` breadcrumb
  // both renders the "Previously merged #N" note and overrides the active
  // viewer's stale terminal merged card (the silent re-arm broadcasts no
  // removal to clear it otherwise).
  emit({
    type: "pr_lifecycle_update",
    sessionId,
    cardId: `pr-card-${sessionId}`,
    phase: "ready",
    headBranch: session.branch ?? baseBranch,
    totalInsertions: 0,
    totalDeletions: 0,
    previousMergedPr,
  });
  return true;
}
