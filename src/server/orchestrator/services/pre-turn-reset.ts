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
 *
 * A hard reset is destructive, so it fires ONLY behind the full safety gate
 * ({@link computeResetEligible}). The branch has no new work (every commit is
 * already shipped via the merge), so a clean reset — not a rebase — is the
 * squash-safe move (nothing to replay). The caller prepends the returned
 * `agentPrefix` to the turn's prompt (so the agent starts fresh and doesn't
 * re-apply shipped work) and emits a persisted card from the returned move info.
 *
 * Everything here is fail-safe: any gate failure or git error returns
 * {@link NOT_MOVED} and the turn runs on the un-moved branch — the user falls
 * back to today's manual flow (still picked up by the docs/202 / docs/216 re-arm).
 */

import type { SessionInfo } from "../../shared/types.js";
import type { GitManager } from "../../shared/git.js";
import type { PrStatusSummary } from "../../shared/types/github-types.js";

export interface PreTurnResetDeps {
  getSession: (id: string) => SessionInfo | undefined;
  getPrStatus: (id: string) => PrStatusSummary | null;
  createGitManager: (dir: string) => GitManager;
  getAutoResetMergedBranch: () => boolean;
}

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
}

const NOT_MOVED: ResetOutcome = { moved: false };

/**
 * The SAFETY-ONLY eligibility gate — "this branch carries nothing that isn't
 * already merged AND the repo is in a plain, resettable state." Deliberately
 * EXCLUDES the global setting and the per-send intent (those gate whether the
 * user *wants* a reset; this gates whether one is *safe*). Surfaced to the client
 * as the transient `resetEligible` signal in Phase 3.
 *
 * All clauses must hold; any failure → not eligible → no reset:
 *   - session merged, with a recorded `mergedHeadSha` (the PR's head tip),
 *   - the merged PR's base branch is known (the reset target),
 *   - the working tree is clean (a hard reset over uncommitted edits is the one
 *     irreversible loss — committed work is reflog-recoverable, edits are not),
 *   - HEAD is on `session.branch`, not detached (a reset wouldn't move the branch),
 *   - no rebase/merge/cherry-pick/revert in progress (a reset clobbers recovery),
 *   - **`HEAD === mergedHeadSha`** — the load-bearing clause: it is the only
 *     reliable distinction between "untouched since merge" and "new un-rebased
 *     work" (deriving it from `advancedBeyondMergedBase`/`headIsAtBase` has a
 *     data-loss hole — see plan.md "Safety gate").
 */
export async function computeResetEligible(
  session: SessionInfo | undefined,
  prStatus: PrStatusSummary | null,
  git: GitManager,
): Promise<boolean> {
  if (!session?.mergedAt) return false;
  if (!session.mergedHeadSha) return false;
  if (!prStatus?.baseBranch) return false;

  if (!(await git.isClean())) return false;

  const branch = await git.currentBranchOrNull();
  if (!branch) return false; // detached HEAD
  if (session.branch && branch !== session.branch) return false;

  if (await git.isRebaseInProgress()) return false;
  if (await git.isMergeOrSequencerInProgress()) return false;

  const head = await git.getHeadHash();
  if (!head || head !== session.mergedHeadSha) return false;

  return true;
}

/**
 * Run the pre-turn auto-reset. Returns {@link NOT_MOVED} when the global setting
 * is off, the safety gate fails, or anything throws (fail-safe). On a real move,
 * returns the base + PR pointers + before/after SHAs + the agent prompt prefix.
 *
 * The gate is evaluated TWICE — once before the fetch and once after — because
 * `git fetch` yields to the event loop, during which a terminal edit or a queued
 * agent turn could move the branch out from under us (TOCTOU).
 */
export async function autoResetMergedBranchOnContinue(
  deps: PreTurnResetDeps,
  sessionId: string,
  sessionDir: string,
): Promise<ResetOutcome> {
  try {
    // Phase 3 will also honor a per-send opt-out here; Phase 2 gates on the
    // global setting alone (default OFF — the mechanism ships dark).
    if (!deps.getAutoResetMergedBranch()) return NOT_MOVED;

    const session = deps.getSession(sessionId);
    const prStatus = deps.getPrStatus(sessionId);
    const git = deps.createGitManager(sessionDir);

    if (!(await computeResetEligible(session, prStatus, git))) return NOT_MOVED;
    const base = prStatus!.baseBranch;

    // Fetch the latest base, then RE-validate the full gate (TOCTOU window).
    await git.fetch("origin");
    if (!(await computeResetEligible(session, prStatus, git))) return NOT_MOVED;

    const { from, to } = await git.resetHardToRemoteBase(base);
    const prNumber = prStatus!.prNumber;
    const prUrl = prStatus!.prUrl;

    return {
      moved: true,
      base,
      prNumber,
      prUrl,
      fromSha: from,
      toSha: to,
      agentPrefix: buildAgentPrefix(prNumber, base),
    };
  } catch (err) {
    console.error(`[pre-turn-reset] auto-reset failed for ${sessionId} (running turn on the un-moved branch):`, err);
    return NOT_MOVED;
  }
}

/**
 * The agent-facing context prefix. The last sentence is load-bearing: it stops
 * the agent from recreating already-shipped work on the fresh base.
 */
function buildAgentPrefix(prNumber: number, base: string): string {
  return (
    `[System] Your previous pull request (#${prNumber}) was merged into ${base}. ` +
    `This branch has been automatically reset to the latest origin/${base} — it no ` +
    `longer contains the merged commits and starts from current code. Build the ` +
    `requested work on top of this fresh base; do not re-apply or recreate anything ` +
    `from the merged PR.`
  );
}
