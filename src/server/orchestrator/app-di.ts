import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../shared/database.js";
import { GitManager } from "../shared/git.js";
import { AgentRegistry, isAllowedAgentEnvKey } from "../shared/agent-registry.js";
import { readInstalledHarnesses } from "../shared/installed-harnesses.js";
import { listConfiguredCredentials } from "./service-routing.js";
import { collectServiceCredentialEnv } from "./secret-resolver.js";
import { RepoGit } from "./repo-git.js";
import { AuthManager } from "./agents/claude/auth-manager.js";
import { CodexAuthManager } from "./agents/codex/auth-manager.js";
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
import { resolveSecretCipher, type SecretCipher } from "./secret-cipher.js";
import { ProviderAccountManager } from "./provider-account-manager.js";
import { initGlobalGitConfig } from "./git-config.js";
import { SessionContainerManager } from "./session-container.js";
import type { SessionRunnerFactory } from "./session-runner.js";
import { PrStatusPoller } from "./pr-status-poller.js";
import type { AgentId, AgentEvent, AgentProcess, RuntimeMode } from "../shared/types.js";
import type { AgentHomeResolver } from "../shared/agent-home.js";
import type { LocalAgentFactory } from "./local-agent-home.js";
import type { GenerateText } from "./non-turn-model.js";

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

/**
 * The production credentials volume. In the orchestrator's own container this
 * is the shared credentials volume; **inside a session container it is that
 * session's live agent home** — the dir holding the running CLI's
 * `.claude/.credentials.json` and its conversation jsonl.
 */
export const LIVE_CREDENTIALS_DIR = "/credentials";

/**
 * Resolve the credentials root, refusing to hand the live volume to a test.
 *
 * `initializeManagers` constructs a {@link ProviderAccountManager}, whose
 * constructor runs a one-shot legacy migration that *moves* `<credentialsDir>/
 * .claude` and `.claude.json` into `provider-accounts/<provider>/<id>/`. That
 * migration is guarded by "no accounts registered yet", which never fires in
 * production but **always** fires against a fresh test database.
 *
 * So a test that passed `workspaceDir: tmpDir` but let `credentialsDir` default
 * was pointing that migration at {@link LIVE_CREDENTIALS_DIR}. When the suite
 * ran inside a ShipIt session container — i.e. every time the agent ran the
 * tests on itself — the migration found the session's real credentials and
 * renamed the agent's home out from under the running CLI. Every subsequent
 * turn failed with "Not logged in · Please run /login", permanently, because
 * nothing moved it back. It tracked *running the suite*, not subject matter,
 * because the smoke tests alone were enough to trigger it.
 *
 * Two rules, both enforced here rather than at ~90 call sites:
 *
 *  - Under test mode an omitted `credentialsDir` gets a fresh temp dir, never
 *    the live volume. Tests that don't care about credentials keep working
 *    untouched; tests that do get a private root.
 *  - Under test mode an *explicit* live path is a hard error. Nothing legitimate
 *    needs it, and it is the one value that destroys the developer's session.
 */
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
  /**
   * Pin the initial agent id used for fresh runners and in-process AI calls.
   * Production omits this — `initializeManagers` derives it from auth state
   * via {@link resolveInitialAgentId}. Tests pin it to keep behavior
   * deterministic.
   */
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
  generateText?: GenerateText;
  /**
   * Unified credential store for git identity, GitHub token, agent API keys.
   * Defaults to `new CredentialStore(credentialsDir)`.
   */
  credentialStore?: CredentialStore;
  /**
   * At-rest encryption for persisted secrets/credentials (docs/220). Defaults
   * to `resolveSecretCipher({ credentialsDir })` — an AES-256-GCM cipher keyed
   * from `SHIPIT_SECRET_KEY`, a key file on the credentials volume, or a freshly
   * generated key. `null` disables encryption (plaintext). Tests that pass their
   * own `credentialStore` are unaffected; pass `null` here to keep the SecretStore
   * plaintext too.
   */
  secretCipher?: SecretCipher | null;
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
  /**
   * docs/170 — override for the `fetch` used to reach issue trackers (Linear
   * GraphQL). Tests inject a stub; production leaves it undefined.
   */
  trackerFetchImpl?: typeof fetch;
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
  /**
   * docs/150 — local mode only: the same factory, but able to scope a spawn's
   * HOME to a provider account. Undefined in containerized mode and whenever a
   * test injects `deps.agentFactory`.
   */
  localAgentFactory: LocalAgentFactory | undefined;
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
  generateText: GenerateText;
  isTestMode: boolean;
  /** Resolved runtime mode (containerized vs local). See {@link RuntimeMode}. */
  runtimeMode: RuntimeMode;
  secretStore: SecretStore;
  reviewStore: FileReviewStore;
  egressAllowlistStore: EgressAllowlistStore;
  presentStore: PresentStore;
}

/**
 * Instantiate all managers and wire DI. Pure manager construction — no
 * server setup, no container orchestration, no route registration.
 */
export async function initializeManagers(deps: AppDeps): Promise<ManagerSet> {
  const {
    workspaceDir = "/workspace",
    serveStatic: shouldServeStatic = true,
    autoPushDebounceMs = 5000,
  } = deps;

  // Resolved up here, not at the return: every manager below that touches
  // credentials (CredentialStore, the secret cipher, the global git config,
  // and above all ProviderAccountManager's destructive legacy migration) is
  // constructed in between. See {@link resolveCredentialsDir}.
  //
  // NOTE: `serveStatic === false` is now load-bearing for CREDENTIAL SAFETY,
  // not just for enabling test-only routes. It is what keeps a test from being
  // handed {@link LIVE_CREDENTIALS_DIR} — i.e. the running agent's own home
  // when the suite executes inside a session container. Every current test
  // reaches this with `serveStatic: false`; a future one that doesn't would
  // silently lose that protection (the in-container guard in
  // `provider-account-manager.ts` still covers it, but that is the second
  // layer, not the first). If this flag ever stops implying "under test",
  // take an explicit signal here rather than widening its meaning.
  const isTestMode = deps.serveStatic === false;
  const credentialsDir = resolveCredentialsDir(deps.credentialsDir, isTestMode);

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
  //
  // docs/150 — the local factory takes a per-spawn HOME resolver so each
  // session's CLI reads the provider account it was routed to. The plain
  // `agentFactory` below keeps its one-argument shape (every existing caller
  // has an agentId and nothing else); the account-scoped wiring goes through
  // `localAgentFactory`, which `buildRunnerFactory` hands to each local
  // runner's `createAgent`.
  const localAgentFactory: LocalAgentFactory | undefined =
    !deps.agentFactory && runtimeMode === "local" ? await buildLocalAgentFactory() : undefined;
  const agentFactory: ((agentId: AgentId) => AgentProcess) | undefined =
    deps.agentFactory ?? (localAgentFactory ? (agentId: AgentId): AgentProcess => localAgentFactory(agentId) : undefined);

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

  // ---- At-rest secret encryption (docs/220) ----
  // Resolve the cipher once and inject it into both stores. `undefined` dep →
  // resolve from env / key-file / auto-generate (encryption on by default in
  // production); explicit `null` → disabled. A malformed/unreadable key throws
  // here, failing the boot loudly rather than silently storing plaintext or
  // wiping data.
  //
  // Test mode is plaintext by default: the integration suite shares stores
  // through the API (round-trips are cipher-agnostic), and auto-generating a key
  // file into the default `/credentials` (often unwritable in CI) would break
  // boot. The cipher's own behavior is covered by dedicated unit tests that
  // inject a real cipher; an integration test can still opt in via
  // `deps.secretCipher`. We gate on `serveStatic === false` (the explicit test
  // signal) OR the vitest runtime (`VITEST`), since not every buildApp test call
  // sets serveStatic. The `NODE_ENV !== "production"` guard on the VITEST clause
  // is defense-in-depth: a stray `VITEST` in a real deployment must never be
  // able to silently flip encryption off (production sets NODE_ENV=production).
  const isUnderTest =
    deps.serveStatic === false ||
    (!!process.env.VITEST && process.env.NODE_ENV !== "production");
  const secretCipher =
    deps.secretCipher === undefined
      ? isUnderTest
        ? null
        : resolveSecretCipher({ credentialsDir })
      : deps.secretCipher;

  // ---- Credential store ----
  const credentialStore =
    deps.credentialStore ?? new CredentialStore(credentialsDir, secretCipher ?? undefined);

  // ---- Provider accounts (docs/150 Phase 1) ----
  const providerAccountManager = deps.providerAccountManager ?? new ProviderAccountManager({
    credentialsDir,
    credentialStore,
  });
  providerAccountManager.migrateDefaultAccounts();

  // ---- Auth manager ----
  const authManager = deps.authManager ?? new AuthManager();
  // Primes the manager's singleton `authenticated` flag. Deliberately NOT the
  // startup log's source: with the req-19 aliases gone the singleton path holds
  // nothing on a migrated install, so it would report "no credentials found"
  // for a user with several accounts connected. Ask the account manager, which
  // is what every routing decision asks.
  authManager.checkCredentials();
  console.log("[server] Claude credentials found:", providerAccountManager.hasAnyAuthForProvider("claude"));

  // ---- Codex auth manager (ChatGPT subscription) ----
  // Wraps `codex login --device-auth` so a user can sign in with their
  // ChatGPT plan instead of an OPENAI_API_KEY. See feature 119.
  const codexAuthManager = deps.codexAuthManager ?? new CodexAuthManager();
  console.log("[server] Codex ChatGPT credentials found:", providerAccountManager.hasAnyAuthForProvider("codex"));

  // ---- Global git config (single source of truth for identity) ----
  // Only initialize if not already configured (tests set this up via createTestCredentialStore).
  if (!process.env.GIT_CONFIG_GLOBAL) {
    initGlobalGitConfig(credentialsDir);
  }

  // Load persisted agent env vars into process.env before agent detection.
  //
  // docs/252 phase 2 — the stored service credentials go in the same way, under
  // their catalogue `storageEnv` names. That is what keeps the existing env
  // probes (`AgentRegistry.isAuthConfigured`, `reservedRouteFor`) answering the
  // same way once a key lives in the credential-route store instead of in
  // `agentEnv`: those read `process.env`, and this is where `process.env` is
  // seeded. Nothing here overwrites a value the deployment set itself.
  const storedEnv = { ...credentialStore.getAllAgentEnv(), ...collectServiceCredentialEnv(credentialStore) };
  for (const [key, value] of Object.entries(storedEnv)) {
    if (isAllowedAgentEnvKey(key) && !process.env[key]) {
      process.env[key] = value;
    }
  }

  // ---- Agent registry ----
  const agentRegistry = deps.agentRegistry ?? new AgentRegistry({
    // docs/252 phase 3 (req 8) — the credential question is now asked per MODEL,
    // over the credentials this install actually holds. Supplying this is what
    // switches the registry off the two per-`AgentId` probes below; they survive
    // as the fallback for a registry with no credential source (a session
    // worker, a unit test), which is the pre-feature behaviour.
    listCredentials: () => listConfiguredCredentials(credentialStore),
    // docs/252 phase 3 — these probes are now translated into an ACCOUNT
    // credential of the harness's own vendor (`probedCredentialsFor`), so they
    // must report only account-shaped evidence. `hasAnyAuthForProvider` is the
    // wrong question here: it also answers true for a bare `ANTHROPIC_API_KEY`
    // or `OPENAI_API_KEY`, which would translate a metered key into a
    // subscription that does not exist — offering a "Subscription" row on a
    // key-only install and failing `auth_required` when it is chosen.
    //
    // Nothing is lost by narrowing: an env-delivered key is already a
    // credential of its own mode through `listConfiguredCredentials`, which
    // reads the same variables. What is left here is the residue that store
    // cannot see — a connected account, and the injected auth manager tests and
    // custom runtimes rely on.
    checkClaudeAuth: () =>
      providerAccountManager.list("anthropic").some((a) => a.status === "ready")
      || (deps.authManager?.authenticated ?? false),
    checkCodexAuth: () => providerAccountManager.list("openai").some((a) => a.status === "ready"),
  });
  await agentRegistry.detect();
  const detectedAgents = agentRegistry.list();
  // docs/252 phase 9 \u2014 say which question was answered. "codex \u2717" means something
  // different depending on whether this deployment chose not to install it or the
  // binary is simply absent from a dev checkout's $PATH.
  const declaredHarnesses = readInstalledHarnesses();
  console.log(
    declaredHarnesses
      ? `[server] Harnesses installed by this deployment: ${declaredHarnesses.join(", ") || "(none)"}`
      : "[server] No harness install report; falling back to $PATH detection",
  );
  const installedStr = detectedAgents.map((a) => `${a.binary} ${a.installed ? "\u2713" : "\u2717"}`).join(", ");
  const authStr = detectedAgents.map((a) => `${a.binary} ${a.authConfigured ? "\u2713" : "\u2717"}`).join(", ");
  console.log(`[server] Agent CLIs detected: ${installedStr}`);
  console.log(`[server] Agent auth status: ${authStr}`);

  // Starting agent id for fresh runners and the in-process `generateText`.
  // NOT a user-facing fallback: every user session pins its own `agentId` at
  // first turn, the home-screen picker derives its own default from the
  // auth-tagged agent list (client-side, in `useServerEvents`), and spawned
  // children inherit the parent's `agentId`. This value only matters for
  // the seconds between runner construction and the first turn pinning the
  // session \u2014 and for the dogfood-only `generateText` helper.
  //
  // docs/252 phase 9 (req 14) \u2014 still prefer Claude Code, but never name a harness
  // this deployment did not install: on a Codex-only install the literal "claude"
  // would seed every fresh runner (and `generateText`) with a CLI that is not
  // there. The final literal is unreachable in practice \u2014 the installer refuses an
  // empty selection \u2014 and is kept so the type is satisfied without a throw here.
  const defaultAgentId: AgentId = deps.defaultAgentId
    ?? detectedAgents.find((a) => a.id === "claude" && a.installed)?.id
    ?? detectedAgents.find((a) => a.installed)?.id
    ?? "claude";

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
  const secretStore = new SecretStore(databaseManager, secretCipher ?? undefined);

  // ---- File review store ----
  const reviewStore = new FileReviewStore(databaseManager);

  // ---- Egress allowlist store (docs/172, planning#92) ----
  // Durable user allowlist + containment toggle, fed into the resolver/proxy
  // composition and the per-session containment gate at container start.
  const egressAllowlistStore = new EgressAllowlistStore(databaseManager);

  // ---- Present store (docs/093) ----
  // Durable Present-tab metadata so presentations survive a session-container
  // restart. Seeds a fresh runner's cache and backs the re-register-on-restart
  // byte-serving path; holds metadata only (bytes stay on disk/git).
  const presentStore = new PresentStore(databaseManager);

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
 *
 * docs/150 — `resolveHome` is how account selection reaches the CLI here.
 * A containerized session gets its account through the per-session credentials
 * mount; local mode has no mount, so the adapter is told which HOME to spawn
 * with instead. It is a path, not credential material: the orchestrator still
 * owns what is written under it. Omitted (tests, sub-agent paths with no
 * session context) ⇒ the process-global `agentHome()`, i.e. today's behavior.
 */
async function buildLocalAgentFactory(): Promise<LocalAgentFactory> {
  const [{ ClaudeAdapter }, { CodexAdapter }] = await Promise.all([
    import("../session/agents/claude/adapter.js"),
    import("../session/agents/codex/adapter.js"),
  ]);
  return (agentId: AgentId, resolveHome?: AgentHomeResolver): AgentProcess => {
    const opts = resolveHome ? { resolveHome } : undefined;
    switch (agentId) {
      case "claude":
        return new ClaudeAdapter(undefined, opts);
      case "codex":
        return new CodexAdapter(undefined, opts);
      default: {
        const _exhaustive: never = agentId;
        throw new Error(`No local agent adapter for agentId: ${_exhaustive as string}`);
      }
    }
  };
}
