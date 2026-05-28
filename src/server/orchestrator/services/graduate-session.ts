/**
 * graduateSession — SINGLE SOURCE OF TRUTH for the warm → active session
 * transition. Every session-creation surface in the orchestrator MUST end
 * with a call to this function. The current call sites are:
 *
 *   - ws-handlers/send-message.ts   (warm-graduation on first message)
 *   - services/headless-sessions.ts (POST /api/sessions/headless)
 *   - services/child-sessions.ts    (POST /api/sessions/:parentId/spawn)
 *   - services/session-fork-merge.ts (POST /api/sessions/:id/fork +
 *                                     rollback-driven fork via
 *                                     handleRewindAtGap)
 *
 * If you are adding a fifth surface, it MUST end here too. If you find
 * yourself calling any of the following directly outside this module:
 *
 *   sessionManager.setWarm(id, false)
 *   sessionManager.track(id)
 *   sessionManager.setBranchRenamed(...)
 *   scheduleSessionNaming(...)       // it's private to this file — don't re-export
 *   repoStore.touch(remoteUrl)
 *   sseBroadcast("session_list", ...) // as part of session creation
 *
 * STOP and call graduateSession() instead. Hand-rolling subsets of these
 * is the bug class docs/156 was opened to make impossible.
 *
 * Note: `warmSessionForRepo` is intentionally NOT part of this contract.
 * Quick / child / fork all reach graduation via `claimSessionService.claim`,
 * which already re-warms the pool. Warm-graduation is the only surface that
 * doesn't go through claim, so `send-message.ts` calls `warmSessionForRepo`
 * inline. See docs/156 "warmSessionForRepo is deliberately NOT a step."
 */

import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { RepoStore } from "../repo-store.js";
import type { GitManager } from "../../shared/git.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { AgentId } from "../../shared/types.js";
import { generateSessionName } from "../session-namer.js";
import { getErrorMessage } from "../validation.js";

export interface GraduateSessionDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  repoStore: RepoStore;
  createGitManager: (dir: string) => GitManager;
  /**
   * Optional — runtimes without a PR poller (tests, dogfood-local mode) omit
   * it. When undefined, the AI-naming finalizer skips the "PR already
   * tracked?" short-circuit and emits the PR-ready card anyway.
   */
  prStatusPoller?: PrStatusPoller;
  sseBroadcast: (event: string, data: unknown) => void;
}

export interface GraduateSessionOpts {
  sessionId: string;
  /**
   * First-message text. Drives the placeholder title and the AI-naming
   * prompt. Pass an empty string for surfaces that have no first message
   * (fork) — AI naming will skip anyway whenever `explicitTitle` /
   * `explicitBranch` is set.
   */
  userText: string;
  /** Effective agent id for the AI-naming CLI call. */
  agentId: AgentId;
  /**
   * When set, the caller has chosen this title and AI naming must NOT
   * overwrite it. Becomes the placeholder title; `setBranchRenamed(true)`
   * is then set synchronously.
   */
  explicitTitle?: string;
  /**
   * When set, the caller has chosen this branch and AI naming must NOT
   * touch it. The branch row is assumed to already match — graduate does
   * not call `setBranch`.
   */
  explicitBranch?: string;
  /**
   * When true, AI naming (if it runs at all) only updates the title and
   * leaves the on-disk branch + `session.branch` row alone. Required for
   * child sessions: `POST /spawn` returns the branch in its response body
   * and the CLI shim prints it, so a delayed rename would make the printed
   * value stale.
   */
  skipBranchRename?: boolean;
  /** Optional model override (quick + child). */
  model?: string;
  /** Optional parent linkage (child only). */
  parentSessionId?: string;
  /** Optional spawn-turn id paired with `parentSessionId`. */
  spawnedByTurn?: string;
}

/**
 * Promote a session row from warm / placeholder to user-visible active.
 *
 * Synchronous. AI naming runs in the background; the function returns
 * before it completes.
 *
 * Preconditions (callers are responsible for):
 *   - The session row exists in `sessionManager`.
 *   - The workspace exists on disk (when `session.workspaceDir` is set).
 *   - `session.remoteUrl` is set when the caller wants pool-warming /
 *     repoStore.touch to take effect. Quick / child / fork already do this
 *     via their claim or fork-specific setup.
 *   - `session.branch` is set to the desired branch name when the caller
 *     intends `explicitBranch` semantics.
 */
export function graduateSession(deps: GraduateSessionDeps, opts: GraduateSessionOpts): void {
  const { sessionManager, runnerRegistry, repoStore, createGitManager, prStatusPoller, sseBroadcast } = deps;
  const { sessionId, userText, agentId, explicitTitle, explicitBranch, skipBranchRename, model, parentSessionId, spawnedByTurn } = opts;

  // 1. Activation — flip warm to false (no-op when already active, e.g. fork).
  sessionManager.setWarm(sessionId, false);

  // 2. Persistence — refresh last_used_at; idempotent on existing rows.
  sessionManager.track(sessionId);

  // 3. Placeholder title (explicit caller value wins; otherwise prompt slice).
  const placeholderTitle = explicitTitle?.trim() || userText.slice(0, 60) || "New session";
  sessionManager.rename(sessionId, placeholderTitle);

  // 4. Optional model + parent linkage (child + quick concerns).
  if (model) sessionManager.setModel(sessionId, model);
  if (parentSessionId) sessionManager.setParentSession(sessionId, parentSessionId, spawnedByTurn);

  // 5. Naming policy: AI rename only when caller pinned nothing AND the
  //    workspace exists. Either explicit field opts out — the caller's
  //    chosen value is authoritative and graduation must not silently
  //    overwrite it.
  const session = sessionManager.get(sessionId);
  const shouldAutoName = !explicitTitle && !explicitBranch && session?.workspaceDir;
  if (shouldAutoName) {
    scheduleSessionNaming(
      { sessionManager, runnerRegistry, createGitManager, prStatusPoller, sseBroadcast },
      { sessionId, userText, agentId, skipBranchRename: skipBranchRename ?? false },
    );
  } else {
    sessionManager.setBranchRenamed(sessionId, true);
  }

  // 6. Repo usage tracking — drives "most recently used repo" ordering in
  //    the sidebar. Read remoteUrl *after* the placeholder rename above so
  //    we pick up the latest row.
  const updated = sessionManager.get(sessionId);
  if (updated?.remoteUrl) repoStore.touch(updated.remoteUrl);

  // 7. Single SSE broadcast. Every previous per-route broadcast is deleted
  //    (docs/156 "Removing the duplicate `session_list` broadcasts").
  sseBroadcast("session_list", { sessions: sessionManager.list() });
}

// ---------------------------------------------------------------------------
// Private — fire-and-forget AI naming. Folded in from the previous fix's
// `session-graduation.ts`. Not exported: every entry point is graduate().
// ---------------------------------------------------------------------------

interface ScheduleSessionNamingDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  createGitManager: (dir: string) => GitManager;
  prStatusPoller?: PrStatusPoller;
  sseBroadcast: (event: string, data: unknown) => void;
}

interface ScheduleSessionNamingOpts {
  sessionId: string;
  userText: string;
  agentId: AgentId;
  /**
   * When true, the AI-renamed title is applied but the on-disk branch is
   * left untouched and `session.branch` is not rewritten. Used by child
   * sessions whose branch is returned synchronously to the agent by the
   * spawn API — a delayed rename would make that response stale.
   */
  skipBranchRename: boolean;
}

function scheduleSessionNaming(deps: ScheduleSessionNamingDeps, opts: ScheduleSessionNamingOpts): void {
  const { sessionManager, runnerRegistry, createGitManager, prStatusPoller, sseBroadcast } = deps;
  const { sessionId, userText, agentId, skipBranchRename } = opts;

  const finalizeBranchRenamed = async (): Promise<void> => {
    try {
      sessionManager.setBranchRenamed(sessionId, true);
      const s = sessionManager.get(sessionId);
      if (!s?.remoteUrl || !s.workspaceDir) return;
      if (prStatusPoller?.getStatus(sessionId)) return; // PR already exists
      if (s.mergedAt) return; // PR was already merged
      try {
        const git = createGitManager(s.workspaceDir);
        const headBranch = s.branch || await git.getCurrentBranch();
        const { insertions, deletions } = await git.diffStatVsBranch("main");
        const runner = runnerRegistry.get(sessionId);
        runner?.emitMessage({
          type: "pr_lifecycle_update",
          sessionId,
          cardId: `pr-card-${sessionId}`,
          phase: "ready",
          headBranch,
          totalInsertions: insertions,
          totalDeletions: deletions,
        });
      } catch {
        // Diff stats may fail if no commits yet — post-commit will retry
      }
    } catch (err) {
      console.warn("[graduate-session] finalizeBranchRenamed failed:", getErrorMessage(err));
    }
  };

  // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget session naming
  generateSessionName(userText, agentId).then(async (nameResult) => {
    if (!nameResult) {
      await finalizeBranchRenamed();
      return;
    }
    try {
      const session = sessionManager.get(sessionId);
      if (!session) {
        await finalizeBranchRenamed();
        return;
      }
      const currentBranch = session.branch;
      if (!skipBranchRename && currentBranch && session.workspaceDir) {
        // Extract the random slug from the prefix (e.g. "shipit/abc123" →
        // "abc123") and rebuild as shipit/<descriptive-name>-<random-slug>.
        const randomSlug = currentBranch.replace(/^shipit\//, "");
        const newBranchName = `shipit/${nameResult.slug}-${randomSlug}`;
        const sessionGit = createGitManager(session.workspaceDir);
        await sessionGit.renameBranch(currentBranch, newBranchName);
        sessionManager.setBranch(sessionId, newBranchName);
      }
      sessionManager.rename(sessionId, nameResult.title);
      const updatedSession = sessionManager.get(sessionId);
      if (updatedSession) {
        const runner = runnerRegistry.get(sessionId);
        runner?.emitMessage({ type: "session_renamed", session: updatedSession });
        sseBroadcast("session_renamed", { session: updatedSession });
      }
      await finalizeBranchRenamed();
    } catch (err) {
      console.warn("[graduate-session] Branch rename failed:", getErrorMessage(err));
      await finalizeBranchRenamed();
    }
  }).catch(async (err: unknown) => {
    console.warn("[graduate-session] Session naming failed:", err);
    await finalizeBranchRenamed();
  });
}
