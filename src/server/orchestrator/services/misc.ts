import path from "node:path";
import fs from "node:fs/promises";
import type { SessionManager } from "../sessions.js";
import type { RepoStore } from "../repo-store.js";
import type { GitManager } from "../../shared/git.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { UsageManager } from "../usage.js";
import type { DatabaseManager } from "../../shared/database.js";
import type { CredentialStore } from "../credential-store.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import { listTemplates } from "../templates.js";
import { ServiceError } from "./types.js";
import type { BootstrapData, GlobalSettings } from "./types.js";
import type { RuntimeMode } from "../../shared/types.js";
import { listSessions } from "./session.js";
import { resolveHarnessOnboarding, listAgents, getGlobalSettings } from "./settings.js";
import { getGitHubStatus } from "./github.js";
import { listRepos } from "./repos.js";
import { sessionCredentialsRoot } from "../session-credentials.js";

export function getUsageStats(usageManager: UsageManager) {
  return usageManager.getStats();
}

// Read per request so a changed tailnet address does not require an orchestrator restart.
async function readTailnetPreviewHost(): Promise<string | undefined> {
  const file =
    process.env.SHIPIT_TAILNET_PREVIEW_HOST_FILE ?? "/opt/shipit/.tailnet-preview-host";
  try {
    const raw = await fs.readFile(file, "utf8");
    const host = raw.split("\n")[0]?.trim() ?? "";
    // Restrict preview destinations to the forwarder's sslip.io form.
    if (/^\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}\.sslip\.io(:\d{1,5})?$/.test(host)) return host;
  } catch {
    // No override when absent or unreadable.
  }
  return undefined;
}

export async function getBootstrapData(deps: {
  sessionManager: SessionManager;
  repoStore?: RepoStore;
  createGitManager: (dir: string) => GitManager;
  agentRegistry: AgentRegistry;
  githubAuthManager: GitHubAuthManager;
  credentialStore?: CredentialStore;
  providerAccountManager?: ProviderAccountManager;
  workspaceDir: string;
  runtimeMode?: RuntimeMode;
}): Promise<BootstrapData> {
  const [sessions, settings, tailnetPreviewHost] = await Promise.all([
    listSessions(deps.sessionManager, deps.createGitManager).catch((err: unknown) => {
      console.error("[bootstrap] Failed to list sessions:", err);
      return [] as Awaited<ReturnType<typeof listSessions>>;
    }),
    getGlobalSettings(deps.agentRegistry, deps.workspaceDir, deps.credentialStore, deps.providerAccountManager).catch((err: unknown): GlobalSettings => {
      console.error("[bootstrap] Failed to get global settings:", err);
      return {
        // Settings failure must not disable a runnable agent or repeat onboarding.
        ...resolveHarnessOnboarding(deps.agentRegistry, deps.credentialStore),
        gitIdentity: { name: "", email: "" },
        systemPrompt: "",
        agents: listAgents(deps.agentRegistry),
        failoverCutoffs: {},
        accountSelectionMode: {},
        memoryBudgetMb: deps.credentialStore?.getMemoryBudgetMb() ?? null,
        agentSystemInstructionsEnabled: true,
        agentSystemInstructions: "",
        autoCreatePr: false,
        liveSteering: true,
        autoResolveConflicts: false,
        autoFixCi: false,
        autoResetMergedBranch: true,
        enableSubAgents: true,
        voiceDeliveryMode: "native",
        voiceWebhookConfigured: false,
        providerAccounts: [],
        credentialRoutes: [],
        reviewers: [
          { slot: "first", source: "auto", unavailableReason: "nothing_eligible" },
          { slot: "second", source: "auto", unavailableReason: "nothing_eligible" },
        ],
        // The reserved reviewer exists independently of stored user roles.
        roles: [{ name: "reviewer", params: { kind: "auto" }, reserved: true }],
      };
    }),
    readTailnetPreviewHost(),
  ]);

  return {
    sessions,
    repos: deps.repoStore ? listRepos(deps.repoStore) : [],
    agents: settings.agents,
    templates: listTemplates(),
    githubStatus: getGitHubStatus(deps.githubAuthManager),
    settings,
    runtimeMode: deps.runtimeMode ?? "containerized",
    ...(tailnetPreviewHost ? { tailnetPreviewHost } : {}),
  };
}

export async function fullReset(
  sessionManager: SessionManager,
  usageManager: UsageManager,
  runnerRegistry: SessionRunnerRegistry,
  workspaceDir: string,
  repoStore?: RepoStore,
  databaseManager?: DatabaseManager,
  composeStopPromises?: Map<string, Promise<void>>,
  credentialsDir?: string,
): Promise<void> {
  for (const sid of runnerRegistry.ids()) {
    const runner = runnerRegistry.get(sid);
    if (runner && "removeVolumesOnDispose" in runner) {
      (runner as { removeVolumesOnDispose: boolean }).removeVolumesOnDispose = true;
    }
  }

  // Disposal synchronously registers compose-stop promises.
  runnerRegistry.disposeAll();

  // Compose still reads workspace files while stopping; wait before deleting them.
  if (composeStopPromises && composeStopPromises.size > 0) {
    await Promise.allSettled([...composeStopPromises.values()]);
  }

  if (databaseManager) {
    databaseManager.clearAll();
  } else {
    sessionManager.clear();
    usageManager.clear();
    if (repoStore) repoStore.clear();
  }

  // Keep the emptied database files so the open SQLite connection remains valid.
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

  // Remove session copies outside the workspace, preserving the user's source credentials.
  if (credentialsDir) {
    try {
      await fs.rm(sessionCredentialsRoot(credentialsDir), { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}

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
