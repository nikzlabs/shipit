/**
 * docs/218 — auto-reset a merged session's branch to the latest base when work
 * continues.
 *
 * After a session's PR merges, the branch is left exactly at its pre-merge tip,
 * sitting behind the advanced base. When the user resumes the session with a new
 * message, this runs in the PRE-TURN path (so a live, rehydrated workspace exists
 * and the move has a purpose — see plan.md "Why lazy, not eager") and, with the
 * user's consent, moves the branch to `origin/<base>` before the agent turn runs:
 *
 *   gate → `git fetch origin` → RE-gate (TOCTOU) → `git reset --hard origin/<base>`
 *     → force-with-lease heal of `origin/<session-branch>`
 *
 * The trailing force-push heals the REMOTE: the reset moves only the local
 * branch, leaving the session's remote branch on the old merged commits (it
 * survives whenever the repo has auto-delete off), so without this every later
 * plain auto-push is a silently-dropped non-fast-forward. See the heal block
 * below for the full rationale and the docs/218 safety-net tradeoff.
 *
 * A hard reset is destructive, so it fires ONLY behind the full safety gate
 * ({@link computeResetEligible}). The branch has no new work (every commit is
 * already shipped via the merge), so a clean reset — not a rebase — is the
 * squash-safe move (nothing to replay). The caller prepends the returned
 * `agentPrefix` to the turn's prompt (so the agent starts fresh and doesn't
 * re-apply shipped work) and emits a persisted card from the returned move info.
 *
 * Everything here is fail-safe: any gate failure or git error leaves the branch
 * un-moved and the turn runs normally — the user falls back to today's manual
 * flow (still picked up by the docs/202 / docs/216 re-arm).
 *
 * planning#297 — fail-safe is not the same as silent. A skip on a MERGED session
 * leaves the branch on commits that are already shipped and whose pull request
 * is closed, so it now reports the clause that refused (log line + persisted
 * transcript notice + agent prompt prefix) instead of returning a bare
 * {@link NOT_MOVED}. Non-merged sessions still skip silently: there is nothing
 * to reset and nothing to say. See {@link skipped}.
 *
 * docs/266 — and it is now said at the moment it happens, not at the next turn.
 * The planning#297 notice is built on the PRE-TURN path, so a refusal detected when
 * the pull request MERGED reached the user only when they next sent a message —
 * which may be much later, or never. {@link announceResetStateOnMerge} runs at
 * merge detection and writes the same refusal into the transcript there;
 * {@link skipped} then suppresses the repeat while the refusing clause is
 * unchanged. See that function for the clause set and the episode rule.
 */

import type { SessionInfo } from "../../shared/types.js";
import type { GitManager } from "../../shared/git.js";
import type { PrStatusSummary } from "../../shared/types/github-types.js";
import type { WsServerMessage } from "../../shared/types/ws-server-messages.js";
import { handWorkspaceBackToWorker } from "../session-worker-uid.js";
import {
  emitNoticeInTurn,
  persistNoticeUnattached,
  type InProgressPersister,
} from "../chat-card-persistence.js";

export interface PreTurnResetDeps {
  getSession: (id: string) => SessionInfo | undefined;
  getPrStatus: (id: string) => PrStatusSummary | null;
  createGitManager: (dir: string) => GitManager;
  getAutoResetMergedBranch: () => boolean;
}

/** The deps the safety-only eligibility *signal* needs (no global-setting gate). */
export type ResetEligibleSignalDeps = Omit<PreTurnResetDeps, "getAutoResetMergedBranch">;

export interface ResetOutcome {
  /** True only when the branch was actually moved. */
  moved: boolean;
  base?: string;
  prNumber?: number;
  prUrl?: string;
  /** Short-able HEAD SHAs before → after the reset (for the transcript card). */
  fromSha?: string;
  toSha?: string;
  /** The `[System] …` prefix to prepend to the turn's prompt (agent-facing). */
  agentPrefix?: string;
  /**
   * planning#297 — set when the session IS merged and the reset was nonetheless
   * skipped. Carries the clause that blocked it plus the ready-to-emit user
   * notice; the caller persists `notice` into the transcript and prepends
   * `agentPrefix` to the turn. Absent on a non-merged session (nothing to say)
   * and on a successful move.
   */
  skip?: ResetSkipInfo;
}

/** Which clause of the gate refused the reset. Stable ids — logs + tests key off these. */
export type ResetSkipClause =
  | "not-merged"
  | "setting-off"
  | "opted-out"
  | "no-merged-head-sha"
  | "no-base-branch"
  | "dirty-tree"
  | "detached-head"
  | "wrong-branch"
  | "rebase-in-progress"
  | "sequencer-in-progress"
  | "head-moved";

/** The structural clauses {@link checkResetPreconditions} can refuse on — the
 * subset that `--force` does NOT bypass. */
export type ResetPreconditionClause = Extract<
  ResetSkipClause,
  "dirty-tree" | "detached-head" | "wrong-branch" | "rebase-in-progress" | "sequencer-in-progress"
>;

export interface ResetSkip {
  clause: ResetSkipClause;
  /** A sentence fragment completing "…was not reset because <detail>". */
  detail: string;
}

export interface ResetSkipInfo extends ResetSkip {
  /**
   * The persisted transcript notice the caller emits.
   *
   * docs/266 — ABSENT when the user has already read this exact refusal, because
   * {@link announceResetStateOnMerge} wrote it at merge detection and the
   * refusing clause has not changed since. The skip itself is still reported
   * (log line + {@link ResetOutcome.agentPrefix}); only the paragraph the user
   * would be reading for the second time is dropped.
   */
  notice?: string;
  /**
   * `warn` for a safety clause the user has to act on, `info` for the two
   * deliberate opt-outs (global setting off, per-send untick) — those are the
   * user's own choice, so they get a record without an alarm.
   */
  level: "info" | "warn";
}

const NOT_MOVED: ResetOutcome = { moved: false };

/** How many uncommitted paths the `dirty-tree` detail names before it summarises the rest. */
const DIRTY_PATH_LIMIT = 10;

/**
 * docs/266 — the sessions whose current refusal EPISODE has already produced a
 * transcript notice, and which clause it was about.
 *
 * Two emitters now write the same paragraph: {@link announceResetStateOnMerge}
 * at merge detection, and {@link skipped} at the start of the next turn. Without
 * this the user reads it twice in a row for one unchanged fact — the shape
 * `auto-push-scheduler.ts` already rejected for diverged pushes ("nine identical
 * notices is noise that trains the reader to skip the tenth").
 *
 * Keyed on the CLAUSE, not a bare flag, so the episode ends the moment the
 * refusal becomes a different one: a dirty tree the user commits away, followed
 * by a `head-moved` refusal for those new commits, is a new fact and is said
 * again. {@link clearResetSkipEpisode} ends it when the gate stops refusing at
 * all.
 *
 * Same two bounded imprecisions the auto-push episode set states rather than
 * engineers away. It holds one clause per session that was refused in this
 * process's lifetime and is not pruned on teardown (the cost is a session id and
 * a short string). And it does not survive an orchestrator restart, so a
 * still-standing refusal is said once more after one — the safe direction: a
 * repeated warning about a real problem, never a swallowed one.
 */
const notifiedSkipClause = new Map<string, string>();

/**
 * End the current refusal episode. Called on every outcome that means "the
 * refusal the user was told about no longer holds" — a successful reset (either
 * mode), a branch already at the base, a session the re-arm un-merged, an
 * eligible gate at merge detection, and a delivery that failed after claiming.
 * Exported for tests, which share module state.
 *
 * These clears are the fast path, not the guarantee. The guarantee is
 * {@link episodeKey}: an entry belongs to ONE merged pull request, so a clear
 * this function never reaches cannot suppress a later merge's notice.
 */
export function clearResetSkipEpisode(sessionId: string): void {
  notifiedSkipClause.delete(sessionId);
}

/**
 * The episode's identity: the merge it is about, plus the clause that refused.
 *
 * Keying on the clause alone made the entry outlive the merge it described, and
 * "did we clear it on every path that resolves a refusal?" is not a question
 * with a checkable answer — the resolving paths are the two reset modes, both
 * re-arms, and any interval in which the gate simply became eligible. A stale
 * entry there is not noise, it is SILENCE: a second pull request merging into
 * the same dirty tree would match the first one's entry and say nothing, which
 * is the whole defect this feature fixes.
 *
 * The merge anchor removes that class rather than chasing it. `mergedHeadSha` is
 * the commit GitHub merged, so a different merge is a different key by
 * construction; the `previousMergedPr` breadcrumb is the durable fallback for
 * the window after a re-arm nulls the live fields (the same fallback the gate
 * itself uses), and an empty anchor simply degrades to clause-only for a session
 * that has neither — which cannot be a merged session at all.
 */
function episodeKey(clause: ResetSkipClause, session: SessionInfo | undefined): string {
  const anchor =
    session?.mergedHeadSha
    ?? session?.previousMergedPr?.mergedHeadSha
    ?? (session?.previousMergedPr?.number !== undefined ? `pr-${session.previousMergedPr.number}` : "");
  return `${anchor}|${clause}`;
}

/**
 * Should this refusal produce a user-facing notice? True unless the user has
 * already read this exact refusal, for this merge, on this session. Records it
 * as told when it returns true, so each emitter both asks and claims in one
 * step; a caller whose delivery then fails calls {@link clearResetSkipEpisode}
 * to give the claim back.
 */
function claimSkipNotice(
  sessionId: string,
  clause: ResetSkipClause,
  session: SessionInfo | undefined,
): boolean {
  const key = episodeKey(clause, session);
  if (notifiedSkipClause.get(sessionId) === key) return false;
  notifiedSkipClause.set(sessionId, key);
  return true;
}

/**
 * planning#341 — name the files that made the tree dirty, as a fragment appended to
 * the `dirty-tree` detail.
 *
 * `detail` is the single string every skip surface is built from — the
 * `console.warn`, the persisted transcript notice, and the agent prompt prefix —
 * so putting the paths here puts them in all three at once, which is what the ops
 * investigation needed and what the user needs in order to act ("the working tree
 * has uncommitted changes" is unactionable when you did not knowingly change
 * anything; the motivating incident's writer was a compose service mounting the
 * workspace read-write, not the user).
 *
 * Capped at {@link DIRTY_PATH_LIMIT} with a `+N more` count: a `git reset --hard`
 * that clobbers a dependency tree can leave thousands of paths dirty, and an
 * unbounded list would push the notice past anything a person reads.
 *
 * Sorted so the log line and the notice are stable across runs (git's status order
 * is not), and fail-safe: a throw or an empty result degrades to the bare sentence
 * rather than losing the refusal itself. Called only on the refusal path, so the
 * second `git status` costs nothing on the healthy one.
 *
 * No trailing period — the caller's templates continue the sentence.
 */
async function formatDirtyPaths(git: GitManager): Promise<string> {
  let paths: string[];
  try {
    paths = [...(await git.uncommittedPaths())].sort();
  } catch {
    return "";
  }
  if (paths.length === 0) return "";
  const shown = paths.slice(0, DIRTY_PATH_LIMIT);
  const extra = paths.length - shown.length;
  return ` — uncommitted paths: ${shown.join(", ")}${extra > 0 ? ` (+${extra} more)` : ""}`;
}

/**
 * The SAFETY-ONLY eligibility gate — "this branch carries nothing that isn't
 * already merged AND the repo is in a plain, resettable state." Deliberately
 * EXCLUDES the global setting and the per-send intent (those gate whether the
 * user *wants* a reset; this gates whether one is *safe*). Surfaced to the client
 * as the transient `resetEligible` signal in Phase 3.
 *
 * All clauses must hold; any failure → not eligible → no reset:
 *   - the session has a merged pull request — live, or recorded in the durable
 *     `previousMergedPr` breadcrumb a re-arm leaves behind,
 *   - that PR's base branch is known (the reset target),
 *   - the working tree is clean (a hard reset over uncommitted edits is the one
 *     irreversible loss — committed work is reflog-recoverable, edits are not),
 *   - HEAD is on `session.branch`, not detached (a reset wouldn't move the branch),
 *   - no rebase/merge/cherry-pick/revert in progress (a reset clobbers recovery),
 *   - and the branch provably carries no unshipped work, by EITHER of two
 *     independent proofs: HEAD is an ancestor of `origin/<base>` (so a reset
 *     discards nothing at all), or **`HEAD === mergedHeadSha`** — the recorded
 *     merged tip, which is the only *stored* signal that reliably distinguishes
 *     "untouched since merge" from "new un-rebased work" (deriving that from
 *     `advancedBeyondMergedBase`/`headIsAtBase` has a data-loss hole — see
 *     plan.md "Safety gate").
 */
export async function computeResetEligible(
  session: SessionInfo | undefined,
  prStatus: PrStatusSummary | null,
  git: GitManager,
): Promise<boolean> {
  return (await computeResetBlocker(session, prStatus, git)) === null;
}

/**
 * planning#297 — {@link computeResetEligible}'s single implementation, returning
 * WHICH clause refused instead of a bare boolean. Null = eligible.
 *
 * The clause has to come out of the same evaluation that decides eligibility,
 * not a parallel "explain why" helper: two implementations of a nine-clause
 * safety gate drift, and the one that drifts is the explanation — which is
 * exactly the surface a user reads to decide what to do about it.
 *
 * `not-merged` is in the union for totality only. It is not a failure mode —
 * it is the ordinary state of nearly every session — so no notice is ever built
 * from it: the notice path gates on `session.mergedAt` before asking.
 *
 * ## The merged record is read DURABLY, and the anchor clause is not the only
 * proof of safety
 *
 * Two clauses used to read state that a docs/202 / docs/216 re-arm deletes.
 * `clearMerged` nulls BOTH `merged_at` and `merged_head_sha` in one statement,
 * and `PrStatusPoller.reArm` nulls the live PR snapshot in the same beat — so a
 * session that merged and then kept working could never satisfy `not-merged`,
 * `no-merged-head-sha` or `no-base-branch` again, whatever its branch looked
 * like. It was force-only forever, and (the reported bug) it refused naming a
 * clause about unshipped work when the real one was `not-merged`. All three now
 * read the durable `previousMergedPr` breadcrumb as a fallback: the merged
 * *state* is gone after a re-arm, the merged *fact* is not.
 *
 * The ancestry clause is the second half. `HEAD === mergedHeadSha` proves
 * "untouched since the merge", which is sufficient but not necessary: when HEAD
 * is an ancestor of `origin/<base>`, every commit reachable from the branch is
 * already reachable from the base, so a reset discards nothing **by
 * construction** — no stored anchor, and no trust in the caller, required. It is
 * the general case of the `head === baseTip` idempotence short-circuit in
 * {@link resetBranchToBaseExplicit}, which only ever caught the exact-equality
 * instant. This is NOT the data-loss shortcut docs/218's plan rejected
 * (`!advancedBeyondMergedBase && !headIsAtBase`): a user who commits without
 * rebasing puts a commit on HEAD that is not in the base, so HEAD stops being an
 * ancestor and the clause simply does not fire.
 *
 * Unlike every other clause it reads a REMOTE-TRACKING ref, so it is only as
 * fresh as the caller's last fetch — and two callers evaluate it stale. Neither
 * can lose data by it, and the failure directions are worth stating:
 *   - the automatic path's PRE-fetch gate can refuse against an outdated
 *     `origin/<base>` (conservative), and can pass against one that was since
 *     rewound — but it re-evaluates the whole gate after the fetch, and that is
 *     the evaluation the reset acts on;
 *   - the client `reset_eligible` signal never fetches, so it can advertise a
 *     reset that send-time revalidation then refuses. That is the planning#341
 *     stale-signal class, in its fail-safe direction: the server re-validates,
 *     so the promise is over-eager, never the destruction.
 */
export async function computeResetBlocker(
  session: SessionInfo | undefined,
  prStatus: PrStatusSummary | null,
  git: GitManager,
): Promise<ResetSkip | null> {
  if (!session || (!session.mergedAt && !session.previousMergedPr)) {
    return { clause: "not-merged", detail: "this session has no merged pull request" };
  }
  const base = resolveResetBase(session, prStatus);
  if (!base) {
    return {
      clause: "no-base-branch",
      detail: "the merged pull request's base branch is not recorded, so there is no reset target",
    };
  }

  const precondition = await checkResetPreconditions(session, git);
  if (precondition) return precondition;

  // Provable safety, checked before the anchor because it needs no anchor: a
  // branch fully contained in `origin/<base>` loses nothing to a reset.
  const head = await git.getHeadHash();
  if (head && (await git.isAncestor(head, `origin/${base}`))) return null;

  const mergedHeadSha = session.mergedHeadSha ?? session.previousMergedPr?.mergedHeadSha;
  if (!mergedHeadSha) {
    return {
      clause: "no-merged-head-sha",
      detail:
        "ShipIt has no record of the commit GitHub merged, so it cannot prove this branch "
        + "carries only already-shipped work",
    };
  }
  if (!head || head !== mergedHeadSha) {
    return {
      clause: "head-moved",
      detail:
        "the branch has moved since the merge and is not contained in "
        + `origin/${base}, so it carries commits that were never shipped`,
    };
  }

  return null;
}

/**
 * Run the pre-turn auto-reset. Returns {@link NOT_MOVED} when the session isn't
 * merged or anything throws (fail-safe); on a merged session whose reset was
 * refused, returns the same `moved: false` plus a {@link ResetSkipInfo} the
 * caller surfaces (planning#297). On a real move, returns the base + PR pointers +
 * before/after SHAs + the agent prompt prefix.
 *
 * The gate is evaluated TWICE — once before the fetch and once after — because
 * `git fetch` yields to the event loop, during which a terminal edit or a queued
 * agent turn could move the branch out from under us (TOCTOU).
 */
/**
 * Safety-only eligibility for a session, used to drive the client's composer
 * control visibility (`reset_eligible` signal). EXCLUDES the global setting and
 * the per-send intent — the client ANDs this with `autoResetMergedBranch`, and
 * the pre-turn helper re-validates the full gate at send time, so this is purely
 * "would a reset be safe right now?". Fail-safe false (and cheap-exits for
 * non-merged sessions via `computeResetEligible`).
 */
export async function isResetEligible(
  deps: ResetEligibleSignalDeps,
  sessionId: string,
  sessionDir: string,
): Promise<boolean> {
  return (await computeResetEligibility(deps, sessionId, sessionDir)).eligible;
}

/** The signal plus enough context to explain it — see {@link computeResetEligibility}. */
export interface ResetEligibility {
  /** The value pushed to the client as `reset_eligible`. */
  eligible: boolean;
  /**
   * Whether this session has a merged pull request at all. False is the ordinary
   * state of nearly every session and means the signal carries no information —
   * callers use it to stay quiet rather than logging `eligible=false` fleet-wide.
   */
  merged: boolean;
  /** On a merged, ineligible session: which clause refused. Null otherwise. */
  blocker: ResetSkip | null;
  /**
   * Set when the computation itself failed. The result is still a fail-safe
   * `eligible: false`, but the *reason* is "git threw", not "a clause refused" —
   * and that is the ambiguous operational case this whole record exists to
   * remove, so it must not be swallowed into a bare false.
   */
  error?: string;
}

/**
 * {@link isResetEligible}'s implementation, keeping the *reason* alongside the
 * boolean so {@link emitResetEligible} can log it. Same cheap-exit and same
 * fail-safe-false as before — a git throw is not a reason to block a turn.
 */
export async function computeResetEligibility(
  deps: ResetEligibleSignalDeps,
  sessionId: string,
  sessionDir: string,
): Promise<ResetEligibility> {
  // Tracked outside the try so a throw still reports WHICH kind of session it
  // threw for: a merged session that fails closed on a git error is a reportable
  // event, and collapsing it into the non-merged `false` would hide it from the
  // log that exists to explain exactly this.
  let merged = false;
  try {
    const session = deps.getSession(sessionId);
    if (!session?.mergedAt) return { eligible: false, merged: false, blocker: null }; // cheap-exit before constructing git
    merged = true;
    const prStatus = deps.getPrStatus(sessionId);
    const git = deps.createGitManager(sessionDir);
    const blocker = await computeResetBlocker(session, prStatus, git);
    return { eligible: blocker === null, merged: true, blocker };
  } catch (err) {
    return { eligible: false, merged, blocker: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Where a `reset_eligible` push came from. Log-only, but the point of the log
 * line is to tell these apart — see {@link emitResetEligible}.
 */
export type ResetEligibleOrigin =
  | "activation"
  | "post-turn"
  | "merge-detected"
  | "file-change";

/**
 * Recompute the safety-only eligibility signal, log it, and push it to a
 * session's attached viewers.
 *
 * The single emit path for `reset_eligible`, so the four moments that recompute
 * it (session activation, post-turn, merge detection, and planning#341's file-watcher
 * recompute) cannot drift in what they compute or in what they record.
 *
 * planning#341 — the log line exists because the ops investigation into a refused
 * reset could not distinguish "the client was holding a stale `true`" from "the
 * tree became dirty after the signal was correct": neither the emitted value nor
 * its reason was written down anywhere. It logs the value, the origin, and (when
 * false) the clause and detail that refused — which for `dirty-tree` now names
 * the paths — or the error, when git failed and the answer is a fail-safe false
 * rather than a refusal. Only for MERGED sessions: for everything else the answer
 * is a constant false and logging it would bury the interesting lines.
 *
 * **Every caller emits unconditionally, and none of them may suppress a push
 * against a value it remembers privately.** The client holds ONE value per
 * session and simply takes whichever message arrived last, so a per-emitter
 * "I already said false" check reasons about the wrong state: an unconditional
 * emitter can have overwritten the client with `true` in between, and the
 * suppressed push is then the only thing that would have corrected it — leaving
 * exactly the stale-true false promise this feature exists to remove. A
 * deduplicated variant was written and deleted for that reason; the saving it
 * bought was one WS message and one log line, never the git work, which happens
 * before any comparison could.
 *
 * Transient + emit-only (recomputed on every activation), so a bare `emitMessage`
 * is the right transport — nothing to persist. Never throws:
 * {@link computeResetEligibility} is fail-safe, and the emit is a broadcast.
 *
 * Returns the whole {@link ResetEligibility} record rather than the bare
 * boolean: no caller ever read the boolean, and the merge-detection path
 * ({@link announceResetStateOnMerge}) needs the blocker this already computed —
 * recomputing it there would run the gate's git work twice and let the emitted
 * signal and the notice disagree about which clause refused.
 */
export async function emitResetEligible(
  deps: ResetEligibleSignalDeps,
  args: {
    sessionId: string;
    sessionDir: string;
    origin: ResetEligibleOrigin;
    emit: (msg: WsServerMessage) => void;
  },
): Promise<ResetEligibility> {
  const { sessionId, sessionDir, origin, emit } = args;
  const result = await computeResetEligibility(deps, sessionId, sessionDir);
  const { eligible, merged, blocker, error } = result;
  if (merged) {
    const why = error
      ? `: computation failed (${error}) — failing closed`
      : blocker ? `: ${blocker.clause} — ${blocker.detail}` : "";
    console.log(`[pre-turn-reset] reset_eligible=${eligible} for ${sessionId} (${origin})${why}`);
  }
  emit({ type: "reset_eligible", sessionId, eligible });
  return result;
}

/** The runner surface {@link announceResetStateOnMerge} touches, when one is live. */
export type MergeNoticeRunner = Parameters<typeof emitNoticeInTurn>[0];

/**
 * docs/266 — what a session is told when its pull request merges: the transient
 * `reset_eligible` signal, and — when the safety gate REFUSES — a persisted
 * transcript notice saying so, at the moment it happens.
 *
 * The whole point is the second half. docs/218's merge-detection hook
 * (`onMergeDetectedCb`) recomputed eligibility, wrote one server console line,
 * and emitted the transient signal that shows or hides the composer's "start
 * from the latest base" control. When the gate refused, the control simply did
 * not appear — and a hidden control is indistinguishable from one that was never
 * there. planning#297's notice exists, but it is built on the PRE-TURN path
 * ({@link autoResetMergedBranchOnContinue}), so it does not reach the user until
 * their next message.
 *
 * In the incident this fixes (session 5203c910, PR #2327), the agent was mid-turn
 * applying reviewer feedback when the PR merged; its edits were uncommitted,
 * which is exactly why the reset was refused. The first readable thing arrived
 * 4m45s later as the merged-push guard, by which point the commit was already
 * stranded on a branch with no open pull request. Those 4m45s were the window in
 * which it was still cheap to fix — commit, then `gh pr create`.
 *
 * ## Which refusals are said here
 *
 * Every clause {@link computeResetBlocker} can return on a merged session, which
 * is its whole union minus `not-merged` (that one is gated out below — it is the
 * ordinary state of nearly every session, not a failure). No sub-selection,
 * deliberately: each remaining clause means "your branch was left on
 * already-merged commits and ShipIt will not move it", which is the actionable
 * fact regardless of which one it was, and a hand-picked subset would be a second
 * list to drift from the gate. The two `info`-level clauses — the global setting
 * being off and the per-send untick — cannot occur here at all: this is the
 * safety-only gate, and both of those are consent, evaluated on the pre-turn path
 * only.
 *
 * ## Where it is written
 *
 * The transcript, because that is the durable surface and the `reset_eligible`
 * signal is not. So the notice is persisted even when NO runner is live (the user
 * closed the session, or the container was reclaimed) — the merge happened
 * whether or not anyone was watching, and this is what they find when they come
 * back. With a live runner it also renders live, and `emitNoticeInTurn` picks the
 * right persistence route for a turn that is running (the incident's own case).
 *
 * Fail-safe end to end: the eligibility computation swallows its own git errors,
 * and a throw in the transcript work is logged rather than propagated — a missing
 * notice is a regression, a notice that breaks post-merge bookkeeping is worse.
 */
export async function announceResetStateOnMerge(
  deps: ResetEligibleSignalDeps & {
    /**
     * Durable chat history. A REQUIRED key with a possibly-undefined value: the
     * poller's wiring makes it optional, and an optional dep is exactly how a
     * transcript notice ships emit-only — so the caller has to pass it, and a
     * missing one is reported loudly below rather than silently dropping the
     * notice.
     */
    chatHistory: InProgressPersister | undefined;
  },
  args: {
    sessionId: string;
    sessionDir: string;
    /** The session's live runner, when it has one. Null ⇒ persist only. */
    runner?: MergeNoticeRunner | null;
  },
): Promise<void> {
  const { sessionId, sessionDir, runner } = args;
  // One try around EVERYTHING, because the caller is `onMergeDetectedCb` and the
  // work that follows this call in it (the docs/145 bare-cache refresh) is not
  // this feature's to lose. Two things in here can throw at the caller and only
  // one of them is obvious: `emitMessage` is an EventEmitter broadcast, so a
  // single broken viewer listener rejects the eligibility signal — the surface
  // that existed before this change too, now contained.
  try {
    const { merged, blocker } = await emitResetEligible(deps, {
      sessionId,
      sessionDir,
      origin: "merge-detected",
      emit: (msg) => runner?.emitMessage(msg),
    });

    // Eligible (or nothing to reset): no refusal to report, and any episode the
    // session was carrying is over.
    if (!merged || !blocker || blocker.clause === "not-merged") {
      clearResetSkipEpisode(sessionId);
      return;
    }

    if (!deps.chatHistory) {
      // Never silent, and never claimed: the whole defect being fixed is a
      // refusal the user could not read, so a wiring gap that reproduces it has
      // to be visible AND must leave the pre-turn notice free to fire.
      console.error(
        `[pre-turn-reset] merge-detected notice for ${sessionId} was DROPPED — no chat history `
          + "manager is wired, so the refusal reaches no durable surface until the next turn.",
      );
      return;
    }

    const session = deps.getSession(sessionId);
    if (!claimSkipNotice(sessionId, blocker.clause, session)) return;

    const prStatus = deps.getPrStatus(sessionId);
    const prNumber = prStatus?.prNumber ?? session?.previousMergedPr?.number;
    const base = prStatus?.baseBranch ?? session?.previousMergedPr?.baseBranch;
    const notice = buildMergeTimeSkipNotice(blocker, prNumber, base);

    console.warn(
      `[pre-turn-reset] merge-detected skip for ${sessionId} (${blocker.clause}): ${blocker.detail}. `
        + `Branch stays on the merged tip${prNumber ? ` (PR #${prNumber})` : ""}.`,
    );

    try {
      if (runner) {
        emitNoticeInTurn(runner, sessionId, notice, deps.chatHistory, "warn");
      } else {
        persistNoticeUnattached(deps.chatHistory, sessionId, notice, "warn");
      }
    } catch (err) {
      // Give the claim back: the durable write may not have happened, so the
      // pre-turn notice is the only surface left and must not be suppressed by a
      // delivery that failed. This can duplicate the notice in one narrow case —
      // `emitChatCard` emits before it persists, so a throw from the persist can
      // still leave a recorded card that the turn flushes later — and a visible
      // duplicate is the right side of that trade: the failure this feature
      // exists to end is silence.
      clearResetSkipEpisode(sessionId);
      console.error(`[pre-turn-reset] merge-detected notice failed for ${sessionId}:`, err);
    }
  } catch (err) {
    console.error(`[pre-turn-reset] merge-detected announce failed for ${sessionId}:`, err);
  }
}

/**
 * docs/266 — the merge-time counterpart of {@link buildSkipNotice}.
 *
 * Same three facts, in an order that works where there is NO turn: the pull
 * request merged just now, the branch was left where it is and why, and what
 * that costs. The pre-turn wording ("this branch was not reset for this turn",
 * "send another message") reads as nonsense at a moment the user did not
 * initiate and may not be present for, which is why this is a second string
 * rather than a shared one.
 *
 * The remedy names committing the work first, because `dirty-tree` is the clause
 * this fires for in practice and discarding is not what the user wants there.
 *
 * Plain prose, no markdown emphasis — `MessageList` renders a `notice` message as
 * pre-wrapped text, so `**bold**` would show up literally.
 */
function buildMergeTimeSkipNotice(skip: ResetSkip, prNumber?: number, base?: string): string {
  const pr = prNumber ? `#${prNumber}` : "for this session";
  const into = base ? ` into ${base}` : "";
  const target = base ? `origin/${base}` : "the latest base";
  return (
    `Pull request ${pr} just merged${into}, and this branch was left where it is: it was not `
    + `reset to ${target} because ${skip.detail}.\n\n`
    + `Nothing was discarded. But the branch now sits on commits that are already merged and it `
    + `has no open pull request, so anything committed here from now on will not be auto-pushed `
    + `and belongs to no pull request.\n\n`
    + `The reset is re-evaluated at the start of every turn: clear the reason above and send a `
    + `message, and the branch moves to ${target} then. If there is work in the tree worth `
    + `keeping, ask the agent to commit it and open a new pull request first.`
  );
}

export async function autoResetMergedBranchOnContinue(
  deps: PreTurnResetDeps,
  sessionId: string,
  sessionDir: string,
  /**
   * The per-send intent from the composer control (Phase 3). `false` = the user
   * unticked "start from latest base" for this message → skip. `true`/`undefined`
   * = follow the global setting (the control was checked, or this send path has
   * no control, e.g. a programmatic follow-up).
   */
  intent?: boolean,
): Promise<ResetOutcome> {
  // Set the instant before the first git call that WRITES, so the `finally`
  // handback below can tell "we may have re-rooted this workspace" from "we
  // bailed without touching it". See the `finally` for why that distinction has
  // to be made here rather than by handing back unconditionally.
  let mutatedWorkspace = false;
  try {
    const session = deps.getSession(sessionId);
    const prStatus = deps.getPrStatus(sessionId);

    // planning#297 — the merged check moves AHEAD of the setting / opt-out gates.
    // Both lookups are in-memory, and every path below this point needs to know
    // whether this is a merged session: a skip on a merged session is a reportable
    // event (the branch stays on dead, already-shipped commits), while a skip on
    // an ordinary session is just "nothing to do" and must stay silent.
    // docs/266 — a session that is not (or no longer) merged has no standing
    // refusal, so any episode it carried is over: a docs/202 re-arm reaching
    // here means the branch moved on, and the next refusal is a new fact.
    if (!session?.mergedAt) {
      clearResetSkipEpisode(sessionId);
      return NOT_MOVED;
    }

    // Gate on the global setting AND an explicit per-send opt-out. Both are
    // deliberate user choices rather than safety refusals, so they are reported
    // at `info` — but they ARE reported: a merged session whose branch silently
    // stays behind is the failure mode this whole notice exists for.
    if (!deps.getAutoResetMergedBranch()) {
      return skipped(sessionId, session, prStatus, {
        clause: "setting-off",
        detail: "the “start from the latest base” setting is turned off",
      });
    }
    if (intent === false) {
      return skipped(sessionId, session, prStatus, {
        clause: "opted-out",
        detail: "“start from the latest base” was unticked for this message",
      });
    }

    const git = deps.createGitManager(sessionDir);

    const blocker = await computeResetBlocker(session, prStatus, git);
    if (blocker) return skipped(sessionId, session, prStatus, blocker);
    // Read the base from the SAME durable source the gate cleared it against
    // (`no-base-branch` is one of its clauses), not from the live snapshot alone:
    // now that the gate can pass on the `previousMergedPr` breadcrumb, a
    // `prStatus!` here would be a null dereference on exactly that path.
    const base = resolveResetBase(session, prStatus)!;

    // Fetch the latest base, then RE-validate the full gate (TOCTOU window).
    mutatedWorkspace = true;
    await git.fetch("origin");
    const blockerAfterFetch = await computeResetBlocker(session, prStatus, git);
    if (blockerAfterFetch) return skipped(sessionId, session, prStatus, blockerAfterFetch);

    // Nothing to move: the branch already sits exactly where the reset would put
    // it. The containment clause admits this state (it is its degenerate case),
    // and without this the turn would run a no-op `reset --hard` and then emit a
    // "Branch updated to latest <base>" card whose from === to. Silent, not a
    // skip notice: a branch that is already current is not a failure to report.
    // The explicit mode has the same short-circuit, one line further out.
    //
    // Like that one, this skips the remote heal too. A remote branch left
    // diverged by an earlier failed heal therefore stays diverged here — but the
    // alternative is a force-push on every turn of a session that needs nothing,
    // and the state this replaces (a `head-moved` skip) healed nothing either.
    const headNow = await git.getHeadHash();
    const baseTipNow = await git.getRefHash(`origin/${base}`);
    if (headNow && baseTipNow && headNow === baseTipNow) {
      clearResetSkipEpisode(sessionId);
      return NOT_MOVED;
    }

    const { from, to } = await git.resetHardToRemoteBase(base);

    // Heal the remote branch so later plain auto-pushes fast-forward. The reset
    // moved only the LOCAL branch to origin/<base>; the session's own remote
    // branch (origin/<session-branch>) still points at the old merged commits —
    // it survives the merge whenever the repo has auto-delete off, or ShipIt's
    // best-effort delete (which runs in the bare cache, not this clone) failed —
    // so local and remote have now diverged. The ordinary debounced auto-push
    // (`scheduleAutoPush` → plain `git push`) is non-force, so that divergence
    // turns every subsequent commit's push into a silently-dropped
    // non-fast-forward until something force-pushes (only the PR-create path
    // does today). Force the remote to match the reset branch NOW, leasing
    // against its LIVE tip: `forcePush` reads the remote's current sha via
    // `ls-remote` (not the stale local tracking ref) and create-or-leases — both
    // "deleted at merge" (expected=null → plain create) and "surviving +
    // diverged" (lease against the old tip) resolve. This deliberately gives up
    // the surviving-remote-branch safety net that docs/218 kept for false-merge
    // recovery (the reflog `HEAD@{1}` remains, and the lease refuses to clobber a
    // remote that moved unexpectedly). Best-effort: a failure just leaves the
    // pre-fix divergence for this session — no worse than before the heal.
    try {
      await git.forcePush("origin");
    } catch (err) {
      console.warn(
        `[pre-turn-reset] remote heal force-push failed for ${sessionId} ` +
          `(subsequent auto-push may be rejected as non-fast-forward):`,
        err,
      );
    }

    // Same durable fallback as the base above, and the same one {@link skipped}
    // uses for its card: the live snapshot is the better source when present.
    const prNumber = prStatus?.prNumber ?? session.previousMergedPr?.number;
    const prUrl = prStatus?.prUrl ?? session.previousMergedPr?.url;

    // docs/266 — the refusal the user was told about is resolved: the branch
    // moved. A later one starts a fresh episode and is said again.
    clearResetSkipEpisode(sessionId);

    return {
      moved: true,
      base,
      ...(prNumber !== undefined ? { prNumber } : {}),
      ...(prUrl !== undefined ? { prUrl } : {}),
      fromSha: from,
      toSha: to,
      agentPrefix: buildAgentPrefix(prNumber, base),
    };
  } catch (err) {
    console.error(`[pre-turn-reset] auto-reset failed for ${sessionId} (running turn on the un-moved branch):`, err);
    return NOT_MOVED;
  } finally {
    // The orchestrator ran that git work as ROOT, so every file the reset
    // re-materialized landed `root:root` — in a worktree the non-root worker
    // (uid 1000) owns. Without this handback the agent EACCESes on its first
    // edit of the very turn the reset exists to enable, and nothing repairs it:
    // the entrypoint's boot chown is sentinel-skipped on warm reuse,
    // `selfHealWorkspaceOwnership` runs only on container (re)create, and the
    // post-turn handback is `.git`-only — so git keeps working while the
    // worktree stays unwritable, which is what made this silent for six weeks.
    // (docs/218 shipped without it; docs/239's `resetBranchToBaseExplicit`
    // added it to its own path only.)
    //
    // In a `finally`, not after the success return, because the `catch` above is
    // fail-safe: a reset that succeeds and THEN throws in the heal has already
    // re-rooted the tree, and returning NOT_MOVED would run the turn on a
    // workspace the agent cannot write to — the worst version of this bug.
    //
    // Scoped to `mutatedWorkspace` rather than unconditional because this helper
    // runs on EVERY interactive turn (`ws-handlers/agent-execution.ts`), and the
    // handback is a full worktree walk; charging every turn of every session for
    // it to cover paths that only ever *read* git is not worth it. The flag is
    // set before `fetch`, not before the reset, so the fetch's own root-owned
    // `.git` writes (FETCH_HEAD, remote refs, new objects) are covered too — a
    // post-fetch TOCTOU bail still hands back.
    if (mutatedWorkspace) handWorkspaceBackToWorker(sessionDir);
  }
}

/**
 * planning#297 — build the outcome for a MERGED session whose reset was skipped, and
 * log the skip.
 *
 * Why this exists: every gate failure used to return a bare {@link NOT_MOVED}
 * and only *errors* were logged, so a skip left no trace anywhere — no card, no
 * prompt prefix, no log line. The production incident that produced this fix was
 * diagnosed by comparing two sessions and proving a NEGATIVE (session A shows
 * `[git] Reset --hard`, session B shows nothing at all), which is not a thing an
 * investigation should have to do. The user's read was blunter: "it silently
 * didn't sync and it was not clear to me that this was a failure mode."
 *
 * Three surfaces, deliberately: the `console.warn` (so the next ops
 * investigation greps one line instead of inferring absence), the persisted
 * notice (so the user sees it in the transcript on reload, not just live), and
 * the agent prefix (so the agent knows its branch is stale AND merged before it
 * authors a commit for a dead pull request — which is exactly what happened).
 *
 * The PR pointers come from the live snapshot when present and fall back to the
 * durable `previousMergedPr` breadcrumb, for the same reason
 * {@link resolveResetBase} does: `PrStatusPoller.reArm` nulls the live snapshot
 * on the ordinary keep-working-after-a-merge path.
 */
function skipped(
  sessionId: string,
  session: SessionInfo,
  prStatus: PrStatusSummary | null,
  skip: ResetSkip,
): ResetOutcome {
  const prNumber = prStatus?.prNumber ?? session.previousMergedPr?.number;
  const base = prStatus?.baseBranch ?? session.previousMergedPr?.baseBranch;
  // The two opt-outs are the user's own choice, not a refusal they need to act
  // on — record them without an alarm.
  const level = skip.clause === "setting-off" || skip.clause === "opted-out" ? "info" : "warn";
  console.warn(
    `[pre-turn-reset] skipped for ${sessionId} (${skip.clause}): ${skip.detail}. `
      + `Branch stays on the merged tip${prNumber ? ` (PR #${prNumber})` : ""}.`,
  );
  // docs/266 — the notice, and ONLY the notice, is dropped when the user has
  // already read this exact clause in this episode (merge detection wrote it, or
  // an earlier turn did). The log line above and the agent prefix below are not
  // user-facing paragraphs and always fire: the agent is a fresh reader on every
  // turn, and the ops line is what an investigation greps.
  //
  // The two `info` clauses are exempt, and do not touch the episode at all. They
  // are not a standing condition being re-reported — they are a fact about THIS
  // message ("you unticked it for this send"), so every send earns its own
  // record. Claiming for them would also overwrite a standing safety episode and
  // let the real refusal be said twice.
  const notice = level === "info" || claimSkipNotice(sessionId, skip.clause, session)
    ? { notice: buildSkipNotice(skip, prNumber, base) }
    : {};
  return {
    moved: false,
    skip: { ...skip, level, ...notice },
    agentPrefix: buildSkipAgentPrefix(skip, prNumber, base),
  };
}

/**
 * The persisted user-facing notice. Says three things, in the order a user needs
 * them: that the branch was NOT updated, which clause refused, and what the
 * consequence is (commits made now sit on already-merged history and will not be
 * auto-pushed — the planning#297 defect-1 gate). The recovery line is deliberately
 * generic rather than per-clause: the reset is re-evaluated on every turn, so
 * "clear the reason and send again" is the honest instruction for all of them.
 *
 * Plain prose, no markdown emphasis — `MessageList` renders a `notice` message as
 * pre-wrapped text, so `**bold**` would show up literally.
 */
function buildSkipNotice(skip: ResetSkip, prNumber?: number, base?: string): string {
  const pr = prNumber ? `#${prNumber}` : "for this session";
  const into = base ? ` into ${base}` : "";
  const target = base ? `origin/${base}` : "the latest base";
  return (
    `Branch not updated to the latest base. Pull request ${pr} merged${into}, but this branch `
    + `was not reset to ${target} because ${skip.detail}.\n\n`
    + `It still sits on the already-merged commits, so anything committed here belongs to no `
    + `open pull request — and ShipIt will not auto-push it.\n\n`
    + `Clear the reason above and send another message (the reset is re-evaluated every turn), `
    + `or ask the agent to run \`shipit branch reset-to-base\`.`
  );
}

/**
 * The agent-facing counterpart, prepended to this turn's prompt only. Without it
 * the agent has no idea its branch is both stale and merged — in the incident it
 * went on to author, commit and push a change for a pull request that had merged
 * two minutes earlier, and the user had to work that out themselves.
 *
 * It ends by pointing at the brokered reset rather than leaving the agent to
 * improvise, for the {@link RESET_REFUSAL_GUIDANCE} reason: an agent that reads
 * "your branch is stale" and has a shell is two words away from
 * `git reset --hard`, which over the dirty tree that most often causes this skip
 * is precisely the unrecoverable loss the gate refused to risk.
 */
function buildSkipAgentPrefix(skip: ResetSkip, prNumber?: number, base?: string): string {
  const pr = prNumber ? ` (#${prNumber})` : "";
  const into = base ? ` into ${base}` : "";
  const target = base ? `origin/${base}` : "the latest base";
  return (
    `[System] This session's pull request${pr} was already merged${into}, and the branch was `
    + `NOT reset to ${target}: ${skip.detail}. The branch still contains the merged commits, `
    + `is behind the base, and has no open pull request — anything you commit here will not be `
    + `auto-pushed and belongs to no pull request. Tell the user this before doing work that `
    + `assumes a fresh base. Do not run a manual \`git reset --hard\` or \`git push --force\`; `
    + `if the user wants the branch moved, use \`shipit branch reset-to-base\`.`
  );
}

/**
 * The agent-facing context prefix. The last sentence is load-bearing: it stops
 * the agent from recreating already-shipped work on the fresh base.
 */
function buildAgentPrefix(prNumber: number | undefined, base: string): string {
  return (
    `[System] Your previous pull request${prNumber ? ` (#${prNumber})` : ""} was merged into ${base}. ` +
    `This branch has been automatically reset to the latest origin/${base} — it no ` +
    `longer contains the merged commits and starts from current code. Build the ` +
    `requested work on top of this fresh base; do not re-apply or recreate anything ` +
    `from the merged PR. ` +
    // docs/250 (requirement 6) — the second of the two moments the agent
    // reconsiders the session title. This one is load-bearing: a session
    // starting a SECOND round of work is precisely when a title describing the
    // first round has gone stale, and the sidebar is the only place the user
    // sees which session is which.
    `This session is now starting new work, so its title probably describes only ` +
    `the merged PR — check it and run \`shipit session rename --title "..."\` if it ` +
    `no longer fits (a title the user set by hand wins, and the command will say so).`
  );
}

/**
 * docs/221 — the agent-facing notice for a reset the USER triggered from the
 * "Sync with `<base>`" menu on a merged session, rather than one the agent ran
 * itself via `shipit branch reset-to-base`.
 *
 * Both go through the same route, so the difference is only who asked. When the
 * agent asked, it read the outcome in its own tool result and needs nothing more;
 * when the user asked, the branch was rewritten under a conversation that has no
 * idea it happened. Unlike {@link buildAgentPrefix} this is not delivered inside
 * the turn that caused it — it is parked on the session and drained by the next
 * one — so it says "while you were idle" rather than "your PR was merged".
 */
export function buildManualResetAgentNotice(opts: {
  base: string;
  fromSha?: string;
  toSha?: string;
  prNumber?: number;
}): string {
  const shas = opts.fromSha && opts.toSha
    ? ` (was ${opts.fromSha.slice(0, 7)} → now ${opts.toSha.slice(0, 7)})`
    : "";
  const pr = opts.prNumber ? ` (#${opts.prNumber})` : "";
  return (
    `[System] While you were idle, the user reset this branch to the latest `
    + `origin/${opts.base}${shas} from the ShipIt UI. It no longer contains the commits `
    + `from the merged pull request${pr} and starts from current code. Your working tree `
    + `was rewritten from outside the session: files you read earlier in this conversation `
    + `may have changed, so re-read before editing, and do not re-apply or recreate `
    + `anything from the merged PR.`
  );
}

// ---------------------------------------------------------------------------
// docs/239 — the explicit `shipit branch reset-to-base` mode
// ---------------------------------------------------------------------------

/** What an explicit reset did. `refused` and `errored` are one outcome for the
 * agent — it behaves identically for both — so they are not split. */
export interface ExplicitResetOutcome {
  outcome: "reset" | "already-at-base" | "refused";
  /** Why a refusal happened, or a one-line description of what moved. */
  reason?: string;
  base?: string;
  fromSha?: string;
  toSha?: string;
  /** planning#279 — this reset ran under `--force`, bypassing the SHA clause. */
  forced?: boolean;
  /** planning#279 — the operator-supplied justification for a forced reset. */
  forceReason?: string;
}

/**
 * planning#279 — the structural preconditions an explicit reset requires REGARDLESS
 * of `--force`. Two kinds, and neither is about trust:
 *
 *   - **The clean-tree check is the one unrecoverable case.** A committed but
 *     unshipped commit is discarded by a reset yet stays in the reflog; an
 *     uncommitted edit has no reflog entry and is simply gone. Forcing over a
 *     dirty tree is the single thing no amount of operator intent can undo, and
 *     it is exactly what the first refusal in the production incident caught.
 *   - **The coherence checks** (on the session branch, not detached, no
 *     rebase/merge/cherry-pick in progress) answer "is this operation even
 *     well-defined here", not "do we trust the caller". A reset on a detached
 *     HEAD doesn't move the session branch at all, and one over a half-finished
 *     sequencer clobbers its recovery state.
 *
 * Returns the refusing clause, or null when the branch is in a resettable state.
 * Called BEFORE the fetch and, on the force path, again after it — `git fetch`
 * yields to the event loop, so a terminal edit can dirty the tree in between
 * (the non-force path gets the same re-check via {@link computeResetBlocker},
 * which calls this same function — one implementation, so the two paths cannot
 * disagree about what "resettable state" means, and the explicit refusal
 * inherits planning#341's uncommitted-path list for free).
 */
async function checkResetPreconditions(
  session: SessionInfo,
  git: GitManager,
): Promise<(ResetSkip & { clause: ResetPreconditionClause }) | null> {
  if (!(await git.isClean())) {
    const why =
      "the working tree has uncommitted changes, and a hard reset would discard them "
      + "permanently (uncommitted edits have no reflog entry)";
    return { clause: "dirty-tree", detail: `${why}${await formatDirtyPaths(git)}` };
  }
  const branch = await git.currentBranchOrNull();
  if (!branch) {
    return { clause: "detached-head", detail: "HEAD is detached, so a reset would not move the session branch" };
  }
  if (session.branch && branch !== session.branch) {
    return {
      clause: "wrong-branch",
      detail: `HEAD is on '${branch}', not the session branch '${session.branch}'`,
    };
  }
  if (await git.isRebaseInProgress()) {
    return {
      clause: "rebase-in-progress",
      detail: "a rebase is in progress and a reset would clobber its recovery state",
    };
  }
  if (await git.isMergeOrSequencerInProgress()) {
    return {
      clause: "sequencer-in-progress",
      detail: "a merge / cherry-pick / revert is in progress and a reset would clobber its recovery state",
    };
  }
  return null;
}

/**
 * The refusal copy is LOAD-BEARING, not decoration.
 *
 * This gate is prompt-mediated: a refused agent still has a shell, and
 * `git reset --hard` is two words away. The one thing standing between a refusal
 * and the data loss the gate exists to prevent is the agent understanding *why*
 * it was refused and being told, explicitly, not to route around it. Deleting or
 * softening this sentence re-opens the hole the gate closes.
 *
 * planning#279 — it also has to name the way FORWARD, because a refusal that reads as
 * a dead end is exactly what makes an agent reach for the reset anyway. Once a
 * branch's work has shipped under a DIFFERENT commit — a cherry-pick recovery, or
 * the ordinary squash merge — the `HEAD === mergedHeadSha` clause can never hold
 * again, and without a bypass the session can never open another pull request.
 *
 * `git rebase` is NOT that way forward, and the refusal must not suggest it. An
 * earlier revision of this comment claimed it was; it is wrong. Under a squash
 * merge the base gains the whole branch as ONE commit holding its FINAL state,
 * while the branch's first commit adds the same paths in their INITIAL state — so
 * the replay is an add/add conflict, not an already-applied patch that drops.
 * Reproduced on the stranded branch this bug produced (`shipit/shi-267-…`, HEAD
 * `f8e889b7`, content fully contained in `main` via cherry-pick `b7222c34`):
 * `git rebase origin/main` conflicts across 8 files, twice out of two attempts.
 * Patch-dropping only works when the base's history literally contains the
 * branch's commits — a merge-commit strategy, or a single-commit branch — which
 * is precisely what ShipIt's squash flow does not produce.
 *
 * The way forward is {@link resetBranchToBaseExplicit}'s `force` mode: a
 * brokered, audited break-glass that bypasses the SHA clause and nothing else.
 * It is the only sanctioned bypass, deliberately — a hand-rolled
 * `git reset --hard` does the same damage with no clean-tree check, no recorded
 * reason and no transcript card.
 */
export const RESET_REFUSAL_GUIDANCE =
  "Do NOT work around this — do not run `git reset --hard`, `git checkout -f`, "
  + "`git push --force`, or any other manual reset. The check refused because a reset "
  + "here would destroy work that is not recoverable (uncommitted edits have no reflog "
  + "entry, and unmerged commits would be discarded). Report what this said and let the "
  + "user decide. If the user tells you to proceed anyway, use the brokered override — "
  + "`shipit branch reset-to-base --force --reason \"<why>\"` — never a manual reset: it "
  + "still refuses over an unclean tree, and it records the reason in the transcript.";

/**
 * Refuse an explicit reset — and say so in the orchestrator log.
 *
 * The log line is not decoration. Until it existed only a *forced* reset wrote
 * anything, so a refusal left no server-side trace at all: the ops investigation
 * that produced this fix could recover the refusing clause only because the
 * agent went on to force the reset, and the FORCED line happened to print the
 * state that explained it. A refusal is the more interesting event of the two —
 * it is the one where a session gets stuck.
 *
 * `clause` is the stable id (a {@link ResetSkipClause} where the refusal came
 * from the gate, plus this path's own structural ones), so an investigation
 * greps for the clause rather than for prose that changes.
 */
function refuse(sessionId: string, clause: string, reason: string): ExplicitResetOutcome {
  console.warn(`[branch-reset] refused for ${sessionId} (${clause}): ${reason}`);
  return { outcome: "refused", reason };
}

/** The clauses `--force` does NOT bypass — see {@link checkResetPreconditions}. */
const PRECONDITION_CLAUSES: ReadonlySet<ResetSkipClause> = new Set<ResetSkipClause>([
  "dirty-tree",
  "detached-head",
  "wrong-branch",
  "rebase-in-progress",
  "sequencer-in-progress",
]);

/**
 * The refusal an ineligible non-forced reset returns: the gate's own
 * clause-specific diagnosis, then the way forward for that KIND of clause.
 *
 * The diagnosis used to be a single hard-coded sentence — "this branch carries
 * work that is not on the merged pull request" — which is true of exactly ONE
 * clause (`head-moved`) and was printed for all of them. In the incident this
 * fix comes from, the branch was provably safe to reset and the real clause was
 * `not-merged`; the agent read the sentence, constructed a root cause that was
 * wrong in every particular, and pushed a lossless operation through the
 * trust-based `--force` break-glass, which exists for cases that CANNOT be
 * proven safe.
 *
 * Both way-forward halves are verbatim per kind, for the
 * {@link RESET_REFUSAL_GUIDANCE} reason: a refusal that reads as a dead end is
 * what makes a refused agent — which still has a shell — reach for a manual
 * `git reset --hard` instead. They differ because the ways forward genuinely
 * differ: `--force` bypasses the gate clauses and nothing else, so offering it
 * for a dirty tree or a half-finished rebase would send the agent at a bypass
 * that (correctly) refuses again.
 */
function buildExplicitRefusal(skip: ResetSkip): string {
  if (PRECONDITION_CLAUSES.has(skip.clause)) {
    return (
      `This branch was not reset because ${skip.detail}. `
      + "`--force` does not bypass this check — it is not a question of trust, the operation is "
      + "unsafe or undefined in this state. Resolve the condition (commit or discard the "
      + "changes, finish or abort the in-progress operation, check the session branch back "
      + "out) and run the command again."
    );
  }
  return (
    `This branch was not reset because ${skip.detail}. `
    + "If its work has already shipped some other way (a cherry-pick, or a squash merge you "
    + "then built on), this check can never pass on its own — re-run with "
    + "`--force --reason \"<why>\"` to override it. Do not rebase onto the base to work around "
    + "this: after a squash merge the replay conflicts rather than dropping the already-shipped "
    + "commits."
  );
}

/**
 * Find the base branch an explicit reset should target — DURABLY, because the
 * live PR snapshot is not.
 *
 * `getPrStatus` is the obvious source and the right first choice, but it is
 * transient by design: `PrStatusPoller.reArm` nulls it
 * (`sessionManager.setPrStatus(id, null)`) every time a merged session gains new
 * work, which is the ordinary "keep working after a merge" path — both
 * `detectAndReArmMergedSession` (rebased + progressed) and
 * `detectAndReArmResetSession` (branch back at base) run it from the post-turn
 * flow. Deriving the base from that snapshot alone therefore made a routine
 * merge → commit → re-arm sequence refuse with "no merged pull request
 * recorded", which was both wrong (the base never changed) and misleading (a PR
 * very much merged; the record was cleared for an unrelated reason).
 *
 * `session.previousMergedPr.baseBranch` is the durable answer in exactly that
 * case: both re-arm paths call `sessionManager.clearMerged(id, { …, baseBranch })`
 * **immediately before** `poller.reArm`, so the breadcrumb is written in the same
 * beat the snapshot is cleared, and it is DB-backed (`previous_merged_pr`), so it
 * survives a restart too.
 *
 * There is deliberately no third fallback to the repo's **default** branch, even
 * though one is knowable (session branches are cut from `origin/<defaultBranch>`
 * — `services/session.ts`, `services/repo-default-branch.ts`). It would not let a
 * never-PR'd session reset: {@link computeResetEligible} independently requires
 * `mergedAt` + `mergedHeadSha` + a live `prStatus`, so such a session refuses at
 * the gate regardless of what base is found. All the fallback would add is a
 * truthful-but-useless `already-at-base` for a branch sitting exactly on the
 * default tip, in exchange for making the reset target guessable in a command
 * whose entire safety story is "reset only onto the base of a PR this branch
 * provably shipped". Widening *which* sessions may reset is a separate,
 * deliberate decision about the gate — not something to smuggle in via the base
 * lookup. The refusal below therefore names the gate as the reason, not the base.
 *
 * Note this only *finds* the base — the destructive move is still gated by the
 * unchanged {@link computeResetEligible}, which reads the live `prStatus` and
 * fails closed without it.
 */
function resolveResetBase(session: SessionInfo, prStatus: PrStatusSummary | null): string | undefined {
  if (prStatus?.baseBranch) return prStatus.baseBranch;
  // The breadcrumb answers only for the population it was written for: a session
  // the re-arm UN-merged. While a session IS merged the live snapshot is the
  // authoritative base, and a breadcrumb left by an EARLIER merge can name a
  // different one — resetting a second PR's branch onto the first PR's base
  // would discard commits that shipped, which is the loss the gate exists to
  // prevent. `mergedAt` is exactly the discriminator: `clearMerged` nulls it in
  // the same statement that writes the breadcrumb.
  return session.mergedAt ? undefined : session.previousMergedPr?.baseBranch;
}

/**
 * docs/239 — reset the session branch to its merged PR's base, on the agent's
 * explicit request (`shipit branch reset-to-base`), as the first step of a
 * self-merge wake turn.
 *
 * This is an explicit MODE over docs/218's reset core, not a second service: the
 * gate ({@link computeResetEligible}), the fetch, the re-gate and the live-tip
 * leased push are the same code and the same invariants. Six things differ, and
 * each is a correctness requirement rather than a preference:
 *
 *  - **`getAutoResetMergedBranch()` is not consulted.** A command the agent
 *    deliberately invoked must not silently no-op because an unrelated composer
 *    preference is off. The arming *is* the consent.
 *  - **Idempotent, and already-at-base is checked BEFORE the `mergedHeadSha`
 *    gate.** After any successful reset `HEAD ≠ mergedHeadSha`, and a docs/218
 *    reset clears the field outright — so with the checks in the other order a
 *    duplicate wake, a retry, or a second invocation would refuse and stop a
 *    chain whose branch state is already perfect.
 *  - **A failed force-push is a FAILURE.** docs/218's heal is best-effort and
 *    still returns success; in a chain that means every later push against the
 *    diverged remote is silently dropped as a non-fast-forward and the next PR
 *    never updates. Here it fails loudly instead.
 *  - **`handWorkspaceBackToWorker` runs in a `finally`.** The orchestrator does
 *    this git work as root; without the handback the agent hits `EACCES` on its
 *    first edit — inside the very turn the wake exists to enable.
 *  - **The base is derived durably** ({@link resolveResetBase}), not from the
 *    live PR snapshot alone. A docs/202 re-arm nulls that snapshot in the normal
 *    post-turn flow, which made an ordinary merge → commit → re-arm sequence
 *    refuse a reset the session was plainly entitled to.
 *  - **Simple CLI semantics.** Exit 0 for `reset` and `already-at-base`, nonzero
 *    with a reason otherwise.
 *
 * The safety gate itself is retained exactly. It is what makes a duplicate wake,
 * a late wake, or a wake landing behind uncommitted work refuse rather than
 * destroy. What a refusal is allowed to SAY about it is not the gate: it names
 * the clause that actually refused ({@link buildExplicitRefusal}) and writes a
 * log line, because a refusal used to leave no server-side trace at all.
 *
 * ## planning#279 — the `force` break-glass
 *
 * `opts.force` bypasses exactly ONE clause: `HEAD === mergedHeadSha`. Everything
 * in {@link checkResetPreconditions} still applies, and is re-checked after the
 * fetch.
 *
 * It exists because that clause is not merely strict, it is *terminal*. A branch
 * whose work shipped under a different commit — the ordinary squash merge, or a
 * cherry-pick recovery — can never satisfy it again, so without a bypass the
 * session is permanently unable to open another pull request. Rebasing back onto
 * the base is not an alternative: a squash gives the base one commit holding the
 * final state while the branch's first commit adds the same paths in their
 * initial state, so the replay conflicts rather than dropping (reproduced twice
 * on the branch this bug stranded).
 *
 * The bypass is TRUST-BASED by explicit product decision — the user chose "trust
 * the agent in the recovery process" over both a containment check (patch-id
 * equivalence is fail-open: a deliberately re-applied revert reads as "already
 * upstream") and a per-use confirmation card. What replaces the gate is
 * accountability, not permission: a required `reason`, a `console.warn`, and a
 * persisted transcript card marked as forced. Note the trade this accepts —
 * unshipped COMMITS can now be discarded by a caller who says so. They remain
 * reflog-recoverable inside the session clone; uncommitted edits would not be,
 * which is why the clean-tree check is not part of the bypass.
 */
export async function resetBranchToBaseExplicit(
  deps: ResetEligibleSignalDeps,
  sessionId: string,
  sessionDir: string,
  opts?: {
    /**
     * Bypass the `HEAD === mergedHeadSha` clause. `reason` is required by the
     * caller (route + shim validate it), recorded in the orchestrator log and
     * surfaced on the transcript card.
     */
    force?: { reason: string };
  },
): Promise<ExplicitResetOutcome> {
  const force = opts?.force;
  try {
    const session = deps.getSession(sessionId);
    if (!session) return refuse(sessionId, "no-session", "Session not found.");
    const prStatus = deps.getPrStatus(sessionId);
    const git = deps.createGitManager(sessionDir);

    // Structural safety first — these refuse both outcomes, so they precede the
    // already-at-base short-circuit, and `--force` does not skip them.
    const unsafe = await checkResetPreconditions(session, git);
    if (unsafe) return refuse(sessionId, unsafe.clause, buildExplicitRefusal(unsafe));

    const base = resolveResetBase(session, prStatus);
    if (!base) {
      // Two different states end here, and saying the wrong one is the bug this
      // whole change is about. A merged session with no live snapshot HAS a
      // breadcrumb — `resolveResetBase` declines to use it precisely because an
      // earlier merge's base may not be this merge's — so telling that caller
      // "no previously merged pull request is recorded" is false.
      const staleBreadcrumb = Boolean(session.mergedAt && session.previousMergedPr);
      return refuse(
        sessionId,
        "no-base-branch",
        staleBreadcrumb
          ? "The base branch of the pull request this session merged is not recorded, so there "
            + `is no reset target. An earlier merged pull request (#${session.previousMergedPr!.number}) `
            + `left a note of its base ('${session.previousMergedPr!.baseBranch}'), but a reset will `
            + "not use it: that was a different pull request, which may have merged into a different "
            + "branch, and resetting onto the wrong base would discard commits that shipped."
          : "No pull-request base is recorded for this session — neither a live pull request nor a "
            + "previously merged one. A reset needs one: without a merged pull request there is no "
            + "proof this branch's commits have already shipped, so resetting it onto the repo's "
            + "default branch would discard them.",
      );
    }

    await git.fetch("origin");

    // Idempotent: the branch is already exactly where a reset would put it, so
    // the caller can proceed. Checked BEFORE the `mergedHeadSha` gate — see the
    // docblock; this is what makes a duplicate wake harmless instead of
    // chain-ending.
    const head = await git.getHeadHash();
    const baseTip = await git.getRefHash(`origin/${base}`);
    if (head && baseTip && head === baseTip) {
      return { outcome: "already-at-base", base, ...(head ? { toSha: head } : {}) };
    }

    // The destructive move. Full docs/218 gate, evaluated AFTER the fetch (the
    // fetch yields to the event loop, so a terminal edit could have moved the
    // branch since the checks above).
    //
    // planning#279 — `--force` swaps the gate for the preconditions alone. The
    // re-check is not optional on this path either: the fetch yielded, so the
    // tree could have been dirtied since the first one, and the clean-tree
    // clause is the case `--force` explicitly does NOT cover.
    if (force) {
      const unsafeNow = await checkResetPreconditions(session, git);
      if (unsafeNow) return refuse(sessionId, unsafeNow.clause, buildExplicitRefusal(unsafeNow));
      console.warn(
        `[branch-reset] FORCED reset for ${sessionId} onto origin/${base} — `
        + `bypassing the merged-head check (HEAD=${(await git.getHeadHash()) ?? "?"}, `
        + `mergedHeadSha=${session.mergedHeadSha ?? session.previousMergedPr?.mergedHeadSha ?? "none"})`
        + `. Reason: ${force.reason}`,
      );
    } else {
      // The clause that refused, not a hard-coded guess at it — see
      // {@link buildExplicitRefusal}. `computeResetBlocker` is the same
      // evaluation `computeResetEligible` wraps, so the gate is unchanged; only
      // what the refusal is allowed to SAY about it is.
      const blocker = await computeResetBlocker(session, prStatus, git);
      if (blocker) return refuse(sessionId, blocker.clause, buildExplicitRefusal(blocker));
    }

    const { from, to } = await git.resetHardToRemoteBase(base);

    // Heal the remote so later plain auto-pushes fast-forward. STRICT, unlike
    // docs/218's best-effort heal: the reset moved only the local branch, so the
    // session's remote branch is now diverged, and every subsequent plain push is
    // a silently-dropped non-fast-forward. In a chain that means the next PR
    // never updates — a failure the agent must see, not a warning in a log.
    try {
      await git.forcePush("origin");
    } catch (err) {
      return refuse(
        sessionId,
        "remote-heal-failed",
        `The branch was reset locally to origin/${base}, but the remote branch could not be `
        + `updated to match (${err instanceof Error ? err.message : String(err)}). Later pushes `
        + "would be rejected as non-fast-forward, so stop here rather than continuing.",
      );
    }

    // docs/266 — same as the automatic path: the refusal the user was told about
    // is resolved, so the episode ends here too.
    clearResetSkipEpisode(sessionId);

    return {
      outcome: "reset",
      base,
      fromSha: from,
      toSha: to,
      ...(force ? { forced: true, forceReason: force.reason } : {}),
    };
  } catch (err) {
    return refuse(
      sessionId,
      "error",
      `The reset could not be completed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    // The orchestrator ran the git work as ROOT. Without handing ownership back,
    // the agent's very first edit in this turn fails with EACCES. In a `finally`
    // so a refusal or a throw can't skip it — a refused reset still leaves the
    // agent working in this workspace.
    handWorkspaceBackToWorker(sessionDir);
  }
}
