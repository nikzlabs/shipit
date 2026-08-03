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
 * Everything here is fail-safe: any gate failure or git error returns
 * {@link NOT_MOVED} and the turn runs on the un-moved branch — the user falls
 * back to today's manual flow (still picked up by the docs/202 / docs/216 re-arm).
 */

import type { SessionInfo } from "../../shared/types.js";
import type { GitManager } from "../../shared/git.js";
import type { PrStatusSummary } from "../../shared/types/github-types.js";
import type { WsServerMessage } from "../../shared/types/ws-server-messages.js";
import { handWorkspaceBackToWorker } from "../session-worker-uid.js";

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
  try {
    const session = deps.getSession(sessionId);
    if (!session?.mergedAt) return false; // cheap-exit before constructing git
    const prStatus = deps.getPrStatus(sessionId);
    const git = deps.createGitManager(sessionDir);
    return await computeResetEligible(session, prStatus, git);
  } catch {
    return false;
  }
}

/**
 * Recompute the safety-only eligibility signal and push it to a session's
 * attached viewers via the runner's broadcast transport. Used by the
 * merge-detection path (`onMergeDetectedCb`): a PR that merges while the user is
 * sitting ON the session — never re-activating it — makes the session newly
 * reset-eligible, but neither the activation nor the post-turn recompute fires,
 * so the "start from latest base" composer control would stay hidden until they
 * switched away and back. This is transient + emit-only (recomputed on every
 * activation), so a bare `emitMessage` is the right transport — nothing to
 * persist. Fail-safe: `isResetEligible` already swallows its own errors.
 */
export async function emitResetEligibleSignal(
  deps: ResetEligibleSignalDeps,
  runner: { sessionDir: string; emitMessage: (msg: WsServerMessage) => void },
  sessionId: string,
): Promise<void> {
  const eligible = await isResetEligible(deps, sessionId, runner.sessionDir);
  runner.emitMessage({ type: "reset_eligible", sessionId, eligible });
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
  try {
    // Gate on the global setting AND an explicit per-send opt-out.
    if (!deps.getAutoResetMergedBranch()) return NOT_MOVED;
    if (intent === false) return NOT_MOVED;

    const session = deps.getSession(sessionId);
    const prStatus = deps.getPrStatus(sessionId);
    const git = deps.createGitManager(sessionDir);

    if (!(await computeResetEligible(session, prStatus, git))) return NOT_MOVED;
    const base = prStatus!.baseBranch;

    // Fetch the latest base, then RE-validate the full gate (TOCTOU window).
    await git.fetch("origin");
    if (!(await computeResetEligible(session, prStatus, git))) return NOT_MOVED;

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
 * SHI-277 — it also has to name the way FORWARD, because a refusal that reads as
 * a dead end is exactly what makes an agent reach for the reset anyway. A branch
 * whose commits already shipped under different SHAs (a cherry-pick recovery, a
 * squash) fails the `HEAD === mergedHeadSha` clause forever, and there is no
 * `--force`. It is still not stuck: `git rebase` is not blocked by the
 * `block-branch-ops` hook, it is non-destructive where a reset is not (an
 * unshipped commit survives a rebase and is discarded by a reset), and it proves
 * containment by replaying the patches rather than trusting a heuristic. If
 * every commit is already upstream the rebase drops them all and HEAD lands
 * exactly on `origin/<base>` — which flips {@link GitManager.headIsAtBase} and
 * makes `detectAndReArmResetSession` (verified at `services/pr-rearm.ts:185`,
 * reached from `turn-executor`'s `postTurnReArmReset`, which runs whether or not
 * the turn committed) clear the merged state on that same turn. If something is
 * genuinely unshipped it survives the rebase, the session correctly stays
 * merged, and the next commit re-arms it via `detectAndReArmMergedSession`
 * instead. Either way the session opens its next pull request normally, and
 * nothing had to weaken this gate.
 */
export const RESET_REFUSAL_GUIDANCE =
  "Do NOT work around this — do not run `git reset --hard`, `git checkout -f`, "
  + "`git push --force`, or any other manual reset. The check refused because a reset "
  + "here would destroy work that is not recoverable (uncommitted edits have no reflog "
  + "entry, and unmerged commits would be discarded). If you need this branch back on "
  + "its base, rebase instead: `git fetch origin && git rebase origin/<base>` keeps "
  + "anything that has not actually shipped, and drops the commits that have. Otherwise "
  + "report what this said and let the user decide.";

function refuse(reason: string): ExplicitResetOutcome {
  return { outcome: "refused", reason };
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
  return prStatus?.baseBranch ?? session.previousMergedPr?.baseBranch;
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
 * destroy.
 */
export async function resetBranchToBaseExplicit(
  deps: ResetEligibleSignalDeps,
  sessionId: string,
  sessionDir: string,
): Promise<ExplicitResetOutcome> {
  try {
    const session = deps.getSession(sessionId);
    if (!session) return refuse("Session not found.");
    const prStatus = deps.getPrStatus(sessionId);
    const git = deps.createGitManager(sessionDir);

    // Structural safety first — these refuse both outcomes, so they precede the
    // already-at-base short-circuit.
    if (!(await git.isClean())) {
      return refuse(
        "The working tree has uncommitted changes. A reset would discard them permanently "
        + "(uncommitted edits have no reflog entry).",
      );
    }
    const branch = await git.currentBranchOrNull();
    if (!branch) return refuse("HEAD is detached, so a reset would not move the session branch.");
    if (session.branch && branch !== session.branch) {
      return refuse(`HEAD is on '${branch}', not the session branch '${session.branch}'.`);
    }
    if (await git.isRebaseInProgress()) {
      return refuse("A rebase is in progress. Finish or abort it first — a reset would clobber the recovery state.");
    }
    if (await git.isMergeOrSequencerInProgress()) {
      return refuse("A merge / cherry-pick / revert is in progress. Finish or abort it first.");
    }

    const base = resolveResetBase(session, prStatus);
    if (!base) {
      return refuse(
        "No pull-request base is recorded for this session — neither a live pull request nor a "
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
    if (!(await computeResetEligible(session, prStatus, git))) {
      return refuse(
        "This branch carries work that is not on the merged pull request, so a reset would "
        + "discard commits that were never shipped.",
      );
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
        `The branch was reset locally to origin/${base}, but the remote branch could not be `
        + `updated to match (${err instanceof Error ? err.message : String(err)}). Later pushes `
        + "would be rejected as non-fast-forward, so stop here rather than continuing.",
      );
    }

    return { outcome: "reset", base, fromSha: from, toSha: to };
  } catch (err) {
    return refuse(`The reset could not be completed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // The orchestrator ran the git work as ROOT. Without handing ownership back,
    // the agent's very first edit in this turn fails with EACCES. In a `finally`
    // so a refusal or a throw can't skip it — a refused reset still leaves the
    // agent working in this workspace.
    handWorkspaceBackToWorker(sessionDir);
  }
}
