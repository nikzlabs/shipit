import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { GitManager } from "../shared/git.js";
import { AgentRegistry, ALLOWED_ENV_KEYS } from "../shared/agent-registry.js";
import { RepoGit } from "./repo-git.js";
import { AuthManager } from "./auth.js";
import { GitHubAuthManager } from "./github-auth.js";
import { SessionManager } from "./sessions.js";
import { ChatHistoryManager } from "./chat-history.js";
import { UsageManager } from "./usage.js";
import { FeatureManager } from "./features.js";
import { ThreadManager } from "./threads.js";
import { DeploymentManager } from "./deployment-manager.js";
import { DeploymentStore } from "./deployment-store.js";
import { CredentialStore } from "./credential-store.js";
import { initGlobalGitConfig, getGitIdentity } from "./git-config.js";
import { VercelTarget } from "./deploy-targets/vercel.js";
import { CloudflareTarget } from "./deploy-targets/cloudflare.js";
import { SessionRunnerRegistry } from "./session-runner.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import { SessionContainerManager } from "./session-container.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import { registerPreviewProxy } from "./preview-proxy.js";
import type { AgentId, AgentEvent, AgentProcess } from "../shared/types.js";
import type { WsClientMessage, WsServerMessage, WsLogEntry } from "../shared/types.js";
import { getErrorMessage } from "./validation.js";
import type { HandlerContext } from "./ws-handlers/types.js";
import * as terminalHandlers from "./ws-handlers/terminal-handlers.js";
import * as miscHandlers from "./ws-handlers/misc-handlers.js";
import * as deployHandlers from "./ws-handlers/deploy-handlers.js";
import * as sessionHandlers from "./ws-handlers/session-handlers.js";
import * as threadHandlers from "./ws-handlers/thread-handlers.js";
import * as sendMessageHandlers from "./ws-handlers/send-message.js";
import { registerApiRoutes } from "./api-routes.js";
export { getContextWindowSize } from "./ws-handlers/send-message.js";

const WORKSPACE = "/workspace";

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
   * Thread manager instance. Defaults to `new ThreadManager()`.
   * Manages conversation threads and checkpoints.
   */
  threadManager?: ThreadManager;
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
  generateText?: (prompt: string, cwd?: string) => Promise<string>;
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
  runnerFactory?: import("./session-runner.js").SessionRunnerFactory;
  /**
   * Pre-configured SessionContainerManager instance. When provided, skips
   * Docker auto-detection and network setup. Useful for testing.
   */
  sessionContainerManager?: import("./session-container.js").SessionContainerManager;
}

/**
 * Build and configure the Fastify app with all routes and WebSocket handlers.
 * Returns the app instance without starting it — call `app.listen()` separately.
 *
 * This separation enables integration testing: tests can call `buildApp({ ... })`
 * with mock dependencies, then use `app.inject()` or connect WebSocket clients
 * to the app without spawning real child processes.
 */
export async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  const {
    defaultAgentId = "claude" as AgentId,
    workspaceDir = WORKSPACE,
    credentialsDir = "/credentials",
    serveStatic: shouldServeStatic = true,
    autoPushDebounceMs = 5000,
  } = deps;

  // Agent factory — only available in tests (injected via deps.agentFactory).
  // In production, agent processes live inside session containers; the
  // orchestrator never spawns agents directly. The ctx.agentFactory delegates
  // to runner.createAgent() which creates a proxy to the container worker.
  const agentFactory: ((agentId: AgentId) => AgentProcess) | undefined = deps.agentFactory;

  const app = Fastify({ logger: false });

  await app.register(fastifyWebsocket);

  // ---- Per-session directory root ----
  const sessionsRoot = path.join(workspaceDir, "sessions");

  // ---- Per-session GitManager factory ----
  const createGitManager = deps.createGitManager ?? ((dir: string) => new GitManager(dir));
  const createRepoGit = deps.createRepoGit ?? ((dir: string) => new RepoGit(dir));

  // ---- Session manager ----
  const sessionManager = deps.sessionManager ?? new SessionManager();

  // ---- Chat history manager ----
  const chatHistoryManager = deps.chatHistoryManager ?? new ChatHistoryManager();

  // ---- Usage/cost tracking manager ----
  const usageManager = deps.usageManager ?? new UsageManager(
    path.join(workspaceDir, ".shipit-usage.json")
  );

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
    githubAuthManager.loadUserInfo().catch((err) => {
      console.error("[server] Failed to load GitHub user info:", err);
    });
  }

  // ---- Thread manager ----
  const threadManager = deps.threadManager ?? new ThreadManager(
    path.join(workspaceDir, ".vibe-threads")
  );

  // ---- Deployment manager ----
  const deploymentManager = deps.deploymentManager ?? (() => {
    const mgr = new DeploymentManager();
    mgr.register(new VercelTarget());
    mgr.register(new CloudflareTarget());
    return mgr;
  })();

  // ---- Deployment store ----
  const deploymentStore = deps.deploymentStore ?? new DeploymentStore(workspaceDir);

  // ---- Feature manager ----
  const featureManager = deps.featureManager ?? new FeatureManager(workspaceDir);

  // ---- Text generation (AI-powered features) ----
  // Tests inject a stub. In production, agentFactory is unavailable (agents
  // live inside session containers), so the default uses agentFactory only
  // when provided, otherwise returns empty string (feature gracefully degrades).
  const generateText = deps.generateText ?? ((prompt: string, cwd?: string): Promise<string> => {
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
          reject(new Error("Agent process exited with code " + exitCode));
        }
      });
      agent.on("error", (err: Error) => reject(err));
      agent.run({ prompt, cwd, permissionMode: "auto" });
    });
  });

  // ---- Container manager (Docker isolation) ----
  // In production (serveStatic !== false), every session gets a Docker container.
  // Tests set serveStatic: false and inject stubs, so Docker is not required.
  const isTestMode = deps.serveStatic === false;
  let containerManager: SessionContainerManager | null = null;
  if (deps.sessionContainerManager) {
    containerManager = deps.sessionContainerManager;
  } else if (!isTestMode && !deps.runnerFactory) {
    // Production mode: Docker is required
    containerManager = new SessionContainerManager({
      workspaceVolume: process.env.WORKSPACE_VOLUME,
      credentialsVolume: process.env.CREDENTIALS_VOLUME,
      stackName: process.env.DOCKER_STACK,
    });
    const dockerAvailable = await containerManager.isAvailable();
    if (dockerAvailable) {
      await containerManager.ensureNetwork();
      const activeIds = new Set(sessionManager.list().map((s) => s.id));
      const orphans = await containerManager.cleanupOrphans(activeIds);
      if (orphans > 0) console.log(`[server] Cleaned up ${orphans} orphan container(s)`);
      await containerManager.startHealthMonitor();
      console.log("[server] Docker container mode enabled");
    } else {
      throw new Error("Docker is not available (is /var/run/docker.sock mounted?)");
    }
  }

  // ---- Session runner registry (app-level, shared across connections) ----
  // In production, the factory creates ContainerSessionRunner instances that
  // talk to per-session Docker containers via HTTP+SSE. Tests inject a custom
  // factory or claudeFactory (using in-process SessionRunner via registry default).
  const effectiveRunnerFactory: import("./session-runner.js").SessionRunnerFactory | undefined =
    deps.runnerFactory ?? (containerManager ? ((o: Parameters<import("./session-runner.js").SessionRunnerFactory>[0]) => {
      const mgr = containerManager!;
      const config = mgr.buildConfig({
        sessionId: o.sessionId,
        sessionDir: o.sessionDir,
        credentialsDir,
        sharedRepoDir: o.sharedRepoDir,
      });
      const runner = new ContainerSessionRunner({
        sessionId: o.sessionId,
        sessionDir: o.sessionDir,
        defaultAgentId: o.defaultAgentId,
        workerUrl: "http://0.0.0.0:0", // placeholder — updated after container starts
        idleTimeoutMs: o.idleTimeoutMs,
      });

      console.log(`[container] Creating container for session ${o.sessionId}...`);
      mgr.create(config).then((sc) => {
        console.log(`[container] Container ready for ${o.sessionId} at ${sc.workerUrl}`);
        runner.setWorkerUrl(sc.workerUrl);
      }).catch((err) => {
        console.error(`[container] Failed to start container for ${o.sessionId}:`, getErrorMessage(err));
        runner.dispose();
      });

      return runner;
    }) : undefined);

  const runnerRegistry = new SessionRunnerRegistry({
    ...(effectiveRunnerFactory ? { runnerFactory: effectiveRunnerFactory } : {}),
    sharedRepoDirResolver: (sessionId: string) => {
      const session = sessionManager.get(sessionId);
      if (session?.remoteUrl && session?.sessionType === "worktree") {
        return getSharedRepoDir(session.remoteUrl);
      }
      return undefined;
    },
  });

  // Track connected WebSocket clients so we can broadcast
  const clients = new Set<{ readyState: number; send: (data: string) => void }>();

  const broadcast = (msg: WsServerMessage) => {
    const payload = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  };

  // ---- Terminal/logs buffer ----
  const MAX_LOG_ENTRIES = 500;
  let logBuffer: WsLogEntry[] = [];

  const broadcastLog = (source: WsLogEntry["source"], text: string) => {
    const entry: WsLogEntry = {
      type: "log_entry",
      source,
      text,
      timestamp: new Date().toISOString(),
    };
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) {
      logBuffer = logBuffer.slice(-MAX_LOG_ENTRIES);
    }
    broadcast(entry);
  };

  // ---- Deployment event handlers ----
  deploymentManager.on("log", ({ text }: { text: string }) => {
    broadcastLog("deploy", text);
  });

  deploymentManager.on("status", (status: { phase: string }) => {
    broadcast({ type: "deploy_status", phase: status.phase as "building" | "deploying" | "complete" | "error" });
  });

  deploymentManager.on("error", (err: { message: string; phase: string }) => {
    broadcast({ type: "deploy_error", message: err.message, phase: err.phase as "building" | "deploying" });
  });


  // ---- Auth event handlers ----
  authManager.on("auth_url", (url: string) => {
    broadcast({ type: "auth_required", url });
  });

  authManager.on("auth_complete", () => {
    agentRegistry.refreshAuth("claude");
    broadcast({ type: "auth_complete" });
    const agents = agentRegistry.list().map((a) => ({
      id: a.id, name: a.name, installed: a.installed,
      authConfigured: a.authConfigured, models: a.capabilities.models,
    }));
    broadcast({ type: "agent_list", agents, defaultAgentId });
  });

  authManager.on("auth_failed", () => {
    console.log("[auth] OAuth flow failed — client should provide API key");
  });

  /**
   * Create a new isolated session directory with its own git repo.
   * Returns the app-generated session ID and workspace directory path.
   */
  const createSessionDir = async (
    title: string,
    opts?: { skipGitInit?: boolean },
  ): Promise<{ appSessionId: string; sessionDir: string }> => {
    const appSessionId = crypto.randomUUID();
    const sessionDir = path.join(sessionsRoot, appSessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    if (!opts?.skipGitInit) {
      // Initialize a fresh git repo for this session.
      // Identity is inherited from global git config (GIT_CONFIG_GLOBAL).
      // The UI blocks until the user sets their identity, so it must exist by now.
      if (!getGitIdentity()) throw new Error("Cannot create session: git identity not configured");
      const git = createGitManager(sessionDir);
      await git.init();
    }

    // Configure GitHub credentials in the new repo if available.
    // Skip when skipGitInit — the directory isn't a git repo yet (worktree
    // will be created later and has its own configureGitCredentials call).
    if (!opts?.skipGitInit && githubAuthManager.authenticated) {
      githubAuthManager.configureGitCredentials(sessionDir);
    }

    sessionManager.track(appSessionId, title, sessionDir);
    threadManager.init(appSessionId);
    console.log("[server] Created session directory:", sessionDir);

    return { appSessionId, sessionDir };
  };

  // ---- Shared repo directory (one clone per repo URL, all sessions are worktrees) ----
  const reposRoot = path.join(workspaceDir, "repos");

  const getSharedRepoDir = (repoUrl: string): string => {
    const hash = crypto.createHash("sha256").update(repoUrl).digest("hex").slice(0, 16);
    return path.join(reposRoot, hash);
  };

  // ---- HTTP API routes ----
  await registerApiRoutes(app, {
    sessionManager,
    createGitManager,
    createRepoGit,
    agentRegistry,
    githubAuthManager,
    credentialStore,
    defaultAgentId,
    workspaceDir,
    threadManager,
    deploymentManager,
    deploymentStore,
    usageManager,
    runnerRegistry,
    chatHistoryManager,
    authManager,
    broadcast,
    broadcastLog,
    getSharedRepoDir,
    createSessionDir,
    generateText,
    sessionsRoot,
  });

  // ---- Preview reverse proxy (container mode) ----
  // Routes /preview/:sessionId/:port/* and /api/preview-health/* to the
  // container's bridge IP. Must be registered BEFORE static file serving
  // so the SPA fallback (setNotFoundHandler) doesn't catch these routes.
  if (containerManager) {
    registerPreviewProxy(app, { containerManager });
  }

  // Serve the built client files from dist/client/
  if (shouldServeStatic) {
    const clientDir = path.resolve(process.cwd(), "dist/client");
    try {
      await app.register(fastifyStatic, {
        root: clientDir,
        prefix: "/",
        wildcard: false,
      });
      // SPA fallback — serve index.html for non-file routes
      app.setNotFoundHandler((_req, reply) => {
        reply.sendFile("index.html", clientDir);
      });
    } catch {
      // Client build may not exist during dev; that's fine
      console.log("[server] No built client found at", clientDir);
    }
  }

  // ---- WebSocket route ----
  app.get("/ws", { websocket: true }, (socket) => {
    console.log("[ws] client connected");
    clients.add(socket);

    // Per-connection active session state (lightweight — which session this tab views)
    let activeAppSessionId: string | undefined;
    let activeSessionDir: string | null = null;

    // Per-connection active agent selection (survives across runners)
    let perConnectionAgentId: AgentId = defaultAgentId;

    // Per-connection runner attachment
    let attachedRunner: SessionRunnerInterface | null = null;
    let runnerMessageListener: ((msg: WsServerMessage) => void) | null = null;

    const send = (msg: WsServerMessage) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(msg));
      }
    };

    // Send initial preview_status so client has a baseline state
    send({ type: "preview_status", running: false, port: 5173, url: "http://localhost:5173" });

    // ---- Runner attach/detach helpers ----

    const attachToRunner = (runner: SessionRunnerInterface) => {
      // Already attached to this runner — nothing to do
      if (attachedRunner === runner) return;

      // Detach from previous runner first
      detachFromRunner();

      attachedRunner = runner;
      runnerMessageListener = (msg: WsServerMessage) => send(msg);
      runner.on("message", runnerMessageListener);
      runner.attachViewer();

      // Replay buffered events from the current turn so client catches up
      for (const buffered of runner.getTurnEventBuffer()) {
        send(buffered);
      }

      // Send current queue state
      if (runner.getQueueSnapshot().length > 0) {
        send({ type: "queue_updated", queue: runner.getQueueSnapshot() });
      }

      // Send running status so client shows the right UI state
      // (only when the runner has activity to report — avoids noise for fresh runners)
      if (runner.running || runner.queueLength > 0 || runner.getTurnEventBuffer().length > 0) {
        send({
          type: "session_status",
          sessionId: runner.sessionId,
          running: runner.running,
          queueLength: runner.queueLength,
        });
      }

      // Send preview status only if the preview is already running (e.g.
      // reconnecting a second viewer tab). When a preview was just started by
      // attachViewer() above, the container will emit events on its own once
      // it finishes — sending a premature "running: false" here would flash
      // the placeholder UI unnecessarily.
      const previewStatus = runner.buildPreviewStatus();
      if (previewStatus.type === "preview_status" && previewStatus.running) {
        send(previewStatus);
      }
    };

    const detachFromRunner = () => {
      if (attachedRunner && runnerMessageListener) {
        attachedRunner.off("message", runnerMessageListener);
        attachedRunner.detachViewer();
      }
      attachedRunner = null;
      runnerMessageListener = null;
    };

    // ---- Auto-push (per-runner, but created here for githubAuthManager access) ----
    const scheduleAutoPush = (git: GitManager, _sendFn: typeof send) => {
      const runner = attachedRunner;
      if (!runner) return;
      runner.clearPushTimer();
      runner.setPushTimer(setTimeout(async () => {
        runner.setPushTimer(null);
        try {
          if (!githubAuthManager.authenticated) return;
          const remotes = await git.getRemotes();
          const origin = remotes.find((r) => r.name === "origin");
          if (!origin) return;
          const branch = await git.getCurrentBranch();
          if (!branch) return;
          await git.push("origin", branch);
          runner.emitMessage({ type: "github_push_result", success: true, message: `Auto-pushed to origin/${branch}`, branch });
        } catch (err) {
          broadcastLog("server", `Auto-push failed: ${getErrorMessage(err)}`);
        }
      }, autoPushDebounceMs));
    };

    /** Get the effective workspace directory for file operations. */
    const getActiveDir = (): string => activeSessionDir ?? workspaceDir;

    /** Get a GitManager for the active session. Throws if no session is active. */
    const getActiveGitManager = (): GitManager => {
      if (!activeSessionDir) {
        throw new Error("No active session — git operations require a session");
      }
      return createGitManager(activeSessionDir);
    };

    /**
     * Activate a session by ID — sets activeSessionDir, creates a runner
     * (which starts a container), and attaches this connection to it.
     */
    const activateSession = async (sessionId: string) => {
      const session = sessionManager.get(sessionId);
      activeAppSessionId = sessionId;
      const dir = session?.workspaceDir ?? null;

      // Attach to an existing runner or eagerly create one for the container.
      const existingRunner = runnerRegistry.get(sessionId);
      console.log(`[session] Activating ${sessionId}, dir=${dir}, existingRunner=${!!existingRunner}`);
      if (existingRunner) {
        attachToRunner(existingRunner);
      } else if (dir) {
        const runner = runnerRegistry.getOrCreate(sessionId, dir, perConnectionAgentId);
        attachToRunner(runner);
      } else {
        detachFromRunner();
      }

      if (dir !== activeSessionDir) {
        const oldDir = activeSessionDir;
        activeSessionDir = dir;

        // Clear terminal logs when switching away from a previous session
        if (oldDir !== null) {
          logBuffer = [];
          broadcast({ type: "clear_logs" });
        }
      }
      // Check git identity for the newly activated session
      if (dir) {
        checkGitIdentity(dir);
      }
    };

    // Send buffered log entries so new clients see existing terminal output
    for (const entry of logBuffer) {
      send(entry);
    }

    // Block the UI until the user has configured a git identity.
    // This fires on every WS connect so new tabs see the overlay immediately.
    if (!getGitIdentity()) {
      send({ type: "git_identity_required" });
    }

    // Check git identity when a session becomes active.
    // Identity lives in the global git config — all repos inherit it automatically.
    const checkGitIdentity = async (_sessionDir: string) => {
      if (getGitIdentity()) return;
      send({ type: "git_identity_required" });
    };

    /** Read the system prompt file if it exists. Returns undefined when absent or empty. */
    const readSystemPrompt = async (): Promise<string | undefined> => {
      try {
        const content = await fs.readFile(
          path.join(workspaceDir, ".shipit", "system-prompt.md"),
          "utf-8",
        );
        const trimmed = content.trim();
        return trimmed || undefined;
      } catch {
        return undefined;
      }
    };

    // ---- Handler context for extracted WebSocket handlers ----
    // Agent state getters/setters delegate to the attached SessionRunnerInterface.
    // If no runner is attached, they use safe defaults (null, false, etc.).
    const ctx: HandlerContext = {
      send,
      broadcast,
      broadcastLog,
      getActiveDir,
      getActiveGitManager,
      getActiveAppSessionId: () => activeAppSessionId,
      setActiveAppSessionId: (id) => { activeAppSessionId = id; },
      getActiveSessionDir: () => activeSessionDir,
      setActiveSessionDir: (dir) => { activeSessionDir = dir; },
      activateSession,
      agentFactory: (agentId: AgentId) => {
        // In production, the attached runner creates a proxy agent that
        // delegates to the session container over HTTP.
        if (attachedRunner?.createAgent) {
          return attachedRunner.createAgent(agentId);
        }
        // Test fallback — agentFactory is injected via deps in tests.
        if (agentFactory) {
          return agentFactory(agentId);
        }
        throw new Error("No agent factory available — session not activated or no runner attached");
      },
      // Agent state delegates to runner
      getAgent: () => attachedRunner?.getAgent() ?? null,
      setAgent: (a) => { if (attachedRunner) attachedRunner.setAgent(a); },
      getActiveAgentId: () => attachedRunner?.agentId ?? perConnectionAgentId,
      setActiveAgentId: (id) => { perConnectionAgentId = id; if (attachedRunner) attachedRunner.agentId = id; },
      getIsClaudeRunning: () => attachedRunner?.running ?? false,
      setIsClaudeRunning: (v) => { if (attachedRunner) attachedRunner.running = v; },
      getWasInterrupted: () => attachedRunner?.wasInterrupted ?? false,
      setWasInterrupted: (v) => { if (attachedRunner) attachedRunner.wasInterrupted = v; },
      getTurnSummary: () => attachedRunner?.turnSummary ?? "",
      setTurnSummary: (s) => { if (attachedRunner) attachedRunner.turnSummary = s; },
      getAccumulatedText: () => attachedRunner?.accumulatedText ?? "",
      setAccumulatedText: (s) => { if (attachedRunner) attachedRunner.accumulatedText = s; },
      getAccumulatedToolUse: () => attachedRunner?.accumulatedToolUse ?? [],
      setAccumulatedToolUse: (blocks) => { if (attachedRunner) attachedRunner.accumulatedToolUse = blocks; },
      getChatMessageGroups: () => attachedRunner?.chatMessageGroups ?? [],
      setChatMessageGroups: (groups) => { if (attachedRunner) attachedRunner.chatMessageGroups = groups; },
      getNeedsNewMessageGroup: () => attachedRunner?.needsNewMessageGroup ?? true,
      setNeedsNewMessageGroup: (v) => { if (attachedRunner) attachedRunner.needsNewMessageGroup = v; },
      getMessageQueue: () => attachedRunner?.messageQueue ?? [],
      clearMessageQueue: () => { if (attachedRunner) attachedRunner.clearQueue(); },
      getTerminal: () => attachedRunner?.getTerminal() ?? null,
      setTerminal: (t) => { if (attachedRunner) attachedRunner.setTerminal(t); },
      clearLogBuffer: () => { logBuffer = []; },
      // Session runner
      getRunner: () => attachedRunner,
      getRunnerRegistry: () => runnerRegistry,
      attachToRunner,
      detachFromRunner,
      sessionManager,
      chatHistoryManager,
      createGitManager,
      createRepoGit,
      githubAuthManager,
      threadManager,
      deploymentManager,
      deploymentStore,
      featureManager,
      usageManager,
      authManager,
      agentRegistry,
      credentialStore,
      createSessionDir,
      generateText,
      getSharedRepoDir,
      checkGitIdentity,
      readSystemPrompt,
      scheduleAutoPush,
      workspaceDir,
      sessionsRoot,
      defaultAgentId,
    };

    socket.on("message", async (raw: Buffer) => {
      let msg: WsClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send({ type: "error", message: "Invalid JSON" });
        return;
      }

      switch (msg.type) {
        // ---- Diff review operations ----
        case "diff_comment": {
          // Format comments into a prompt and send to Claude (like init_preview_config)
          const commentLines = msg.comments.map((c: { file: string; line: number; text: string }) =>
            `File: ${c.file}, Line ${c.line}:\n"${c.text}"`
          ).join("\n\n");
          const prompt = `The user has reviewed your changes and left the following inline comments:\n\n${commentLines}\n\nPlease address these comments and update the code accordingly.`;
          sendMessageHandlers.handleSendMessage(ctx, { type: "send_message", text: prompt });
          return;
        }

        // ---- Terminal operations ----
        case "terminal_start": return terminalHandlers.handleTerminalStart(ctx);
        case "terminal_input": return terminalHandlers.handleTerminalInput(ctx, msg);
        case "terminal_resize": return terminalHandlers.handleTerminalResize(ctx, msg);
        case "clear_logs": return terminalHandlers.handleClearLogs(ctx);

        // ---- Settings operations ----
        case "set_agent": {
          // Per-connection state: must stay on WS (HTTP can't set WS connection state)
          const agentId = msg.agentId;
          const info = agentRegistry.get(agentId);
          if (!info) { send({ type: "error", message: `Unknown agent: ${agentId}` }); return; }
          if (!info.installed) { send({ type: "error", message: `${info.name} CLI is not installed` }); return; }
          if (!info.authConfigured) {
            const envKey = agentId === "codex" ? "OPENAI_API_KEY" : "";
            send({ type: "error", message: `${envKey || "API key"} is not set. Add it in Settings → Agents.` });
            return;
          }
          ctx.setActiveAgentId(agentId);
          return;
        }
        // ---- Session operations ----
        case "new_session": return sessionHandlers.handleNewSession(ctx);
        case "activate_session": return sessionHandlers.handleActivateSession(ctx, msg);

        // ---- Deploy operations ----
        case "initiate_deploy": return deployHandlers.handleInitiateDeploy(ctx, msg);
        case "cancel_deploy": return deployHandlers.handleCancelDeploy(ctx);

        // ---- Thread operations ----
        case "fork_thread": return threadHandlers.handleForkThread(ctx, msg);
        case "switch_thread": return threadHandlers.handleSwitchThread(ctx, msg);

        // ---- Misc operations ----
        case "cancel_queued_message": return miscHandlers.handleCancelQueuedMessage(ctx, msg);
        case "interrupt_claude": return miscHandlers.handleInterruptClaude(ctx);

        // ---- Preview config ----
        case "init_preview_config": {
          // Send a prompt to Claude asking it to create shipit.yaml
          const prompt = `Analyze this project and create a shipit.yaml file at the workspace root.
The file configures the live preview and dependency installation.

For projects with dependencies (npm, yarn, pip, etc.), include an install command:

install: npm install
preview:
  command: npm run dev
  ports: [3000]

For static HTML projects (no build step, no dependencies):

preview:
  html: index.html

Look at package.json scripts, framework config files, and project structure
to determine the correct install command, preview mode, command, and ports.`;
          sendMessageHandlers.handleSendMessage(ctx, {
            type: "send_message",
            text: prompt,
          });
          return;
        }

        // ---- Send message / answer / repo import ----
        case "send_message": return sendMessageHandlers.handleSendMessage(ctx, msg);
        case "answer_question": return sendMessageHandlers.handleAnswerQuestion(ctx, msg);
        case "home_send_with_repo": return sendMessageHandlers.handleHomeSendWithRepo(ctx, msg);
      }
    });

    // ---- On disconnect: detach from runner (don't kill anything!) ----
    socket.on("close", () => {
      console.log("[ws] client disconnected");
      clients.delete(socket);

      // Detach from runner — runner keeps going (including its terminal)!
      detachFromRunner();
    });
  });

  // ---- Container health monitoring ----
  // When a container dies unexpectedly (OOM, crash), notify viewers and clean up.
  if (containerManager) {
    containerManager.on("container_exited", (sessionId, _exitCode, error) => {
      console.error(`[container] Session ${sessionId} container exited: ${error ?? "unknown"}`);
      const runner = runnerRegistry.get(sessionId);
      if (runner) {
        runner.emitMessage({
          type: "session_status",
          sessionId,
          running: false,
          error: `Session container exited unexpectedly${error ? `: ${error}` : ""}`,
        });
        runner.dispose();
      }
    });
  }

  // Graceful shutdown — register once via app hook rather than per-call
  // process.on() to avoid MaxListeners warnings when buildApp() is called
  // repeatedly in tests.
  app.addHook("onClose", async () => {
    authManager.kill();
    runnerRegistry.disposeAll();
    if (containerManager) {
      await containerManager.dispose();
    }
  });

  return app;
}

// Only start the server when this file is the entry point (not when imported by tests).
// Vitest sets process.env.VITEST; alternatively check import.meta.url vs process.argv[1].
if (!process.env.VITEST) {
  const app = await buildApp({ serveStatic: true });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  const port = Number(process.env.PORT) || 3000;
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`[server] listening on http://0.0.0.0:${port}`);
}
