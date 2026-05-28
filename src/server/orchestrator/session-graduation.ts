import type { SessionManager } from "./sessions.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { GitManager } from "../shared/git.js";
import type { PrStatusPoller } from "./pr-status-poller.js";
import type { AgentId } from "../shared/types.js";
import { generateSessionName } from "./session-namer.js";
import { getErrorMessage } from "./validation.js";

export interface SessionGraduationDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  createGitManager: (dir: string) => GitManager;
  prStatusPoller: PrStatusPoller;
  sseBroadcast: (event: string, data: unknown) => void;
}

export interface ScheduleSessionNamingOpts {
  sessionId: string;
  userText: string;
  agentId: AgentId;
}

/**
 * Fire-and-forget AI naming for a freshly-graduated session.
 *
 * Used by every path that turns a warm/placeholder session into an active one:
 * `send_message` warm graduation and `POST /api/sessions/headless`. Both
 * surfaces enter via this function so a future fourth surface can't drift —
 * the "no name on quick sessions" regression is the bug class this exists to
 * make structurally impossible.
 *
 * Runs `generateSessionName` against the session's active agent CLI. On
 * success, renames the branch from `shipit/<random>` to
 * `shipit/<slug>-<random>`, updates the title, and broadcasts
 * `session_renamed` over SSE. Always finalises the branch-renamed flag and
 * emits the PR-ready card so the UI never hangs on a failed name.
 *
 * Never throws — failures are logged and the finaliser runs unconditionally.
 */
export function scheduleSessionNaming(
  deps: SessionGraduationDeps,
  opts: ScheduleSessionNamingOpts,
): void {
  const { sessionManager, runnerRegistry, createGitManager, prStatusPoller, sseBroadcast } = deps;
  const { sessionId, userText, agentId } = opts;

  const finalizeBranchRenamed = async (): Promise<void> => {
    try {
      sessionManager.setBranchRenamed(sessionId, true);
      const s = sessionManager.get(sessionId);
      if (!s?.remoteUrl || !s.workspaceDir) return;
      if (prStatusPoller.getStatus(sessionId)) return; // PR already exists
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
      console.warn("[session-graduation] finalizeBranchRenamed failed:", getErrorMessage(err));
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
      if (currentBranch && session.workspaceDir) {
        // Extract the random slug from the prefix (e.g. "shipit/abc123" → "abc123")
        // and rebuild as shipit/<descriptive-name>-<random-slug>
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
      console.warn("[session-graduation] Branch rename failed:", getErrorMessage(err));
      await finalizeBranchRenamed();
    }
  }).catch(async (err: unknown) => {
    console.warn("[session-graduation] Session naming failed:", err);
    await finalizeBranchRenamed();
  });
}
