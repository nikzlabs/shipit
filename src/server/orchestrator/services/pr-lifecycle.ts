/**
 * PR lifecycle card emission (docs/149).
 *
 * Consolidates the post-commit "emit a PR lifecycle update" flow that was
 * previously duplicated between the streaming and non-streaming branches of
 * `runAgentWithMessage`. Pulled out so:
 *
 *   1. The two WS-handler branches share one implementation, and
 *   2. The system-turn path (`runDispatchedTurn` — used by spawned sessions and
 *      CI auto-fix) can invoke the same flow via a single optional hook.
 *
 * The helper only fires when the session has a remote, hasn't been merged,
 * and no PR is currently tracked by the poller. It auto-creates the PR when
 * the user's `autoCreatePr` setting + GitHub auth are both on; otherwise
 * emits a "ready" card with diff stats for the user to click "open PR".
 */

import type { WsServerMessage } from "../../shared/types.js";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { CredentialStore } from "../credential-store.js";
import type { SessionManager } from "../sessions.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import { getErrorMessage } from "../validation.js";
import { quickCreatePr } from "./github.js";

export interface PrLifecycleDeps {
  sessionManager: SessionManager;
  prStatusPoller: PrStatusPoller;
  githubAuthManager: GitHubAuthManager;
  credentialStore: CredentialStore;
  chatHistoryManager: ChatHistoryManager;
  generateText: (prompt: string, cwd: string) => Promise<string>;
  createGitManager: (dir: string) => GitManager;
}

/**
 * Emit a PR lifecycle update after a commit lands on a session that has a
 * remote. No-op when the session lacks a remote, was merged, has a renamed
 * branch, or already has a PR tracked by the poller.
 *
 * Either fires an auto-create flow (creating → open/error) when the
 * `autoCreatePr` toggle + GitHub auth are both on, or emits a "ready" card
 * with diff stats so the user can pick up from there.
 */
export async function emitPrLifecycleAfterCommit(args: {
  deps: PrLifecycleDeps;
  sessionId: string;
  sessionDir: string;
  commitHash: string;
  emit: (msg: WsServerMessage) => void;
}): Promise<void> {
  const { deps, sessionId, sessionDir, emit } = args;
  const session = deps.sessionManager.get(sessionId);
  if (!session?.remoteUrl) return;
  if (session.branchRenamed === false) return;
  if (session.mergedAt) return;

  try {
    const prStatus = deps.prStatusPoller.getStatus(sessionId);
    if (prStatus) return; // poller already drives updates via SSE

    const git = deps.createGitManager(sessionDir);

    const shouldAutoCreate = deps.credentialStore.getAutoCreatePr()
      && deps.githubAuthManager.authenticated;

    if (shouldAutoCreate) {
      emit({
        type: "pr_lifecycle_update",
        sessionId,
        cardId: `pr-card-${sessionId}`,
        phase: "creating",
      });
      try {
        const result = await quickCreatePr(
          git,
          deps.githubAuthManager,
          deps.chatHistoryManager,
          deps.generateText,
          sessionId,
          session.title ?? "",
          sessionDir,
          session.remoteUrl,
        );
        if (session.remoteUrl) {
          deps.prStatusPoller.trackSession(sessionId, session.remoteUrl);
        }
        emit({
          type: "pr_lifecycle_update",
          sessionId,
          cardId: `pr-card-${sessionId}`,
          phase: "open",
          pr: {
            number: result.number,
            title: result.title,
            body: result.body,
            url: result.url,
            baseBranch: result.baseBranch,
            headBranch: result.headBranch,
            insertions: result.insertions,
            deletions: result.deletions,
          },
        });
      } catch (err) {
        console.error("[pr-lifecycle] Auto-create PR failed:", getErrorMessage(err));
        emit({
          type: "pr_lifecycle_update",
          sessionId,
          cardId: `pr-card-${sessionId}`,
          phase: "error",
          errorMessage: getErrorMessage(err),
        });
      }
      return;
    }

    // Ready card: diff stats vs. main so the user can click "open PR".
    const headBranch = session.branch || await git.getCurrentBranch();
    const { insertions: totalInsertions, deletions: totalDeletions } = await git.diffStatVsBranch("main");
    emit({
      type: "pr_lifecycle_update",
      sessionId,
      cardId: `pr-card-${sessionId}`,
      phase: "ready",
      headBranch,
      totalInsertions,
      totalDeletions,
    });
  } catch (err) {
    console.error("[pr-lifecycle] Failed to compute diff stats:", getErrorMessage(err));
  }
}
