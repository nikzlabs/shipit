import type { SessionInfo } from "../../shared/types.js";
import type { GitManager } from "../../shared/git.js";
import type { PrStatusSummary } from "../../shared/types/github-types.js";
import type { WsServerMessage } from "../../shared/types/ws-server-messages.js";
import { handWorkspaceBackToWorker } from "../session-worker-uid.js";
import { restoreLfsAfterTreeRewrite } from "../git-lfs.js";
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

export type ResetEligibleSignalDeps = Omit<PreTurnResetDeps, "getAutoResetMergedBranch">;

export interface ResetOutcome {
  moved: boolean;
  base?: string;
  prNumber?: number;
  prUrl?: string;
  fromSha?: string;
  toSha?: string;
  agentPrefix?: string;
  skip?: ResetSkipInfo;
}

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

export type ResetPreconditionClause = Extract<
  ResetSkipClause,
  "dirty-tree" | "detached-head" | "wrong-branch" | "rebase-in-progress" | "sequencer-in-progress"
>;

export interface ResetSkip {
  clause: ResetSkipClause;
  detail: string;
}

export interface ResetSkipInfo extends ResetSkip {
  /** Caller persists this; absent when the same refusal was already reported. */
  notice?: string;
  level: "info" | "warn";
}

const NOT_MOVED: ResetOutcome = { moved: false };

const DIRTY_PATH_LIMIT = 10;

// Shared by merge-time and pre-turn notices; process-local and not pruned on teardown.
const notifiedSkipClause = new Map<string, string>();

export function clearResetSkipEpisode(sessionId: string): void {
  notifiedSkipClause.delete(sessionId);
}

// Include merge identity so an uncleared refusal cannot suppress a later merge's notice.
function episodeKey(clause: ResetSkipClause, session: SessionInfo | undefined): string {
  const anchor =
    session?.mergedHeadSha
    ?? session?.previousMergedPr?.mergedHeadSha
    ?? (session?.previousMergedPr?.number !== undefined ? `pr-${session.previousMergedPr.number}` : "");
  return `${anchor}|${clause}`;
}

// Claim atomically; the caller must release the claim if delivery fails.
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

export async function computeResetEligible(
  session: SessionInfo | undefined,
  prStatus: PrStatusSummary | null,
  git: GitManager,
): Promise<boolean> {
  return (await computeResetBlocker(session, prStatus, git)) === null;
}

// Uses remote-tracking refs: callers must fetch and recheck before resetting.
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

  // Ancestry proves no commits would be lost, even without a stored merge anchor.
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

export async function isResetEligible(
  deps: ResetEligibleSignalDeps,
  sessionId: string,
  sessionDir: string,
): Promise<boolean> {
  return (await computeResetEligibility(deps, sessionId, sessionDir)).eligible;
}

export interface ResetEligibility {
  eligible: boolean;
  merged: boolean;
  blocker: ResetSkip | null;
  error?: string;
}

export async function computeResetEligibility(
  deps: ResetEligibleSignalDeps,
  sessionId: string,
  sessionDir: string,
): Promise<ResetEligibility> {
  let merged = false;
  try {
    const session = deps.getSession(sessionId);
    if (!session?.mergedAt) return { eligible: false, merged: false, blocker: null };
    merged = true;
    const prStatus = deps.getPrStatus(sessionId);
    const git = deps.createGitManager(sessionDir);
    const blocker = await computeResetBlocker(session, prStatus, git);
    return { eligible: blocker === null, merged: true, blocker };
  } catch (err) {
    return { eligible: false, merged, blocker: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export type ResetEligibleOrigin =
  | "activation"
  | "post-turn"
  | "merge-detected"
  | "file-change";

// Always emit: another caller may have changed the client's value since this caller last sent it.
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

export type MergeNoticeRunner = Parameters<typeof emitNoticeInTurn>[0];

export async function announceResetStateOnMerge(
  deps: ResetEligibleSignalDeps & {
    chatHistory: InProgressPersister | undefined;
  },
  args: {
    sessionId: string;
    sessionDir: string;
    runner?: MergeNoticeRunner | null;
  },
): Promise<void> {
  const { sessionId, sessionDir, runner } = args;
  // Catch viewer and persistence failures so later merge bookkeeping still runs.
  try {
    const { merged, blocker } = await emitResetEligible(deps, {
      sessionId,
      sessionDir,
      origin: "merge-detected",
      emit: (msg) => runner?.emitMessage(msg),
    });

    if (!merged || !blocker || blocker.clause === "not-merged") {
      clearResetSkipEpisode(sessionId);
      return;
    }

    if (!deps.chatHistory) {
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
      // Permit a later notice if persistence failed, even if a viewer already saw this one.
      clearResetSkipEpisode(sessionId);
      console.error(`[pre-turn-reset] merge-detected notice failed for ${sessionId}:`, err);
    }
  } catch (err) {
    console.error(`[pre-turn-reset] merge-detected announce failed for ${sessionId}:`, err);
  }
}

// Notices render as plain text, so Markdown emphasis would appear literally.
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
  intent?: boolean,
): Promise<ResetOutcome> {
  let mutatedWorkspace = false;
  try {
    const session = deps.getSession(sessionId);
    const prStatus = deps.getPrStatus(sessionId);

    if (!session?.mergedAt) {
      clearResetSkipEpisode(sessionId);
      return NOT_MOVED;
    }

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
    const base = resolveResetBase(session, prStatus)!;

    // Fetch writes .git and yields; hand back ownership and recheck before resetting.
    mutatedWorkspace = true;
    await git.fetch("origin");
    const blockerAfterFetch = await computeResetBlocker(session, prStatus, git);
    if (blockerAfterFetch) return skipped(sessionId, session, prStatus, blockerAfterFetch);

    // Also skips remote repair: an earlier failed push can leave the remote diverged.
    const headNow = await git.getHeadHash();
    const baseTipNow = await git.getRefHash(`origin/${base}`);
    if (headNow && baseTipNow && headNow === baseTipNow) {
      clearResetSkipEpisode(sessionId);
      return NOT_MOVED;
    }

    const { from, to } = await git.resetHardToRemoteBase(base);

    // Orchestrator git disables LFS smudge; restore assets before the agent reads them.
    const lfs = await restoreLfsAfterTreeRewrite(sessionDir, `Reset onto ${base}`, (message) =>
      console.warn(`[pre-turn-reset] ${message}`),
    );
    const lfsWarning = lfs.usesLfs && lfs.status !== "materialized" ? buildLfsStubWarning() : "";

    // Match the remote to the reset branch so later plain pushes can fast-forward.
    try {
      await git.forcePush("origin");
    } catch (err) {
      console.warn(
        `[pre-turn-reset] remote heal force-push failed for ${sessionId} ` +
          `(subsequent auto-push may be rejected as non-fast-forward):`,
        err,
      );
    }

    const prNumber = prStatus?.prNumber ?? session.previousMergedPr?.number;
    const prUrl = prStatus?.prUrl ?? session.previousMergedPr?.url;

    clearResetSkipEpisode(sessionId);

    return {
      moved: true,
      base,
      ...(prNumber !== undefined ? { prNumber } : {}),
      ...(prUrl !== undefined ? { prUrl } : {}),
      fromSha: from,
      toSha: to,
      agentPrefix: buildAgentPrefix(prNumber, base) + lfsWarning,
    };
  } catch (err) {
    console.error(`[pre-turn-reset] auto-reset failed for ${sessionId} (running turn on the un-moved branch):`, err);
    return NOT_MOVED;
  } finally {
    // Reconcile git/worktree owners after any write, including a failed fetch or reset.
    if (mutatedWorkspace) handWorkspaceBackToWorker(sessionDir);
  }
}

function skipped(
  sessionId: string,
  session: SessionInfo,
  prStatus: PrStatusSummary | null,
  skip: ResetSkip,
): ResetOutcome {
  const prNumber = prStatus?.prNumber ?? session.previousMergedPr?.number;
  const base = prStatus?.baseBranch ?? session.previousMergedPr?.baseBranch;
  const level = skip.clause === "setting-off" || skip.clause === "opted-out" ? "info" : "warn";
  console.warn(
    `[pre-turn-reset] skipped for ${sessionId} (${skip.clause}): ${skip.detail}. `
      + `Branch stays on the merged tip${prNumber ? ` (PR #${prNumber})` : ""}.`,
  );
  // Suppress only repeated user notices; opt-outs must not overwrite a standing safety refusal.
  const notice = level === "info" || claimSkipNotice(sessionId, skip.clause, session)
    ? { notice: buildSkipNotice(skip, prNumber, base) }
    : {};
  return {
    moved: false,
    skip: { ...skip, level, ...notice },
    agentPrefix: buildSkipAgentPrefix(skip, prNumber, base),
  };
}

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

export function buildLfsStubWarning(): string {
  return (
    ` NOTE: this repository uses Git LFS and restoring the tracked assets after the `
    + `reset FAILED, so some of them are ~130-byte pointer stubs rather than real `
    + `content — and \`git status\` will still say the tree is clean. Run `
    + `\`git lfs pull\` before reading, building with, or rendering any LFS-tracked `
    + `file, and don't conclude an asset is corrupt until you have.`
  );
}

function buildAgentPrefix(prNumber: number | undefined, base: string): string {
  return (
    `[System] Your previous pull request${prNumber ? ` (#${prNumber})` : ""} was merged into ${base}. ` +
    `This branch has been automatically reset to the latest origin/${base} — it no ` +
    `longer contains the merged commits and starts from current code. Build the ` +
    `requested work on top of this fresh base; do not re-apply or recreate anything ` +
    `from the merged PR. ` +
    `This session is now starting new work, so its title probably describes only ` +
    `the merged PR — check it and run \`shipit session rename --title "..."\` if it ` +
    `no longer fits (a title the user set by hand wins, and the command will say so).`
  );
}

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

export interface ExplicitResetOutcome {
  outcome: "reset" | "already-at-base" | "refused";
  reason?: string;
  base?: string;
  fromSha?: string;
  toSha?: string;
  forced?: boolean;
  forceReason?: string;
}

// Force never bypasses these checks; uncommitted edits have no reflog recovery.
export async function checkResetPreconditions(
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

export const RESET_REFUSAL_GUIDANCE =
  "Do NOT work around this — do not run `git reset --hard`, `git checkout -f`, "
  + "`git push --force`, `git rebase`, or any other manual reset or rewrite. The check refused because a reset "
  + "here would destroy work that is not recoverable (uncommitted edits have no reflog "
  + "entry, and unmerged commits would be discarded). Report what this said and let the "
  + "user decide. If the user tells you to proceed anyway, use the brokered override — "
  + "`shipit branch reset-to-base --force --reason \"<why>\"` — never a manual reset: it "
  + "still refuses over an unclean tree, and it records the reason in the transcript.";

function refuse(sessionId: string, clause: string, reason: string): ExplicitResetOutcome {
  console.warn(`[branch-reset] refused for ${sessionId} (${clause}): ${reason}`);
  return { outcome: "refused", reason };
}

const PRECONDITION_CLAUSES: ReadonlySet<ResetSkipClause> = new Set<ResetSkipClause>([
  "dirty-tree",
  "detached-head",
  "wrong-branch",
  "rebase-in-progress",
  "sequencer-in-progress",
]);

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

function resolveResetBase(session: SessionInfo, prStatus: PrStatusSummary | null): string | undefined {
  if (prStatus?.baseBranch) return prStatus.baseBranch;
  // While merged, an older PR's stored base may belong to a different merge.
  return session.mergedAt ? undefined : session.previousMergedPr?.baseBranch;
}

export async function resetBranchToBaseExplicit(
  deps: ResetEligibleSignalDeps,
  sessionId: string,
  sessionDir: string,
  opts?: {
    force?: { reason: string };
  },
): Promise<ExplicitResetOutcome> {
  const force = opts?.force;
  try {
    const session = deps.getSession(sessionId);
    if (!session) return refuse(sessionId, "no-session", "Session not found.");
    const prStatus = deps.getPrStatus(sessionId);
    const git = deps.createGitManager(sessionDir);

    const unsafe = await checkResetPreconditions(session, git);
    if (unsafe) return refuse(sessionId, unsafe.clause, buildExplicitRefusal(unsafe));

    const base = resolveResetBase(session, prStatus);
    if (!base) {
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

    // Check before the merge anchor: a completed reset already moved HEAD off that anchor.
    const head = await git.getHeadHash();
    const baseTip = await git.getRefHash(`origin/${base}`);
    if (head && baseTip && head === baseTip) {
      return { outcome: "already-at-base", base, ...(head ? { toSha: head } : {}) };
    }

    // Recheck after fetch even with force: the tree may have changed while awaiting it.
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
      const blocker = await computeResetBlocker(session, prStatus, git);
      if (blocker) return refuse(sessionId, blocker.clause, buildExplicitRefusal(blocker));
    }

    const { from, to } = await git.resetHardToRemoteBase(base);

    await restoreLfsAfterTreeRewrite(sessionDir, `Reset onto ${base}`, (message) =>
      console.warn(`[branch-reset] ${message}`),
    );

    // Explicit callers must see push failure before continuing work on a diverged branch.
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
    handWorkspaceBackToWorker(sessionDir);
  }
}
