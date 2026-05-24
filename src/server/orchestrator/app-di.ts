import path from "node:path";
import { DatabaseManager } from "../shared/database.js";
import { GitManager } from "../shared/git.js";
import { AgentRegistry, isAllowedAgentEnvKey } from "../shared/agent-registry.js";
import { RepoGit } from "./repo-git.js";
import { AuthManager } from "./auth.js";
import { CodexAuthManager } from "./codex-auth.js";
import { GitHubAuthManager } from "./github-auth.js";
import { SessionManager } from "./sessions.js";
import { RepoStore } from "./repo-store.js";
import { ChatHistoryManager } from "./chat-history.js";
import { UsageManager } from "./usage.js";
import { SecretStore } from "./secret-store.js";
import { FileReviewStore } from "./review-store.js";
import { CredentialStore } from "./credential-store.js";
import { ProviderAccountManager } from "./provider-account-manager.js";
import { initGlobalGitConfig } from "./git-config.js";
import { SessionContainerManager } from "./session-container.js";
import type { SessionRunnerFactory } from "./session-runner.js";
import { PrStatusPoller } from "./pr-status-poller.js";
import type { AgentId, AgentEvent, AgentProcess, RuntimeMode } from "../shared/types.js";

/**
 * Runtime mode for the orchestrator. Selected via the `RUNTIME_MODE` env var.
 *
 * The type itself lives in `shared/types` (so the React client can reference
 * it without importing orchestrator-only modules) and is re-exported here for
 * back-compat with the many call sites that import it from `app-di`. See the
 * docstring on `RuntimeMode` in `domain-types.ts` and the
 * "isTestMode ≠ runtimeMode === 'local'" note in docs/118.
 */
export type { RuntimeMode } from "../shared/types.js";

/** Read RUNTIME_MODE from process.env, defaulting to "containerized". */
export function resolveRuntimeMode(): RuntimeMode {
  const v = process.env.RUNTIME_MODE?.toLowerCase();
  return v === "local" ? "local" : "containerized";
}

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
   * Factory for creating RepoGit instances (bare cache and clone ops).
   * Defaults to `(dir) => new RepoGit(dir)`.
   */
  createRepoGit?: (repoDir: string) => RepoGit;
  /** Session manager instance. Defaults to `new SessionManager()`. */
  sessionManager?: SessionManager;
  /** Auth manager instance. Defaults to `new AuthManager()`. */
  authManager?: AuthManager;
  /**
   * Codex (ChatGPT subscription) auth manager. Defaults to
   * `new CodexAuthManager()`. Tests can inject a stub that doesn't spawn
   * `codex login --device-auth`. See feature 119.
   */
  codexAuthManager?: CodexAuthManager;
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
  /**
   * Directory for orchestrator-internal state (SQLite database, repo cache,
   * dependency cache). Defaults to `workspaceDir`. In local mode (ShipIt
   * inside ShipIt), set this to a path *outside* the user's source tree so
   * inner-orch metadata doesn't collide with the outer workspace's files.
   * See `SHIPIT_STATE_DIR` env var and feature 118 plan.
   */
  stateDir?: string;
  /** Directory for persistent credentials (survives full reset). Defaults to `/credentials`. */
  credentialsDir?: string;
  /** Whether to serve static files from dist/client. Defaults to true. */
  serveStatic?: boolean;
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
  /** Provider account registry/router (docs/150). */
  providerAccountManager?: ProviderAccountManager;
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
  /**
   * Runtime mode override. When omitted, derived from the `RUNTIME_MODE` env
   * var (defaults to `"containerized"`). Tests can pin the mode explicitly.
   * See {@link RuntimeMode}.
   */
  runtimeMode?: RuntimeMode;
  /**
   * Override the `fetch` implementation used by MCP OAuth code exchange /
   * refresh (docs/088 Phase 2). Tests inject a fake to assert wire-level
   * behavior without touching the network.
   */
  mcpOAuthFetchImpl?: typeof fetch;
}

/** Return type of `initializeManagers()` — all instantiated managers and helpers. */
export interface ManagerSet {
  defaultAgentId: AgentId;
  workspaceDir: string;
  /** Resolved state directory for SQLite db, repo-cache, dep-cache. See {@link AppDeps.stateDir}. */
  stateDir: string;
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
  codexAuthManager: CodexAuthManager;
  credentialStore: CredentialStore;
  providerAccountManager: ProviderAccountManager;
  agentRegistry: AgentRegistry;
  githubAuthManager: GitHubAuthManager;
  generateText: (prompt: string, cwd: string) => Promise<string>;
  isTestMode: boolean;
  /** Resolved runtime mode (containerized vs local). See {@link RuntimeMode}. */
  runtimeMode: RuntimeMode;
  secretStore: SecretStore;
  reviewStore: FileReviewStore;
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

  // ---- Runtime mode ----
  // `containerized` = production (Docker per session). `local` = dogfooding
  // (no Docker; agents spawn in-process). See {@link RuntimeMode} and the
  // "isTestMode ≠ runtimeMode === 'local'" note in the plan.
  const runtimeMode: RuntimeMode = deps.runtimeMode ?? resolveRuntimeMode();

  // ---- State directory (orchestrator-internal files) ----
  // Defaults to the workspace dir for back-compat; in local mode the dev
  // compose service sets SHIPIT_STATE_DIR to a path *outside* the visible
  // workspace (e.g. /workspace/.inner-shipit) so the orchestrator's SQLite
  // db, repo-cache, and dep-cache don't pollute the user's source tree.
  const envStateDir = process.env.SHIPIT_STATE_DIR;
  const stateDir = deps.stateDir ?? envStateDir ?? workspaceDir;

  // Agent factory — in production (containerized) this is undefined because
  // agent processes live inside session containers; the orchestrator never
  // spawns agents directly. In tests it's injected via deps.agentFactory. In
  // local mode (dogfooding) we default to spawning real CLI subprocesses
  // in-process, since there is no container worker to forward to. Local-mode
  // adapters live in session/ — we resolve them via dynamic import so the
  // prod image (which omits session/) never has to load them.
  const agentFactory: ((agentId: AgentId) => AgentProcess) | undefined =
    deps.agentFactory ?? (runtimeMode === "local" ? await buildLocalAgentFactory() : undefined);

  // ---- Per-session directory root ----
  // Inner-session clones still live under the visible workspace (the user
  // edits them via the outer agent); only orchestrator metadata moves to
  // stateDir. See "Workspace path collision" note in the plan.
  const sessionsRoot = path.join(workspaceDir, "sessions");

  // ---- Per-session GitManager factory ----
  const createGitManager = deps.createGitManager ?? ((dir: string) => new GitManager(dir));
  const createRepoGit = deps.createRepoGit ?? ((dir: string) => new RepoGit(dir));

  // ---- Database manager (SQLite) ----
  const databaseManager = deps.databaseManager ?? new DatabaseManager(
    path.join(stateDir, ".shipit.db"),
  );

  // ---- Session manager ----
  const sessionManager = deps.sessionManager ?? new SessionManager(databaseManager);

  // ---- Repo store ----
  const repoStore = deps.repoStore ?? new RepoStore(databaseManager);

  // ---- Chat history manager ----
  const chatHistoryManager = deps.chatHistoryManager ?? new ChatHistoryManager(databaseManager);

  // ---- Usage/cost tracking manager ----
  const usageManager = deps.usageManager ?? new UsageManager(databaseManager);

  // ---- Credential store ----
  const credentialStore = deps.credentialStore ?? new CredentialStore(credentialsDir);

  // ---- Provider accounts (docs/150 Phase 1) ----
  const providerAccountManager = deps.providerAccountManager ?? new ProviderAccountManager({
    credentialsDir,
    credentialStore,
  });
  providerAccountManager.migrateDefaultAccounts();

  // ---- Auth manager ----
  const authManager = deps.authManager ?? new AuthManager();
  const hasCredentials = authManager.checkCredentials();
  console.log("[server] Claude credentials found:", hasCredentials);

  // ---- Codex auth manager (ChatGPT subscription) ----
  // Wraps `codex login --device-auth` so a user can sign in with their
  // ChatGPT plan instead of an OPENAI_API_KEY. See feature 119.
  const codexAuthManager = deps.codexAuthManager ?? new CodexAuthManager();
  const hasCodexAuth = codexAuthManager.checkCredentials();
  console.log("[server] Codex ChatGPT credentials found:", hasCodexAuth);

  // ---- Global git config (single source of truth for identity) ----
  // Only initialize if not already configured (tests set this up via createTestCredentialStore).
  if (!process.env.GIT_CONFIG_GLOBAL) {
    initGlobalGitConfig(credentialsDir);
  }

  // Load persisted agent env vars into process.env before agent detection
  const storedEnv = credentialStore.getAllAgentEnv();
  for (const [key, value] of Object.entries(storedEnv)) {
    if (isAllowedAgentEnvKey(key) && !process.env[key]) {
      process.env[key] = value;
    }
  }

  // ---- Agent registry ----
  const agentRegistry = deps.agentRegistry ?? new AgentRegistry({
    checkClaudeAuth: () => providerAccountManager.hasAnyAuthForProvider("claude"),
    checkCodexAuth: () => providerAccountManager.hasAnyAuthForProvider("codex"),
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

  // ---- Secret store ----
  const secretStore = new SecretStore(databaseManager);

  // ---- File review store ----
  const reviewStore = new FileReviewStore(databaseManager);

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
    stateDir,
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
    codexAuthManager,
    credentialStore,
    providerAccountManager,
    agentRegistry,
    githubAuthManager,
    secretStore,
    reviewStore,
    generateText,
    isTestMode,
    runtimeMode,
  };
}

/**
 * Build the local-mode agent factory — spawns real agent CLI subprocesses
 * (claude, codex) in-process via their adapters. In production (containerized)
 * the worker process inside the session container does this; in local mode
 * there is no worker, so the orchestrator is the parent of every agent
 * subprocess.
 *
 * The adapter modules live in session/ and are loaded lazily via dynamic
 * import so the prod image (which omits session/ to preserve the
 * orchestrator/session boundary) never has to resolve them. Only the dev
 * image — used for the dogfooding `RUNTIME_MODE=local` path — actually loads
 * these.
 */
async function buildLocalAgentFactory(): Promise<(agentId: AgentId) => AgentProcess> {
  const [{ ClaudeAdapter }, { CodexAdapter }] = await Promise.all([
    import("../session/agents/claude-adapter.js"),
    import("../session/agents/codex-adapter.js"),
  ]);
  return (agentId: AgentId): AgentProcess => {
    switch (agentId) {
      case "claude":
        return new ClaudeAdapter();
      case "codex":
        return new CodexAdapter();
      default: {
        const _exhaustive: never = agentId;
        throw new Error(`No local agent adapter for agentId: ${_exhaustive as string}`);
      }
    }
  };
}
