import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../shared/database.js";
import { GitManager } from "../shared/git.js";
import { AgentRegistry, isAllowedAgentEnvKey } from "../shared/agent-registry.js";
import { readInstalledHarnesses } from "../shared/installed-harnesses.js";
import { listConfiguredCredentials } from "./service-routing.js";
import { collectServiceCredentialEnv } from "./secret-resolver.js";
import { RepoGit, type GitRemoteCredential } from "./repo-git.js";
import type { GitRemoteCredentialResolver } from "../shared/git-remote-credential.js";
import { gitRemoteCredentialResolver } from "./services/github.js";
import { AuthManager } from "./agents/claude/auth-manager.js";
import { CodexAuthManager } from "./agents/codex/auth-manager.js";
import { XaiAuthManager } from "./agents/grok/auth-manager.js";
import { GitHubAuthManager } from "./github-auth.js";
import { SessionManager } from "./sessions.js";
import { RepoStore } from "./repo-store.js";
import { ChatHistoryManager } from "./chat-history.js";
import { UsageManager } from "./usage.js";
import { SecretStore } from "./secret-store.js";
import { EgressAllowlistStore } from "./egress-allowlist-store.js";
import { FileReviewStore } from "./review-store.js";
import { PresentStore } from "./present-store.js";
import { CredentialStore } from "./credential-store.js";
import { adoptEnvCredentials } from "./adopt-env-credentials.js";
import { resolveSecretCipher, type SecretCipher } from "./secret-cipher.js";
import { ProviderAccountManager } from "./provider-account-manager.js";
import { initGlobalGitConfig, pinGitMessageLocale } from "./git-config.js";
import { configureLfsRemoteCredentialResolver } from "./git-lfs.js";
import { SessionContainerManager } from "./session-container.js";
import type { SessionRunnerFactory } from "./session-runner.js";
import { PrStatusPoller } from "./pr-status-poller.js";
import type { AgentId, AgentEvent, AgentProcess, RuntimeMode } from "../shared/types.js";
import type { AgentHomeResolver } from "../shared/agent-home.js";
import type { LocalAgentFactory } from "./local-agent-home.js";
import type { GenerateText } from "./non-turn-model.js";
import { recordNonTurnUsage, type NonTurnTelemetry } from "./services/non-turn-work.js";

export type { RuntimeMode } from "../shared/types.js";

export const LIVE_CREDENTIALS_DIR = "/credentials";

// Tests must not migrate /credentials: inside a session it is the running agent's home.
export function resolveCredentialsDir(
  credentialsDir: string | undefined,
  isTestMode: boolean,
): string {
  if (!isTestMode) return credentialsDir ?? LIVE_CREDENTIALS_DIR;

  if (credentialsDir === undefined) {
    return fs.mkdtempSync(path.join(os.tmpdir(), "shipit-test-credentials-"));
  }
  if (path.resolve(credentialsDir) === LIVE_CREDENTIALS_DIR) {
    throw new Error(
      `Refusing to use the live credentials volume (${LIVE_CREDENTIALS_DIR}) in test mode: `
        + `ProviderAccountManager's legacy migration would move the running agent's home out `
        + `from under it. Pass a temp dir as credentialsDir, or omit it to get one.`,
    );
  }
  return credentialsDir;
}

export function resolveRuntimeMode(): RuntimeMode {
  const v = process.env.RUNTIME_MODE?.toLowerCase();
  return v === "local" ? "local" : "containerized";
}


export interface AppDeps {
  createGitManager?: (workspaceDir: string) => GitManager;
  createRepoGit?: (repoDir: string, credential?: GitRemoteCredential) => RepoGit;
  sessionManager?: SessionManager;
  authManager?: AuthManager;
  codexAuthManager?: CodexAuthManager;
  xaiAuthManager?: XaiAuthManager;
  githubAuthManager?: GitHubAuthManager;
  chatHistoryManager?: ChatHistoryManager;
  usageManager?: UsageManager;
  agentFactory?: (agentId: AgentId) => AgentProcess;
  defaultAgentId?: AgentId;
  workspaceDir?: string;
  stateDir?: string;
  credentialsDir?: string;
  serveStatic?: boolean;
  generateText?: GenerateText;
  credentialStore?: CredentialStore;
  /** null disables encryption; undefined uses the runtime default. */
  secretCipher?: SecretCipher | null;
  providerAccountManager?: ProviderAccountManager;
  /** Defaults to 0. Post-turn ordering precedes arming; the timer keeps network work off that stack. */
  autoPushDebounceMs?: number;
  agentRegistry?: AgentRegistry;
  runnerFactory?: SessionRunnerFactory;
  sessionContainerManager?: SessionContainerManager;
  databaseManager?: DatabaseManager;
  repoStore?: RepoStore;
  prStatusPoller?: PrStatusPoller;
  runtimeMode?: RuntimeMode;
  mcpOAuthFetchImpl?: typeof fetch;
  trackerFetchImpl?: typeof fetch;
}

export interface ManagerSet {
  defaultAgentId: AgentId;
  workspaceDir: string;
  stateDir: string;
  credentialsDir: string;
  shouldServeStatic: boolean;
  autoPushDebounceMs: number;
  sessionsRoot: string;
  agentFactory: ((agentId: AgentId) => AgentProcess) | undefined;
  localAgentFactory: LocalAgentFactory | undefined;
  createGitManager: (dir: string) => GitManager;
  createRepoGit: (dir: string, credential?: GitRemoteCredential) => RepoGit;
  databaseManager: DatabaseManager;
  sessionManager: SessionManager;
  repoStore: RepoStore;
  chatHistoryManager: ChatHistoryManager;
  usageManager: UsageManager;
  authManager: AuthManager;
  codexAuthManager: CodexAuthManager;
  xaiAuthManager: XaiAuthManager;
  credentialStore: CredentialStore;
  providerAccountManager: ProviderAccountManager;
  agentRegistry: AgentRegistry;
  githubAuthManager: GitHubAuthManager;
  generateText: GenerateText;
  isTestMode: boolean;
  runtimeMode: RuntimeMode;
  secretStore: SecretStore;
  reviewStore: FileReviewStore;
  egressAllowlistStore: EgressAllowlistStore;
  presentStore: PresentStore;
}

export function makeInProcessGenerateText(deps: {
  agentFactory: ((agentId: AgentId) => AgentProcess) | undefined;
  defaultAgentId: AgentId;
  usageManager: UsageManager;
}): GenerateText {
  const { agentFactory, defaultAgentId, usageManager } = deps;
  return (prompt, cwd, opts) => {
    if (!agentFactory) {
      return Promise.resolve("");
    }
    return new Promise<string>((resolve, reject) => {
      const agent = agentFactory(defaultAgentId);
      let text = "";
      let telemetry: NonTurnTelemetry | undefined;
      agent.on("event", (event: AgentEvent) => {
        if (event.type === "agent_assistant") {
          for (const block of event.content) {
            if (block.type === "text") text += block.text;
          }
        }
        if (event.type === "agent_result") {
          telemetry = {
            durationMs: event.durationMs ?? 0,
            ...(event.cost ? { costUsd: event.cost.totalUsd } : {}),
            ...(event.tokens
              ? {
                  inputTokens: event.tokens.input,
                  outputTokens: event.tokens.output,
                  ...(event.tokens.cacheRead !== undefined ? { cacheReadTokens: event.tokens.cacheRead } : {}),
                  ...(event.tokens.cacheWrite !== undefined ? { cacheCreateTokens: event.tokens.cacheWrite } : {}),
                }
              : {}),
          };
        }
      });
      agent.on("done", (exitCode: number) => {
        if (opts?.sessionId && telemetry) {
          recordNonTurnUsage(
            { usageManager },
            {
              sessionId: opts.sessionId,
              harnessId: defaultAgentId,
              purpose: opts.purpose ?? "pr-description",
              telemetry,
            },
          );
        }
        if (exitCode === 0 || text.length > 0) {
          resolve(text);
        } else {
          reject(new Error(`Agent process exited with code ${  exitCode}`));
        }
      });
      agent.on("error", (err: Error) => reject(err));
      agent.run({ prompt, cwd, permissionMode: "auto" });
    });
  };
}

export async function initializeManagers(deps: AppDeps): Promise<ManagerSet> {
  const {
    workspaceDir = "/workspace",
    serveStatic: shouldServeStatic = true,
    autoPushDebounceMs = 0,
  } = deps;

  // Tests must set serveStatic:false to isolate credentials before managers can migrate them.
  const isTestMode = deps.serveStatic === false;
  const credentialsDir = resolveCredentialsDir(deps.credentialsDir, isTestMode);

  const runtimeMode: RuntimeMode = deps.runtimeMode ?? resolveRuntimeMode();

  const envStateDir = process.env.SHIPIT_STATE_DIR;
  const stateDir = deps.stateDir ?? envStateDir ?? workspaceDir;

  const localAgentFactory: LocalAgentFactory | undefined =
    !deps.agentFactory && runtimeMode === "local" ? await buildLocalAgentFactory() : undefined;
  const agentFactory: ((agentId: AgentId) => AgentProcess) | undefined =
    deps.agentFactory ?? (localAgentFactory ? (agentId: AgentId): AgentProcess => localAgentFactory(agentId) : undefined);

  const sessionsRoot = path.join(workspaceDir, "sessions");

  // Populate after GitHub auth initialization without reordering manager construction.
  const remoteCredentialResolver: { resolve?: GitRemoteCredentialResolver } = {};
  const createGitManager = deps.createGitManager
    ?? ((dir: string) => new GitManager(dir, {
      resolveRemoteCredential: async (remote) =>
        (await remoteCredentialResolver.resolve?.(remote)) ?? null,
    }));
  const createRepoGit = deps.createRepoGit
    ?? ((dir: string, credential?: GitRemoteCredential) => new RepoGit(
      dir,
      credential,
      async (remote) => (await remoteCredentialResolver.resolve?.(remote)) ?? null,
    ));

  const databaseManager = deps.databaseManager ?? new DatabaseManager(
    path.join(stateDir, ".shipit.db"),
  );

  const sessionManager = deps.sessionManager ?? new SessionManager(databaseManager);

  const repoStore = deps.repoStore ?? new RepoStore(databaseManager);

  const chatHistoryManager = deps.chatHistoryManager ?? new ChatHistoryManager(databaseManager);

  const usageManager = deps.usageManager ?? new UsageManager(databaseManager);

  const isUnderTest =
    deps.serveStatic === false ||
    (!!process.env.VITEST && process.env.NODE_ENV !== "production");
  const secretCipher =
    deps.secretCipher === undefined
      ? isUnderTest
        ? null
        : resolveSecretCipher({ credentialsDir })
      : deps.secretCipher;

  const credentialStore =
    deps.credentialStore ?? new CredentialStore(credentialsDir, secretCipher ?? undefined);

  // Adopt or suppress env credentials before account migration and agent detection read them.
  const envAdoption = adoptEnvCredentials(credentialStore);
  for (const what of ["adopted", "rotated", "suppressed", "alreadyStored"] as const) {
    const names = envAdoption[what];
    if (names.length > 0) console.log(`[credentials] environment credentials ${what}: ${names.join(", ")}`);
  }

  const providerAccountManager = deps.providerAccountManager ?? new ProviderAccountManager({
    credentialsDir,
    credentialStore,
  });
  providerAccountManager.migrateDefaultAccounts();
  const duplicateClaudeCredentials = providerAccountManager.quarantineDuplicateClaudeCredentials();
  for (const ids of duplicateClaudeCredentials) {
    console.error(
      `[provider-accounts] quarantined Claude accounts with duplicated OAuth credentials: ${ids.join(", ")}; reconnect each account`,
    );
  }

  const authManager = deps.authManager ?? new AuthManager();
  authManager.checkCredentials();
  console.log("[server] Claude credentials found:", providerAccountManager.hasAnyAuthForProvider("claude"));

  const codexAuthManager = deps.codexAuthManager ?? new CodexAuthManager();
  console.log("[server] Codex ChatGPT credentials found:", providerAccountManager.hasAnyAuthForProvider("codex"));

  const xaiAuthManager = deps.xaiAuthManager ?? new XaiAuthManager();
  console.log("[server] xAI subscription credentials found:", providerAccountManager.hasAnyAuthForProvider("grok"));

  if (!process.env.GIT_CONFIG_GLOBAL) {
    initGlobalGitConfig(credentialsDir);
  }
  // Stderr classification needs a fixed locale even with an existing git config.
  pinGitMessageLocale();

  const storedEnv = { ...credentialStore.getAllAgentEnv(), ...collectServiceCredentialEnv(credentialStore) };
  for (const [key, value] of Object.entries(storedEnv)) {
    if (isAllowedAgentEnvKey(key) && !process.env[key]) {
      process.env[key] = value;
    }
  }

  const agentRegistry = deps.agentRegistry ?? new AgentRegistry({
    listCredentials: () => listConfiguredCredentials(credentialStore),
    // These probes imply subscription auth; API keys belong in listCredentials.
    checkClaudeAuth: () =>
      providerAccountManager.list("anthropic").some((a) => a.status === "ready")
      || (deps.authManager?.authenticated ?? false),
    checkCodexAuth: () => providerAccountManager.list("openai").some((a) => a.status === "ready"),
  });
  await agentRegistry.detect();
  const detectedAgents = agentRegistry.list();
  const declaredHarnesses = readInstalledHarnesses();
  console.log(
    declaredHarnesses
      ? `[server] Harnesses installed by this deployment: ${declaredHarnesses.join(", ") || "(none)"}`
      : "[server] No harness install report; falling back to $PATH detection",
  );
  const installedStr = detectedAgents.map((a) => `${a.binary} ${a.installed ? "\u2713" : "\u2717"}`).join(", ");
  const authStr = detectedAgents.map((a) => `${a.binary} ${a.hasRunnableModels ? "\u2713" : "\u2717"}`).join(", ");
  console.log(`[server] Agent CLIs detected: ${installedStr}`);
  console.log(`[server] Agent auth status: ${authStr}`);

  const defaultAgentId: AgentId = deps.defaultAgentId
    ?? detectedAgents.find((a) => a.id === "claude" && a.installed)?.id
    ?? detectedAgents.find((a) => a.installed)?.id
    ?? "claude";

  const githubAuthManager = deps.githubAuthManager ?? new GitHubAuthManager(workspaceDir, credentialStore);
  const hasGitHubToken = githubAuthManager.checkCredentials();
  console.log("[server] GitHub credentials found:", hasGitHubToken);
  remoteCredentialResolver.resolve = gitRemoteCredentialResolver(githubAuthManager);
  configureLfsRemoteCredentialResolver(gitRemoteCredentialResolver(githubAuthManager));
  if (hasGitHubToken && !deps.githubAuthManager) {
    githubAuthManager.loadUserInfo().catch((err: unknown) => {
      console.error("[server] Failed to load GitHub user info:", err);
    });
  }

  const secretStore = new SecretStore(databaseManager, secretCipher ?? undefined);

  const reviewStore = new FileReviewStore(databaseManager);

  const egressAllowlistStore = new EgressAllowlistStore(databaseManager);

  const presentStore = new PresentStore(databaseManager);

  const generateText: GenerateText = deps.generateText
    ?? makeInProcessGenerateText({ agentFactory, defaultAgentId, usageManager });

  return {
    defaultAgentId,
    workspaceDir,
    stateDir,
    credentialsDir,
    shouldServeStatic,
    autoPushDebounceMs,
    sessionsRoot,
    agentFactory,
    localAgentFactory,
    createGitManager,
    createRepoGit,
    databaseManager,
    sessionManager,
    repoStore,
    chatHistoryManager,
    usageManager,
    authManager,
    codexAuthManager,
    xaiAuthManager,
    credentialStore,
    providerAccountManager,
    agentRegistry,
    githubAuthManager,
    secretStore,
    reviewStore,
    egressAllowlistStore,
    presentStore,
    generateText,
    isTestMode,
    runtimeMode,
  };
}

// Load adapters lazily: the production orchestrator image omits session/.
async function buildLocalAgentFactory(): Promise<LocalAgentFactory> {
  const [{ ClaudeAdapter }, { CodexAdapter }, { OpencodeAdapter }, { GrokAdapter }] = await Promise.all([
    import("../session/agents/claude/adapter.js"),
    import("../session/agents/codex/adapter.js"),
    import("../session/agents/opencode/adapter.js"),
    import("../session/agents/grok/adapter.js"),
  ]);
  return (agentId: AgentId, resolveHome?: AgentHomeResolver): AgentProcess => {
    const opts = resolveHome ? { resolveHome } : undefined;
    switch (agentId) {
      case "claude":
        return new ClaudeAdapter(undefined, opts);
      case "codex":
        return new CodexAdapter(undefined, opts);
      case "opencode":
        return new OpencodeAdapter(opts);
      case "grok":
        return new GrokAdapter(opts);
      default: {
        const _exhaustive: never = agentId;
        throw new Error(`No local agent adapter for agentId: ${_exhaustive as string}`);
      }
    }
  };
}
