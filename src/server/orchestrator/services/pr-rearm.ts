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

// An unchanged merged tip needs no fetch; old sessions without an anchor use base comparison.
async function unmovedSinceMerge(session: SessionInfo, git: GitManager): Promise<boolean> {
  const anchor = session.mergedHeadSha;
  if (!anchor) return false;
  const head = await git.getHeadHash();
  return head !== null && head === anchor;
}

// mergedAt can outlive its PR snapshot. Recording an open PR as prior would suppress its later merge.
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

export async function detectAndReArmMergedSession(args: {
  deps: ReArmDeps;
  sessionId: string;
  sessionDir: string;
}): Promise<boolean> {
  const { deps, sessionId, sessionDir } = args;
  const session = deps.sessionManager.get(sessionId);
  if (!session?.mergedAt) return false;

  const prior = priorMergedPr(deps, sessionId);
  if (!prior) return false;
  const baseBranch = prior.baseBranch;

  let progressed: boolean;
  try {
    const git = deps.createGitManager(sessionDir);
    if (await unmovedSinceMerge(session, git)) return false;
    // A stale base ref can falsely report new work.
    if (!(await freshenBaseRef(git, baseBranch, sessionId))) return false;
    progressed = await git.advancedBeyondMergedBase(baseBranch);
  } catch {
    return false;
  }
  if (!progressed) return false;

  deps.sessionManager.clearMerged(sessionId, {
    number: prior.prNumber,
    url: prior.prUrl,
    title: prior.prTitle,
    baseBranch,
    // Preserve the anchor for the explicit reset gate after clearMerged clears its column.
    ...(session.mergedHeadSha ? { mergedHeadSha: session.mergedHeadSha } : {}),
  });
  deps.prStatusPoller.reArm(sessionId, prior.prNumber);
  deps.sseBroadcast("session_list", { sessions: deps.sessionManager.list() });
  return true;
}

// Run every turn: resetting to base produces no commit to trigger the commit-gated path.
export async function detectAndReArmResetSession(args: {
  deps: ReArmDeps;
  sessionId: string;
  sessionDir: string;
  emit: (msg: WsServerMessage) => void;
  /** Set only when the caller just fetched the base. */
  skipFetch?: boolean;
}): Promise<boolean> {
  const { deps, sessionId, sessionDir, emit } = args;
  const session = deps.sessionManager.get(sessionId);
  if (!session?.mergedAt) return false;

  const prior = priorMergedPr(deps, sessionId);
  if (!prior) return false;
  const baseBranch = prior.baseBranch;

  let atBase: boolean;
  try {
    const git = deps.createGitManager(sessionDir);
    if (await unmovedSinceMerge(session, git)) return false;
    if (!args.skipFetch && !(await freshenBaseRef(git, baseBranch, sessionId))) return false;
    atBase = await git.headIsAtBase(baseBranch);
  } catch {
    return false;
  }
  if (!atBase) return false;

  const previousMergedPr = {
    number: prior.prNumber,
    url: prior.prUrl,
    title: prior.prTitle,
    baseBranch,
  };
  deps.sessionManager.clearMerged(sessionId, {
    ...previousMergedPr,
    ...(session.mergedHeadSha ? { mergedHeadSha: session.mergedHeadSha } : {}),
  });
  deps.prStatusPoller.reArm(sessionId, prior.prNumber);
  deps.sseBroadcast("session_list", { sessions: deps.sessionManager.list() });

  // The prior-PR record lets this empty ready card replace the viewer's terminal merged card.
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
