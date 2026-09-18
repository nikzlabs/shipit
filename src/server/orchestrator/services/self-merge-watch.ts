import { randomUUID } from "node:crypto";
import type { SelfMergeWatchCard, SessionMergeWatch } from "../../shared/types.js";
import type { SessionManager } from "../sessions.js";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { ChatHistoryManager } from "../chat-history.js";
import { emitChatCard } from "../chat-card-persistence.js";
import { resolveSessionPr } from "./github.js";
import { ServiceError } from "./types.js";

export interface SelfMergeWatchDeps {
  sessionManager: SessionManager;
  githubAuthManager: GitHubAuthManager;
  createGitManager: (dir: string) => GitManager;
  runnerRegistry: SessionRunnerRegistry;
  chatHistoryManager: ChatHistoryManager;
  mergeWatchManager?: { forgetWatch(sessionId: string): void } | undefined;
}

export interface ArmSelfMergeWatchResult {
  watchId: string;
  prNumber: number;
  prUrl: string;
  prTitle?: string;
  replaced: boolean;
}

function isForeignParentWatch(watch: SessionMergeWatch | undefined, sessionId: string): boolean {
  if (!watch || watch.kind === "self") return false;
  if (watch.parentSessionId === sessionId) return false;
  return watch.state === "armed" || watch.state === "merge-observed";
}

export async function armSelfMergeWatch(
  deps: SelfMergeWatchDeps,
  sessionId: string,
): Promise<ArmSelfMergeWatchResult> {
  const session = deps.sessionManager.get(sessionId);
  if (!session) throw new ServiceError(404, "Session not found");
  if (!session.workspaceDir) throw new ServiceError(400, "Session has no workspace");

  const existing = session.mergeWatch;
  if (isForeignParentWatch(existing, sessionId)) {
    throw new ServiceError(
      409,
      "This session is already being watched by its parent session, and a session can hold "
        + "only one merge-watch. Ask the parent to cancel its watch, or continue without "
        + "arming a self-watch.",
    );
  }

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
  deps.mergeWatchManager?.forgetWatch(sessionId);
  deps.sessionManager.setMergeWatch(sessionId, watch);

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
  deps: Pick<SelfMergeWatchDeps, "sessionManager" | "mergeWatchManager">,
  sessionId: string,
  watchId: string,
): CancelSelfMergeWatchResult {
  const session = deps.sessionManager.get(sessionId);
  if (!session) throw new ServiceError(404, "Session not found");
  const watch = session.mergeWatch;
  if (watch?.kind !== "self") return { cancelled: false, reason: "not-armed" };
  // An old transcript card must not cancel a newer watch.
  if (watch.watchId !== watchId) return { cancelled: false, reason: "superseded" };
  if (deps.mergeWatchManager) deps.mergeWatchManager.forgetWatch(sessionId);
  else deps.sessionManager.setMergeWatch(sessionId, null);
  return { cancelled: true };
}
