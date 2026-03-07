import path from "node:path";
import { DatabaseManager } from "../shared/database.js";
import { GitManager } from "../shared/git.js";
import { AgentRegistry, ALLOWED_ENV_KEYS } from "../shared/agent-registry.js";
import { RepoGit } from "./repo-git.js";
import { AuthManager } from "./auth.js";
import { GitHubAuthManager } from "./github-auth.js";
import { SessionManager } from "./sessions.js";
import { RepoStore } from "./repo-store.js";
import { ChatHistoryManager } from "./chat-history.js";
import { UsageManager } from "./usage.js";
import { FeatureManager } from "./features.js";
import { DeploymentManager } from "./deployment-manager.js";
import { DeploymentStore } from "./deployment-store.js";
import { SecretStore } from "./secret-store.js";
import { CredentialStore } from "./credential-store.js";
import { initGlobalGitConfig } from "./git-config.js";
import { VercelTarget } from "./deploy-targets/vercel.js";
import { CloudflareTarget } from "./deploy-targets/cloudflare.js";
import { SessionContainerManager } from "./session-container.js";
import type { SessionRunnerFactory } from "./session-runner.js";
import { PrStatusPoller } from "./pr-status-poller.js";
import type { AgentId, AgentEvent, AgentProcess } from "../shared/types.js";

/**
 * Dependencies that can be injected for testing. Every field is optional —
 * production uses real implementations, tests can supply mocks/stubs.
 */
export interface AppDeps {
  /**
   * Factory for creating per-session GitManager instances. Each session gets
   * its own git repo; this factory creates a GitManager for a given directory.
   * Defaults to `(dir) => new GitManager(dir)`.
   */
  createGitManager?: (workspaceDir: string) => GitManager;
  /**
   * Factory for creating RepoGit instances (shared-repo and worktree ops).
   * Defaults to `(dir) => new RepoGit(dir)`.
   */
  createRepoGit?: (repoDir: string) => RepoGit;
  /** Session manager instance. Defaults to `new SessionManager()`. */
  sessionManager?: SessionManager;
  /** Auth manager instance. Defaults to `new AuthManager()`. */
  authManager?: AuthManager;
  /** GitHub auth manager instance. Defaults to `new GitHubAuthManager()`. */
  githubAuthManager?: GitHubAuthManager;
  /** Chat history manager instance. Defaults to `new ChatHistoryManager()`. */
  chatHistoryManager?: ChatHistoryManager;
  /** Usage/cost tracking manager instance. Defaults to `new UsageManager()`. */
  usageManager?: UsageManager;
  /**
   * Factory for creating AgentProcess instances by agent ID.
   * Required for integration tests (inject FakeClaudeProcess / FakeCodexProcess).
   * In production, agent processes live inside session containers — the
   * orchestrator never spawns agents directly.
   */
  agentFactory?: (agentId: AgentId) => AgentProcess;
  /** Default agent ID for new sessions. Defaults to "claude". */
  defaultAgentId?: AgentId;
  /** Root workspace directory. Defaults to `/workspace`. */
  workspaceDir?: string;
  /** Directory for persistent credentials (survives full reset). Defaults to `/credentials`. */
  credentialsDir?: string;
  /** Whether to serve static files from dist/client. Defaults to true. */
  serveStatic?: boolean;
  /**
   * Deployment manager instance. Defaults to a new manager with Vercel and
   * Cloudflare targets registered.
   */
  deploymentManager?: DeploymentManager;
  /**
   * Deployment store instance. Defaults to `new DeploymentStore(workspaceDir)`.
   */
  deploymentStore?: DeploymentStore;
  /**
   * Feature manager instance. Defaults to `new FeatureManager(workspaceDir)`.
   * Scans docs/ for feature directories and parses status from frontmatter.
   */
  featureManager?: FeatureManager;
  /**
   * Text generation function for AI-powered features (e.g., PR description).
   * Spawns a short-lived Claude process, collects text output, and returns it.
   * Inject a stub in tests.
   */
  generateText?: (prompt: string, cwd: string) => Promise<string>;
  /**
   * Unified credential store for git identity, GitHub token, agent API keys.
   * Defaults to `new CredentialStore(credentialsDir)`.
   */
  credentialStore?: CredentialStore;
  /**
   * Debounce delay in milliseconds for auto-push after commit.
   * Defaults to 5000 (5 seconds). Set lower in tests to avoid long waits.
   */
  autoPushDebounceMs?: number;
  /**
   * Agent registry instance. Defaults to a new `AgentRegistry()` with
   * auto-detection at startup.
   */
  agentRegistry?: AgentRegistry;
  /**
   * Custom runner factory for the session runner registry. When provided,
   * the registry uses this to create runners instead of the default.
   * Used to inject ContainerSessionRunner for Docker mode.
   */
  runnerFactory?: SessionRunnerFactory;
  /**
   * Pre-configured SessionContainerManager instance. When provided, skips
   * Docker auto-detection and network setup. Useful for testing.
   */
  sessionContainerManager?: SessionContainerManager;
  /** Database manager instance. Defaults to `new DatabaseManager(workspaceDir/.shipit.db)`. */
  databaseManager?: DatabaseManager;
  /** Repo store instance. Defaults to `new RepoStore()`. */
  repoStore?: RepoStore;
  /**
   * Pre-configured PrStatusPoller instance. When provided, the internally created
   * one is replaced. Useful for testing auto-fix flows.
   */
  prStatusPoller?: PrStatusPoller;
}

/** Return type of `initializeManagers()` — all instantiated managers and helpers. */
export interface ManagerSet {
  defaultAgentId: AgentId;
  workspaceDir: string;
  credentialsDir: string;
  shouldServeStatic: boolean;
  autoPushDebounceMs: number;
  sessionsRoot: string;
  agentFactory: ((agentId: AgentId) => AgentProcess) | undefined;
  createGitManager: (dir: string) => GitManager;
  createRepoGit: (dir: string) => RepoGit;
  databaseManager: DatabaseManager;
  sessionManager: SessionManager;
  repoStore: RepoStore;
  chatHistoryManager: ChatHistoryManager;
  usageManager: UsageManager;
  authManager: AuthManager;
  credentialStore: CredentialStore;
  agentRegistry: AgentRegistry;
  githubAuthManager: GitHubAuthManager;
  deploymentManager: DeploymentManager;
  deploymentStore: DeploymentStore;
  featureManager: FeatureManager;
  generateText: (prompt: string, cwd: string) => Promise<string>;
  isTestMode: boolean;
  secretStore: SecretStore;
}

/**
 * Instantiate all managers and wire DI. Pure manager construction — no
 * server setup, no container orchestration, no route registration.
 */
export async function initializeManagers(deps: AppDeps): Promise<ManagerSet> {
  const {
    defaultAgentId = "claude" as AgentId,
    workspaceDir = "/workspace",
    credentialsDir = "/credentials",
    serveStatic: shouldServeStatic = true,
    autoPushDebounceMs = 5000,
  } = deps;

  // Agent factory — only available in tests (injected via deps.agentFactory).
  // In production, agent processes live inside session containers; the
  // orchestrator never spawns agents directly. The ctx.agentFactory delegates
  // to runner.createAgent() which creates a proxy to the container worker.
  const agentFactory: ((agentId: AgentId) => AgentProcess) | undefined = deps.agentFactory;

  // ---- Per-session directory root ----
  const sessionsRoot = path.join(workspaceDir, "sessions");

  // ---- Per-session GitManager factory ----
  const createGitManager = deps.createGitManager ?? ((dir: string) => new GitManager(dir));
  const createRepoGit = deps.createRepoGit ?? ((dir: string) => new RepoGit(dir));

  // ---- Database manager (SQLite) ----
  const databaseManager = deps.databaseManager ?? new DatabaseManager(
    path.join(workspaceDir, ".shipit.db"),
  );

  // ---- Session manager ----
  const sessionManager = deps.sessionManager ?? new SessionManager(databaseManager);

  // ---- Repo store ----
  const repoStore = deps.repoStore ?? new RepoStore(databaseManager);

  // ---- Chat history manager ----
  const chatHistoryManager = deps.chatHistoryManager ?? new ChatHistoryManager(databaseManager);

  // ---- Usage/cost tracking manager ----
  const usageManager = deps.usageManager ?? new UsageManager(databaseManager);

  // ---- Auth manager ----
  const authManager = deps.authManager ?? new AuthManager();
  const hasCredentials = authManager.checkCredentials();
  console.log("[server] Claude credentials found:", hasCredentials);

  // ---- Credential store ----
  const credentialStore = deps.credentialStore ?? new CredentialStore(credentialsDir);

  // ---- Global git config (single source of truth for identity) ----
  // Only initialize if not already configured (tests set this up via createTestCredentialStore).
  if (!process.env.GIT_CONFIG_GLOBAL) {
    initGlobalGitConfig(credentialsDir);
  }

  // Load persisted agent env vars into process.env before agent detection
  const storedEnv = credentialStore.getAllAgentEnv();
  for (const [key, value] of Object.entries(storedEnv)) {
    if (ALLOWED_ENV_KEYS.has(key) && !process.env[key]) {
      process.env[key] = value;
    }
  }

  // ---- Agent registry ----
  const agentRegistry = deps.agentRegistry ?? new AgentRegistry({
    checkClaudeAuth: () => authManager.checkCredentials(),
  });
  await agentRegistry.detect();
  const detectedAgents = agentRegistry.list();
  const installedStr = detectedAgents.map((a) => `${a.binary} ${a.installed ? "\u2713" : "\u2717"}`).join(", ");
  const authStr = detectedAgents.map((a) => `${a.binary} ${a.authConfigured ? "\u2713" : "\u2717"}`).join(", ");
  console.log(`[server] Agent CLIs detected: ${installedStr}`);
  console.log(`[server] Agent auth status: ${authStr}`);

  // ---- GitHub auth manager ----
  const githubAuthManager = deps.githubAuthManager ?? new GitHubAuthManager(workspaceDir, credentialStore);
  const hasGitHubToken = githubAuthManager.checkCredentials();
  console.log("[server] GitHub credentials found:", hasGitHubToken);
  if (hasGitHubToken && !deps.githubAuthManager) {
    // Load user info and configure git credentials in the background
    githubAuthManager.loadUserInfo().catch((err: unknown) => {
      console.error("[server] Failed to load GitHub user info:", err);
    });
  }

  // ---- Deployment manager ----
  const deploymentManager = deps.deploymentManager ?? (() => {
    const mgr = new DeploymentManager();
    mgr.register(new VercelTarget());
    mgr.register(new CloudflareTarget());
    return mgr;
  })();

  // ---- Deployment store ----
  const deploymentStore = deps.deploymentStore ?? new DeploymentStore(databaseManager);

  // ---- Secret store ----
  const secretStore = new SecretStore(databaseManager);

  // ---- Feature manager ----
  const featureManager = deps.featureManager ?? new FeatureManager(workspaceDir);

  // ---- Text generation (AI-powered features) ----
  // Tests inject a stub. In production, agentFactory is unavailable (agents
  // live inside session containers), so the default uses agentFactory only
  // when provided, otherwise returns empty string (feature gracefully degrades).
  const generateText = deps.generateText ?? ((prompt: string, cwd: string): Promise<string> => {
    if (!agentFactory) {
      // No in-process agent available — return empty to degrade gracefully.
      return Promise.resolve("");
    }
    return new Promise((resolve, reject) => {
      const agent = agentFactory(defaultAgentId);
      let text = "";
      agent.on("event", (event: AgentEvent) => {
        if (event.type === "agent_assistant") {
          for (const block of event.content) {
            if (block.type === "text") text += block.text;
          }
        }
      });
      agent.on("done", (exitCode: number) => {
        if (exitCode === 0 || text.length > 0) {
          resolve(text);
        } else {
          reject(new Error(`Agent process exited with code ${  exitCode}`));
        }
      });
      agent.on("error", (err: Error) => reject(err));
      agent.run({ prompt, cwd, permissionMode: "auto" });
    });
  });

  const isTestMode = deps.serveStatic === false;

  return {
    defaultAgentId,
    workspaceDir,
    credentialsDir,
    shouldServeStatic,
    autoPushDebounceMs,
    sessionsRoot,
    agentFactory,
    createGitManager,
    createRepoGit,
    databaseManager,
    sessionManager,
    repoStore,
    chatHistoryManager,
    usageManager,
    authManager,
    credentialStore,
    agentRegistry,
    githubAuthManager,
    deploymentManager,
    deploymentStore,
    secretStore,
    featureManager,
    generateText,
    isTestMode,
  };
}
