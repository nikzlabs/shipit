import { randomUUID } from "node:crypto";
import type { SelfMergeWatchCard, SessionMergeWatch } from "../../shared/types.js";
import { isLiveMergeWatch, type SessionManager } from "../sessions.js";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { ChatHistoryManager } from "../chat-history.js";
import { emitChatCard, emitNoticeInTurn, persistNoticeUnattached } from "../chat-card-persistence.js";
import { endSelfMergeWatchCard } from "../self-merge-watch-card.js";
import { resolveSessionPr } from "./github.js";
import { ServiceError } from "./types.js";

export interface SelfMergeWatchDeps {
  sessionManager: SessionManager;
  githubAuthManager: GitHubAuthManager;
  createGitManager: (dir: string) => GitManager;
  runnerRegistry: SessionRunnerRegistry;
  chatHistoryManager: ChatHistoryManager;
  mergeWatchManager?: { forgetSelfWatch(sessionId: string): void } | undefined;
}

export interface ArmSelfMergeWatchResult {
  watchId: string;
  prNumber: number;
  prUrl: string;
  prTitle?: string;
  replaced: boolean;
}

// A parent's watch on this session is stored apart (`mergeWatch`); this never reads or writes it.
export async function armSelfMergeWatch(
  deps: SelfMergeWatchDeps,
  sessionId: string,
): Promise<ArmSelfMergeWatchResult> {
  const session = deps.sessionManager.get(sessionId);
  if (!session) throw new ServiceError(404, "Session not found");
  if (!session.workspaceDir) throw new ServiceError(400, "Session has no workspace");

  const git = deps.createGitManager(session.workspaceDir);
  // The persisted PR snapshot can still name the previous, merged PR.
  const { pr } = await resolveSessionPr(git, deps.githubAuthManager, session.remoteUrl);
  if (!pr) {
    throw new ServiceError(
      400,
      "No open pull request for this session's branch, so there is no merge to wait for. "
        + "Open a PR first (gh pr create), then arm the watch. If your PR has already merged, "
        + "just continue the work in this turn.",
    );
  }

  // Read after the lookup: another arm of this session can have completed while it ran, and
  // that one's watch is what this arm replaces.
  const existing = deps.sessionManager.getSelfMergeWatch(sessionId);
  const watchId = randomUUID();
  const watch: SessionMergeWatch = {
    parentSessionId: sessionId,
    kind: "self",
    watchId,
    prNumber: pr.number,
    state: "armed",
    registeredAt: new Date().toISOString(),
  };
  // Re-arming can occur during delivery. Clear old retry state before replacing
  // the watch so it cannot suppress the new watch's first retry.
  deps.mergeWatchManager?.forgetSelfWatch(sessionId);
  deps.sessionManager.setSelfMergeWatch(sessionId, watch);
  const parentWatch = deps.sessionManager.getMergeWatch(sessionId);
  const replaces = existing && isLiveMergeWatch(existing)
    ? ` (replaces its ${existing.state} self-watch on PR #${existing.prNumber ?? "?"})`
    : "";
  const beside = parentWatch && isLiveMergeWatch(parentWatch)
    ? `; parent ${parentWatch.parentSessionId} also watches this session`
    : "";
  console.log(
    `[merge-watch] ${sessionId} armed a self-watch on PR #${pr.number} (watch ${watchId})${replaces}${beside}`,
  );

  const card: SelfMergeWatchCard = {
    cardId: `self-merge-watch-${randomUUID()}`,
    watchId,
    prNumber: pr.number,
    prUrl: pr.url,
    ...(pr.title ? { prTitle: pr.title } : {}),
    ...(session.branch ? { branch: session.branch } : {}),
    createdAt: new Date().toISOString(),
  };
  const runner = deps.runnerRegistry.get(sessionId);
  // The older arm card stays in the transcript; its watch is gone, and the card says so. A watch
  // that already saw its merge has its end on the card.
  if (existing?.state === "armed") endSelfMergeWatchCard(deps, sessionId, existing.watchId, "replaced");
  // A re-arm on the same PR, or over a watch that saw its merge, loses nothing and gets no note.
  if (existing?.state === "armed" && existing.prNumber !== undefined && existing.prNumber !== pr.number) {
    const text = `The merge-watch on PR #${existing.prNumber} was replaced by a watch on PR #${pr.number}. `
      + `This session will not be woken when PR #${existing.prNumber} merges.`;
    if (runner) emitNoticeInTurn(runner, sessionId, text, deps.chatHistoryManager, "warn");
    else persistNoticeUnattached(deps.chatHistoryManager, sessionId, text, "warn");
  }
  if (runner) {
    emitChatCard(
      runner,
      { type: "self_merge_watch_card", sessionId, card },
      { role: "assistant", text: "", selfMergeWatch: card },
      { chatHistoryManager: deps.chatHistoryManager, sessionId },
    );
  }

  return {
    watchId,
    prNumber: pr.number,
    prUrl: pr.url,
    ...(pr.title ? { prTitle: pr.title } : {}),
    replaced: existing?.kind === "self",
  };
}

export interface CancelSelfMergeWatchResult {
  cancelled: boolean;
  reason?: "not-armed" | "superseded";
}

export function cancelSelfMergeWatch(
  deps: Pick<SelfMergeWatchDeps, "sessionManager" | "mergeWatchManager" | "runnerRegistry" | "chatHistoryManager">,
  sessionId: string,
  watchId: string,
): CancelSelfMergeWatchResult {
  const session = deps.sessionManager.get(sessionId);
  if (!session) throw new ServiceError(404, "Session not found");
  const watch = session.selfMergeWatch;
  if (watch?.kind !== "self") return { cancelled: false, reason: "not-armed" };
  // An old transcript card must not cancel a newer watch.
  if (watch.watchId !== watchId) return { cancelled: false, reason: "superseded" };
  if (deps.mergeWatchManager) deps.mergeWatchManager.forgetSelfWatch(sessionId);
  else deps.sessionManager.setSelfMergeWatch(sessionId, null);
  endSelfMergeWatchCard(deps, sessionId, watchId, "cancelled");
  console.log(
    `[merge-watch] the user cancelled the self-watch of ${sessionId} on PR #${watch.prNumber ?? "?"} `
    + `(watch ${watchId}, ${watch.state})`,
  );
  return { cancelled: true };
}
