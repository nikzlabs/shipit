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
import type { CredentialStore } from "../credential-store.js";
import { FeatureManager } from "../features.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import { listTemplates } from "../templates.js";
import { ServiceError } from "./types.js";
import type { BootstrapData } from "./types.js";
import { listSessions } from "./session.js";
import { listAgents, getGlobalSettings } from "./settings.js";
import { getGitHubStatus } from "./github.js";
import { listRepos } from "./repos.js";

// ---- Read operations ----

/** Get usage stats. */
export function getUsageStats(usageManager: UsageManager) {
  return usageManager.getStats();
}

/** List features by scanning the docs/ directory in the given workspace. */
export async function listFeatures(workspaceDir: string) {
  const fm = new FeatureManager(workspaceDir);
  return fm.list();
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
    listSessions(deps.sessionManager, deps.createGitManager).catch((err) => {
      console.error("[bootstrap] Failed to list sessions:", err);
      return [] as Awaited<ReturnType<typeof listSessions>>;
    }),
    getGlobalSettings(deps.agentRegistry, deps.defaultAgentId, deps.workspaceDir, deps.credentialStore).catch((err) => {
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
): Promise<void> {
  // Dispose all runners
  runnerRegistry.disposeAll();

  // Delete everything inside the workspace directory
  const entries = await fs.readdir(workspaceDir);
  for (const entry of entries) {
    try {
      await fs.rm(path.join(workspaceDir, entry), { recursive: true, force: true });
    } catch {
      // Best-effort
    }
  }

  // Clear in-memory state
  sessionManager.clear();
  usageManager.clear();
  if (repoStore) repoStore.clear();
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
