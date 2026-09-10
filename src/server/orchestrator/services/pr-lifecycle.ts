import type { WsServerMessage } from "../../shared/types.js";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { CredentialStore } from "../credential-store.js";
import type { SessionManager } from "../sessions.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import { getErrorMessage } from "../validation.js";
import { activatePendingAutoMergeForPr, quickCreatePr } from "./github.js";
import { notableFilesForBranch } from "./notable-files.js";
import { recordWitnessedPrCreate } from "./pr-provenance.js";
import type { GenerateText } from "../non-turn-model.js";

export interface PrLifecycleDeps {
  sessionManager: SessionManager;
  prStatusPoller: PrStatusPoller;
  githubAuthManager: GitHubAuthManager;
  credentialStore: CredentialStore;
  chatHistoryManager: ChatHistoryManager;
  generateText: GenerateText;
  createGitManager: (dir: string) => GitManager;
}

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

  // This record lets new cards replace a stale merged card and retain its base branch.
  const previousMergedPr = session.previousMergedPr;

  try {
    // Refresh before every early return; the poller preserves but never recomputes this list.
    try {
      const stripGit = deps.createGitManager(sessionDir);
      const base =
        deps.prStatusPoller.getStatus(sessionId)?.baseBranch
        ?? previousMergedPr?.baseBranch
        ?? await stripGit.getDefaultBranch();
      const notableFiles = await notableFilesForBranch(stripGit, base);
      emit({
        type: "pr_notable_files",
        sessionId,
        cardId: `pr-card-${sessionId}`,
        notableFiles,
      });
    } catch {
      // Keep the last-known list on a git error.
    }

    const prStatus = deps.prStatusPoller.getStatus(sessionId);
    if (prStatus) {
      return;
    }

    const git = deps.createGitManager(sessionDir);

    // Recover an existing PR only for a branch with a remote-tracking ref.
    if (deps.githubAuthManager.authenticated) {
      try {
        const branch = session.branch || await git.getCurrentBranch();
        const remoteBranches = await git.listRemoteBranches();
        if (branch && remoteBranches.includes(branch)) {
          deps.prStatusPoller.trackSession(sessionId, session.remoteUrl);
          await deps.prStatusPoller.forceRefreshSession(sessionId);
          if (deps.prStatusPoller.getStatus(sessionId)) return;
        }
      } catch {
        // Fall through to the ready/create flow.
      }
    }

    const shouldAutoCreate = deps.credentialStore.getAutoCreatePr()
      && deps.githubAuthManager.authenticated;

    if (shouldAutoCreate) {
      emit({
        type: "pr_lifecycle_update",
        sessionId,
        cardId: `pr-card-${sessionId}`,
        phase: "creating",
        ...(previousMergedPr ? { previousMergedPr } : {}),
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
          previousMergedPr
            ? { baseBranch: previousMergedPr.baseBranch, forceWithLease: true }
            : undefined,
        );
        recordWitnessedPrCreate(deps.sessionManager, sessionId, result);
        if (session.remoteUrl) {
          deps.prStatusPoller.trackSession(sessionId, session.remoteUrl);
          await activatePendingAutoMergeForPr(
            deps.githubAuthManager,
            deps.prStatusPoller,
            sessionId,
            result.url,
            result.number,
          );
        }
        const autoMerge = deps.prStatusPoller.getAutoMergeState(sessionId);
        const notableFiles = await notableFilesForBranch(git, result.baseBranch);
        emit({
          type: "pr_lifecycle_update",
          sessionId,
          cardId: `pr-card-${sessionId}`,
          phase: "open",
          ...(notableFiles.length > 0 ? { notableFiles } : {}),
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
          autoMerge: autoMerge
            ? {
                enabled: autoMerge.enabled,
                mergeMethod: autoMerge.mergeMethod,
                managed: autoMerge.managed,
                managedReason: autoMerge.managedReason,
                settingsUrl: autoMerge.settingsUrl,
                reason: autoMerge.reason,
                error: autoMerge.error,
              }
            : undefined,
          ...(previousMergedPr ? { previousMergedPr } : {}),
        });
      } catch (err) {
        console.error("[pr-lifecycle] Auto-create PR failed:", getErrorMessage(err));
        emit({
          type: "pr_lifecycle_update",
          sessionId,
          cardId: `pr-card-${sessionId}`,
          phase: "error",
          errorMessage: getErrorMessage(err),
          ...(previousMergedPr ? { previousMergedPr } : {}),
        });
      }
      return;
    }

    const headBranch = session.branch || await git.getCurrentBranch();
    const readyBase = previousMergedPr?.baseBranch ?? await git.getDefaultBranch();
    const { insertions: totalInsertions, deletions: totalDeletions } = await git.diffStatVsBranch(readyBase);
    const notableFiles = await notableFilesForBranch(git, readyBase);
    const autoMerge = deps.prStatusPoller.getAutoMergeState(sessionId);
    emit({
      type: "pr_lifecycle_update",
      sessionId,
      cardId: `pr-card-${sessionId}`,
      phase: "ready",
      headBranch,
      totalInsertions,
      totalDeletions,
      ...(notableFiles.length > 0 ? { notableFiles } : {}),
      autoMerge: autoMerge
        ? {
            enabled: autoMerge.enabled,
            mergeMethod: autoMerge.mergeMethod,
            managed: autoMerge.managed,
            managedReason: autoMerge.managedReason,
            settingsUrl: autoMerge.settingsUrl,
            reason: autoMerge.reason,
            error: autoMerge.error,
          }
        : undefined,
      ...(previousMergedPr ? { previousMergedPr } : {}),
    });
  } catch (err) {
    console.error("[pr-lifecycle] Failed to compute diff stats:", getErrorMessage(err));
  }
}
