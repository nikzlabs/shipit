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
import { activatePendingAutoMergeForPr, quickCreatePr } from "./github.js";
import { notableFilesForBranch } from "./notable-files.js";

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

  // docs/202 — when this session was re-armed (un-merged after a rebase), its
  // row carries a `previousMergedPr` breadcrumb. We thread it onto every card we
  // emit here (so the client renders the "previously merged #N" note AND so
  // `updateCard` lets the card override a stale terminal merged card), use its
  // base for the ready diff + new-PR base, and force-push past the surviving
  // diverged remote branch. `clearMerged` runs in the shared re-arm helper
  // *before* this function, so by now `session.mergedAt` is already null.
  const previousMergedPr = session.previousMergedPr;

  try {
    const prStatus = deps.prStatusPoller.getStatus(sessionId);
    if (prStatus) {
      // The poller drives phase/status/CI for an existing PR over SSE, so the
      // lifecycle-update path stops here. But the changed-docs strip's
      // notableFiles is git-derived locally and the poller never recomputes it
      // (it preserves the last-known list) — without this refresh the strip
      // stays frozen at the PR-creation snapshot and misses docs changed in
      // later turns (docs/210). Re-derive it from the current branch and emit a
      // notableFiles-only patch that merges into the live card without touching
      // the poller-owned fields.
      try {
        const git = deps.createGitManager(sessionDir);
        const notableFiles = await notableFilesForBranch(git, sessionDir, prStatus.baseBranch);
        emit({
          type: "pr_notable_files",
          sessionId,
          cardId: `pr-card-${sessionId}`,
          notableFiles,
        });
      } catch {
        // Best-effort — a git error just leaves the last-known strip in place.
      }
      return; // poller drives the rest via SSE
    }

    const git = deps.createGitManager(sessionDir);

    // Recovery: the poller has no PR for this session, but one may already
    // exist on GitHub — the agent ran `gh pr create` and the route's track /
    // force-refresh didn't stick (HTTP blip, orchestrator restart mid-create,
    // remoteUrl not yet persisted at startup), or the PR was opened
    // out-of-band. Track the session and force a single refresh so the poller
    // discovers the PR by branch name and broadcasts it. Bounded to branches
    // that have actually been pushed (checked via the local remote-tracking
    // ref — no network) so un-pushed / no-PR sessions add zero GitHub calls.
    // If a PR surfaces, return: the poller now drives the card over SSE.
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
        // Best-effort recovery — fall through to the normal ready/create flow.
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
        // docs/205 — the changed-docs strip's notable-file list, derived from
        // the same base...HEAD diff that produced the PR.
        const notableFiles = await notableFilesForBranch(git, sessionDir, result.baseBranch);
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

    // Ready card: diff stats vs. the base branch so the user can click "open
    // PR". For a re-armed session use the prior PR's base (re-arm knows it);
    // otherwise default to "main" (the generic cold-session limitation).
    const headBranch = session.branch || await git.getCurrentBranch();
    const readyBase = previousMergedPr?.baseBranch ?? "main";
    const { insertions: totalInsertions, deletions: totalDeletions } = await git.diffStatVsBranch(readyBase);
    // docs/205 — notable files (docs + config) changed vs the base, for the
    // card's collapsible changed-docs strip.
    const notableFiles = await notableFilesForBranch(git, sessionDir, readyBase);
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
