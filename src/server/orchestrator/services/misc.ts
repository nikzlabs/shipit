/**
 * Miscellaneous services — reads (features, usage, bootstrap) and mutations
 * (full reset, preview errors).
 */

import path from "node:path";
import fs from "node:fs/promises";
import type { SessionManager } from "../sessions.js";
import type { RepoStore } from "../repo-store.js";
import type { GitManager } from "../../shared/git.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { AgentId } from "../../shared/types.js";
import type { UsageManager } from "../usage.js";
import type { DatabaseManager } from "../../shared/database.js";
import type { CredentialStore } from "../credential-store.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import { listTemplates } from "../templates.js";
import { ServiceError } from "./types.js";
import type { BootstrapData } from "./types.js";
import { listSessions } from "./session.js";
import { listAgents, getGlobalSettings } from "./settings.js";
import { getGitHubStatus } from "./github.js";
import { listRepos } from "./repos.js";
import { sessionCredentialsRoot } from "../session-credentials.js";

// ---- Read operations ----

/** Get usage stats. */
export function getUsageStats(usageManager: UsageManager) {
  return usageManager.getStats();
}

/** Get all data needed for the initial bootstrap. */
export async function getBootstrapData(deps: {
  sessionManager: SessionManager;
  repoStore?: RepoStore;
  createGitManager: (dir: string) => GitManager;
  agentRegistry: AgentRegistry;
  githubAuthManager: GitHubAuthManager;
  credentialStore?: CredentialStore;
  defaultAgentId: AgentId;
  workspaceDir: string;
}): Promise<BootstrapData> {
  // Each call is wrapped individually so a failure in one (e.g. expired
  // GitHub token causing listUserRepos to throw) doesn't kill the entire
  // bootstrap — the other data still loads.
  const [sessions, settings] = await Promise.all([
    listSessions(deps.sessionManager, deps.createGitManager).catch((err: unknown) => {
      console.error("[bootstrap] Failed to list sessions:", err);
      return [] as Awaited<ReturnType<typeof listSessions>>;
    }),
    getGlobalSettings(deps.agentRegistry, deps.defaultAgentId, deps.workspaceDir, deps.credentialStore).catch((err: unknown) => {
      console.error("[bootstrap] Failed to get global settings:", err);
      return {
        gitIdentity: { name: "", email: "" },
        systemPrompt: "",
        agents: listAgents(deps.agentRegistry),
        defaultAgentId: deps.defaultAgentId,
        maxIdleContainers: deps.credentialStore?.getMaxIdleContainers() ?? 5,
      } as Awaited<ReturnType<typeof getGlobalSettings>>;
    }),
  ]);

  return {
    sessions,
    repos: deps.repoStore ? listRepos(deps.repoStore) : [],
    agents: settings.agents,
    defaultAgentId: deps.defaultAgentId,
    templates: listTemplates(),
    githubStatus: getGitHubStatus(deps.githubAuthManager),
    settings,
  };
}

// ---- Mutation operations ----

/** Full reset — destroys all workspace data. */
export async function fullReset(
  sessionManager: SessionManager,
  usageManager: UsageManager,
  runnerRegistry: SessionRunnerRegistry,
  workspaceDir: string,
  repoStore?: RepoStore,
  databaseManager?: DatabaseManager,
  composeStopPromises?: Map<string, Promise<void>>,
  /**
   * docs/138 — credentials root (e.g. `/credentials`). When provided, every
   * per-session credential subtree under `<credentialsDir>/sessions` is dropped
   * (the user is wiping everything; provisioned agent creds must not survive).
   * The top-level source-of-truth creds (`.claude`, `.codex`, …) are preserved
   * so a full reset doesn't sign the user out.
   */
  credentialsDir?: string,
): Promise<void> {
  // Signal compose-stop to drop named volumes for every active session
  // before we tear them down — full reset is the user saying "wipe
  // everything," so per-session named volumes (node_modules caches, etc.)
  // must not survive.
  for (const sid of runnerRegistry.ids()) {
    const runner = runnerRegistry.get(sid);
    if (runner && "removeVolumesOnDispose" in runner) {
      (runner as { removeVolumesOnDispose: boolean }).removeVolumesOnDispose = true;
    }
  }

  // Dispose all runners. Each runner.dispose() fires its "disposed" event
  // synchronously, which causes `trackComposeStop` to populate
  // `composeStopPromises` with the in-flight `docker compose down
  // --volumes` for that session.
  runnerRegistry.disposeAll();

  // Wait for those compose-downs to finish before we wipe the workspace
  // directory and clear the DB. Without this, a long-running compose-down
  // can still be holding volumes the user expects to be gone, and the
  // subsequent fs.rm of the workspace dir races the compose tool that's
  // also reading it.
  if (composeStopPromises && composeStopPromises.size > 0) {
    await Promise.allSettled([...composeStopPromises.values()]);
  }

  // Clear all database tables first (before deleting the DB file on disk).
  // This keeps the in-memory prepared statements consistent for the remainder
  // of this process's lifetime.
  if (databaseManager) {
    databaseManager.clearAll();
  } else {
    sessionManager.clear();
    usageManager.clear();
    if (repoStore) repoStore.clear();
  }

  // Delete everything inside the workspace directory, but preserve the SQLite
  // database files — clearAll() already emptied all tables and the open connection
  // must remain valid for subsequent operations.
  const preservePatterns = new Set([".shipit.db", ".shipit.db-wal", ".shipit.db-shm"]);
  const entries = await fs.readdir(workspaceDir);
  for (const entry of entries) {
    if (preservePatterns.has(entry)) continue;
    try {
      await fs.rm(path.join(workspaceDir, entry), { recursive: true, force: true });
    } catch {
      // Best-effort
    }
  }

  // docs/138 — drop all per-session credential subtrees. They live under the
  // credentials root (separate from the workspace dir), so the workspace wipe
  // above doesn't touch them. The top-level source-of-truth creds are left in
  // place so a full reset doesn't sign the user out of Claude/Codex.
  if (credentialsDir) {
    try {
      await fs.rm(sessionCredentialsRoot(credentialsDir), { recursive: true, force: true });
    } catch {
      // Best-effort — the disk-janitor sweeps any leftovers on next startup.
    }
  }
}

/** Report a preview error (log broadcast). */
export function validatePreviewError(
  message: string,
  stack?: string,
): { message: string; stack?: string } {
  const errorMsg = typeof message === "string" ? message : "";
  if (!errorMsg.trim()) throw new ServiceError(400, "Preview error message cannot be empty");
  if (errorMsg.length > 10_000) throw new ServiceError(400, "Preview error message too long (max 10,000 characters)");
  const trimmedStack = stack && typeof stack === "string" ? stack.slice(0, 5000) : undefined;
  return { message: errorMsg, stack: trimmedStack };
}
