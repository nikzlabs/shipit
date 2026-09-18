import type { AgentId } from "../../shared/types.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { RepoGit } from "../repo-git.js";
import type { RepoStore } from "../repo-store.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "../session-runner.js";
import type { SessionManager } from "../sessions.js";
import { getErrorMessage } from "../validation.js";
import { restoreSessionWorkspace } from "./session.js";

export interface MaterializeRunnerDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  createRepoGit: (dir: string) => RepoGit;
  getBareCacheDir: (url: string) => string;
  githubAuthManager: GitHubAuthManager;
  repoStore: RepoStore;
}

export type MaterializeRunnerOutcome =
  | { status: "ready"; runner: SessionRunnerInterface }
  | { status: "archived" }
  | { status: "no-workspace" }
  | { status: "restore-failed"; message: string };

interface NeedsRestore {
  status: "needs-restore";
  workspaceDir: string;
  agentId: AgentId;
}

/** Keep the common path synchronous to preserve WS connection frame order. */
export function materializeRunnerSync(
  deps: MaterializeRunnerDeps,
  sessionId: string,
  fallbackAgentId: AgentId,
): MaterializeRunnerOutcome | NeedsRestore {
  const session = deps.sessionManager.get(sessionId);

  if (session?.archived || session?.userArchived) return { status: "archived" };

  const sessionAgentId = session?.agentId ?? fallbackAgentId;

  // Replace a stale default agent only between turns.
  const existing = deps.runnerRegistry.get(sessionId);
  if (existing) {
    if (!existing.running && existing.agentId !== sessionAgentId) {
      existing.agentId = sessionAgentId;
    }
    return { status: "ready", runner: existing };
  }

  const dir = session?.workspaceDir ?? null;
  if (!dir) return { status: "no-workspace" };

  // Light sessions retain their checkout; runner startup restores dependencies.
  if (session?.diskTier === "light") {
    deps.sessionManager.setDiskTier(sessionId, "hot");
  } else if (session?.remoteUrl) {
    return { status: "needs-restore", workspaceDir: dir, agentId: sessionAgentId };
  }

  return {
    status: "ready",
    runner: deps.runnerRegistry.getOrCreate(sessionId, dir, sessionAgentId),
  };
}

export async function materializeRunner(
  deps: MaterializeRunnerDeps,
  sessionId: string,
  fallbackAgentId: AgentId,
): Promise<MaterializeRunnerOutcome> {
  const outcome = materializeRunnerSync(deps, sessionId, fallbackAgentId);
  if (outcome.status !== "needs-restore") return outcome;
  return finishRestore(deps, sessionId, outcome);
}

/** Restore the checkout before container creation needs its bind-mount source. */
export async function finishRestore(
  deps: MaterializeRunnerDeps,
  sessionId: string,
  pending: NeedsRestore,
): Promise<MaterializeRunnerOutcome> {
  try {
    await restoreSessionWorkspace(
      deps.sessionManager,
      deps.createRepoGit,
      deps.getBareCacheDir,
      deps.githubAuthManager,
      deps.repoStore,
      sessionId,
    );
  } catch (err) {
    const message = getErrorMessage(err);
    console.error(`[activate] workspace restore failed for ${sessionId}:`, message);
    return { status: "restore-failed", message };
  }
  return {
    status: "ready",
    runner: deps.runnerRegistry.getOrCreate(sessionId, pending.workspaceDir, pending.agentId),
  };
}
