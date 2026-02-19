import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { ClaudeProcess } from "./claude.js";
import { ViteManager } from "./vite-manager.js";
import { GitManager, generateBranchPrefix } from "./git.js";
import { AuthManager } from "./auth.js";
import { GitHubAuthManager } from "./github-auth.js";
import { SessionManager } from "./sessions.js";
import { ChatHistoryManager } from "./chat-history.js";
import { scanPorts, snapshotBaselinePorts, DEFAULT_SCAN_PORTS } from "./port-scanner.js";
import { UsageManager } from "./usage.js";
import { FileWatcher } from "./file-watcher.js";
import { TerminalProcess } from "./terminal.js";
import { FeatureManager } from "./features.js";
import { ThreadManager } from "./threads.js";
import { DeploymentManager } from "./deployment-manager.js";
import { DeploymentStore } from "./deployment-store.js";
import { GitIdentityStore } from "./git-identity-store.js";
import { VercelTarget } from "./deploy-targets/vercel.js";
import { CloudflareTarget } from "./deploy-targets/cloudflare.js";
import { generateSessionName } from "./session-namer.js";
import { ClaudeAdapter } from "./agents/claude-adapter.js";
import { CodexAdapter } from "./agents/codex-adapter.js";
import { AgentRegistry } from "./agents/agent-registry.js";
import type { AgentId, AgentEvent, AgentProcess } from "./agents/agent-process.js";
import type { WsClientMessage, WsServerMessage, WsLogEntry, ClaudeEvent, ClaudeContentBlockText, ClaudeContentBlockToolUse, ImageAttachment, FileAttachment, FileContextRef, PermissionMode } from "./types.js";
import { getErrorMessage, validateImages, resolveFileAttachments, formatFileContext } from "./validation.js";
import type { HandlerContext } from "./ws-handlers/types.js";
import * as gitHandlers from "./ws-handlers/git-handlers.js";
import * as fileHandlers from "./ws-handlers/file-handlers.js";
import * as terminalHandlers from "./ws-handlers/terminal-handlers.js";
import * as settingsHandlers from "./ws-handlers/settings-handlers.js";
import * as miscHandlers from "./ws-handlers/misc-handlers.js";
import * as deployHandlers from "./ws-handlers/deploy-handlers.js";
import * as githubHandlers from "./ws-handlers/github-handlers.js";
import * as prHandlers from "./ws-handlers/pr-handlers.js";
import * as sessionHandlers from "./ws-handlers/session-handlers.js";
import * as worktreeHandlers from "./ws-handlers/worktree-handlers.js";
import * as templateHandlers from "./ws-handlers/template-handlers.js";
import * as threadHandlers from "./ws-handlers/thread-handlers.js";

/**
 * Convert a normalized AgentEvent back to the legacy ClaudeEvent format
 * for backward compatibility. Returns null for events that don't have
 * a ClaudeEvent equivalent.
 */
function agentEventToClaudeEvent(event: AgentEvent): ClaudeEvent | null {
  switch (event.type) {
    case "agent_init":
      return {
        type: "system",
        subtype: "init",
        session_id: event.sessionId,
        model: event.model,
        tools: event.tools,
      };
    case "agent_assistant":
      return {
        type: "assistant",
        message: { content: event.content },
      };
    case "agent_tool_result":
      return {
        type: "user",
        message: { content: event.content },
      };
    case "agent_result":
      return {
        type: "result",
        subtype: event.status,
        session_id: event.sessionId,
        total_cost_usd: event.cost?.totalUsd,
        duration_ms: event.durationMs,
        result: event.error,
        input_tokens: event.tokens?.input,
        output_tokens: event.tokens?.output,
        cache_read_tokens: event.tokens?.cacheRead,
        cache_write_tokens: event.tokens?.cacheWrite,
      };
    default:
      return null;
  }
}

/** Map model identifiers to context window sizes. */
export function getContextWindowSize(model: string): number {
  if (model.includes("opus")) return 200_000;
  if (model.includes("sonnet")) return 200_000;
  if (model.includes("haiku")) return 200_000;
  return 200_000;
}

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
  /** Vite dev server manager. Defaults to `new ViteManager()` with auto-start. */
  viteManager?: ViteManager;
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
  /** Factory for creating ClaudeProcess instances. Defaults to `() => new ClaudeProcess()`. */
  claudeFactory?: () => ClaudeProcess;
  /**
   * Factory for creating AgentProcess instances by agent ID.
   * When provided, takes precedence over claudeFactory.
   * Defaults to `(id) => new ClaudeAdapter()` (only "claude" is supported).
   */
  agentFactory?: (agentId: AgentId) => AgentProcess;
  /** Default agent ID for new sessions. Defaults to "claude". */
  defaultAgentId?: AgentId;
  /** Root workspace directory. Defaults to `/workspace`. */
  workspaceDir?: string;
  /** Whether to serve static files from dist/client. Defaults to true. */
  serveStatic?: boolean;
  /** Whether to start the Vite dev server. Defaults to true. */
  startVite?: boolean;
  /**
   * Port detection function called after each Claude turn and periodically to
   * find non-Vite dev servers. Returns all detected ports. Defaults to scanning
   * DEFAULT_SCAN_PORTS. Inject a stub in tests to avoid real port scanning.
   */
  detectPorts?: (excludePorts: number[]) => Promise<number[]>;
  /** Port the Fastify server is listening on, excluded from port scans. Defaults to 3000. */
  serverPort?: number;
  /**
   * Interval in milliseconds for periodic port scanning. Set to 0 to disable.
   * The scanner runs while at least one WebSocket client is connected.
   * Defaults to 5000 (5 seconds).
   */
  portScanIntervalMs?: number;
  /**
   * Ports that were already open when the server started. These are excluded
   * from port scans so that system-level services (e.g. ShipIt's own Vite dev
   * server during development, or other host tooling) never appear in the
   * user-facing preview tab. Defaults to a live snapshot via snapshotBaselinePorts().
   */
  baselinePorts?: number[];
  /**
   * File watcher instance. Defaults to `new FileWatcher()`.
   * Inject a stub in tests to avoid real filesystem watching.
   */
  fileWatcher?: FileWatcher;
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
   * Git identity store for global name/email persistence.
   * Defaults to `new GitIdentityStore(workspaceDir)`.
   */
  gitIdentityStore?: GitIdentityStore;
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
    claudeFactory = () => new ClaudeProcess(),
    defaultAgentId = "claude" as AgentId,
    workspaceDir = WORKSPACE,
    serveStatic: shouldServeStatic = true,
    startVite = true,
    detectPorts = (excludePorts: number[]) => scanPorts(DEFAULT_SCAN_PORTS, excludePorts),
    serverPort = 3000,
    portScanIntervalMs = 5000,
    baselinePorts = [],
    autoPushDebounceMs = 5000,
  } = deps;

  // Build effective agent factory — agentFactory takes precedence over claudeFactory
  const agentFactory: (agentId: AgentId) => AgentProcess = deps.agentFactory ?? ((agentId: AgentId) => {
    switch (agentId) {
      case "codex":
        return new CodexAdapter();
      case "claude":
      default:
        return new ClaudeAdapter(claudeFactory());
    }
  });

  const app = Fastify({ logger: false });

  await app.register(fastifyWebsocket);

  // ---- Per-session directory root ----
  const sessionsRoot = path.join(workspaceDir, "sessions");

  // ---- Per-session GitManager factory ----
  const createGitManager = deps.createGitManager ?? ((dir: string) => new GitManager(dir));

  // ---- Vite dev server manager ----
  const viteManager = deps.viteManager ?? new ViteManager();

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
  const githubAuthManager = deps.githubAuthManager ?? new GitHubAuthManager(workspaceDir);
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

  // ---- Git identity store ----
  const gitIdentityStore = deps.gitIdentityStore ?? new GitIdentityStore(workspaceDir);

  // ---- Text generation (AI-powered features) ----
  const generateText = deps.generateText ?? ((prompt: string, cwd?: string): Promise<string> => {
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

  // ---- File watcher ----
  const fileWatcher = deps.fileWatcher ?? new FileWatcher();
  fileWatcher.start(workspaceDir);

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

  // ---- File watcher event handler ----
  fileWatcher.on("changes", (changedFiles: string[]) => {
    broadcast({ type: "files_changed", paths: changedFiles });
  });

  // Track all auto-detected dev server ports (non-Vite)
  let detectedPorts: number[] = [];

  /**
   * Run a port scan and broadcast if the set of detected ports changed.
   * Shared between the post-turn scan and the periodic interval scanner.
   *
   * The exclude list combines three sources:
   *  1. serverPort       — ShipIt's own Fastify server
   *  2. viteManager.port — the managed Vite preview for the user's project
   *  3. baselinePorts    — ports that were already open before the session
   *                        started (system services, ShipIt's own dev Vite, etc.)
   */
  const runPortScan = async () => {
    try {
      const excludeList = [serverPort, viteManager.port, ...baselinePorts];
      const ports = await detectPorts(excludeList);
      const changed =
        ports.length !== detectedPorts.length ||
        ports.some((p, i) => p !== detectedPorts[i]);
      if (changed) {
        detectedPorts = ports;
        broadcastPreviewStatus();
      }
    } catch (err) {
      console.error("[port-scanner] scan failed:", getErrorMessage(err));
    }
  };

  // ---- Periodic port scanning ----
  // Scans on an interval while at least one WebSocket client is connected,
  // catching dev servers started mid-turn (e.g. via Bash tool).
  let portScanTimer: ReturnType<typeof setInterval> | null = null;

  const startPortScanInterval = () => {
    if (portScanTimer || portScanIntervalMs <= 0) return;
    portScanTimer = setInterval(runPortScan, portScanIntervalMs);
  };

  const stopPortScanInterval = () => {
    if (portScanTimer) {
      clearInterval(portScanTimer);
      portScanTimer = null;
    }
  };

  /**
   * Build the current preview status message. Vite takes priority when running;
   * otherwise fall back to any port found by the port scanner.
   */
  const getPreviewStatus = (): WsServerMessage => {
    if (viteManager.running) {
      return {
        type: "preview_status",
        running: true,
        port: viteManager.port,
        url: `http://localhost:${viteManager.port}`,
        source: "vite",
        detectedPorts: detectedPorts.length > 0 ? detectedPorts : undefined,
      };
    }
    if (detectedPorts.length > 0) {
      return {
        type: "preview_status",
        running: true,
        port: detectedPorts[0],
        url: `http://localhost:${detectedPorts[0]}`,
        source: "detected",
        detectedPorts,
      };
    }
    return {
      type: "preview_status",
      running: false,
      port: viteManager.port,
      url: `http://localhost:${viteManager.port}`,
    };
  };

  const broadcastPreviewStatus = () => {
    const payload = JSON.stringify(getPreviewStatus());
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  };

  viteManager.on("ready", () => {
    console.log("[server] Vite dev server is ready");
    broadcastPreviewStatus();
  });

  viteManager.on("stopped", () => {
    broadcastPreviewStatus();
  });

  // ---- Auth event handlers ----
  authManager.on("auth_url", (url: string) => {
    broadcast({ type: "auth_required", url });
  });

  authManager.on("auth_complete", () => {
    broadcast({ type: "auth_complete" });
  });

  authManager.on("auth_failed", () => {
    console.log("[auth] OAuth flow failed — client should provide API key");
  });

  // Start the Vite dev server (skipped in tests)
  if (startVite) {
    viteManager.start();
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
      // Initialize a fresh git repo for this session
      const git = createGitManager(sessionDir);
      await git.init();
      // Apply stored global identity so commits use the user's name/email
      const stored = gitIdentityStore.get();
      if (stored) await git.setIdentity(stored.name, stored.email);
    }

    // Configure GitHub credentials in the new repo if available
    if (githubAuthManager.authenticated) {
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

  // ---- WebSocket route ----
  app.get("/ws", { websocket: true }, (socket) => {
    console.log("[ws] client connected");
    clients.add(socket);

    // Start periodic port scanning when the first client connects
    if (clients.size === 1) {
      startPortScanInterval();
    }
    let claude: AgentProcess | null = null;
    let activeAgentId: AgentId = defaultAgentId;
    let turnSummary = "";

    // ---- Auto-push debounce state ----
    let pushTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleAutoPush = (git: GitManager, sendFn: typeof send) => {
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(async () => {
        pushTimer = null;
        try {
          // Check conditions: authenticated, remote exists, not detached HEAD
          if (!githubAuthManager.authenticated) return;
          const remotes = await git.getRemotes();
          const origin = remotes.find((r) => r.name === "origin");
          if (!origin) return;

          const branch = await git.getCurrentBranch();
          if (!branch) return;

          await git.push("origin", branch);
          sendFn({ type: "github_push_result", success: true, message: `Auto-pushed to origin/${branch}`, branch });
        } catch (err) {
          broadcastLog("server", `Auto-push failed: ${getErrorMessage(err)}`);
        }
      }, autoPushDebounceMs);
    };
    // Per-connection interactive terminal
    let terminal: TerminalProcess | null = null;

    // Per-connection active session state
    let activeAppSessionId: string | undefined;
    let activeSessionDir: string | null = null;

    // Per-connection message queue (prompt queuing feature)
    const messageQueue: Array<{
      text: string;
      images?: ImageAttachment[];
      files?: FileContextRef[];
      permissionMode?: PermissionMode;
    }> = [];
    let isClaudeRunning = false;
    /** Set when user sends interrupt_claude, cleared when a new Claude process starts. */
    let wasInterrupted = false;
    // Accumulate the assistant response across streaming events for persistence
    let accumulatedText = "";
    let accumulatedToolUse: Array<{ type: "tool_use"; id: string; name: string; input: Record<string, unknown> }> = [];

    const send = (msg: WsServerMessage) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(msg));
      }
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
     * Activate a session by ID — sets activeSessionDir and restarts the
     * file watcher to watch the session's directory.
     */
    const activateSession = (sessionId: string) => {
      const session = sessionManager.get(sessionId);
      activeAppSessionId = sessionId;
      const dir = session?.workspaceDir ?? null;
      if (dir !== activeSessionDir) {
        activeSessionDir = dir;
        // Restart file watcher to the new directory
        fileWatcher.stop();
        fileWatcher.start(getActiveDir());
      }
      // Check git identity for the newly activated session
      if (dir) {
        checkGitIdentity(dir);
      }
    };

    // Send current preview status on connect
    send(getPreviewStatus());

    // Send buffered log entries so new clients see existing terminal output
    for (const entry of logBuffer) {
      send(entry);
    }

    // Check git identity when a session becomes active (deferred — no root git repo).
    // If the session repo lacks identity, auto-apply from global store before prompting.
    const checkGitIdentity = async (sessionDir: string) => {
      try {
        const git = createGitManager(sessionDir);
        if (await git.hasIdentity()) return;

        // Try to apply stored global identity
        const stored = gitIdentityStore.get();
        if (stored) {
          await git.setIdentity(stored.name, stored.email);
          send({ type: "git_identity_set", name: stored.name, email: stored.email });
          return;
        }

        send({ type: "git_identity_required" });
      } catch {
        // Session dir may not exist yet; identity will be checked after creation
      }
    };

    /** Read the system prompt file if it exists. Returns undefined when absent or empty. */
    const readSystemPrompt = async (): Promise<string | undefined> => {
      // System prompt is global (root workspace), not per-session
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

    /**
     * Core Claude execution logic. Shared between send_message and
     * home_send_with_repo handlers. Session state (activeAppSessionId,
     * activeSessionDir) must already be set before calling this.
     */
    const runClaudeWithMessage = async (opts: {
      userText: string;
      images?: ImageAttachment[];
      validatedFiles: FileAttachment[];
      agentSessionId?: string;
      permissionMode?: PermissionMode;
      isNewSession: boolean;
    }): Promise<void> => {
      const { userText, images, validatedFiles, permissionMode, isNewSession } = opts;
      let { agentSessionId } = opts;

      turnSummary = "";
      accumulatedText = "";
      accumulatedToolUse = [];
      let receivedResult = false;
      wasInterrupted = false;
      claude = agentFactory(activeAgentId);
      const currentAgent = claude;

      // Relay CLI log lines (PTY merges stdout+stderr) to the terminal panel
      currentAgent.on("log", (source: string, text: string) => {
        broadcastLog(source as "stderr" | "stdout" | "server", text);
      });

      // Build images metadata for chat history persistence (inline base64)
      const historyImages = images?.map((img) => ({
        data: img.data,
        mediaType: img.mediaType,
      }));

      // Build file metadata for chat history persistence (path + preview only)
      const historyFiles = validatedFiles.length > 0
        ? validatedFiles.map((f) => ({
            path: f.path,
            contentPreview: f.content.slice(0, 200),
            startLine: f.startLine,
            endLine: f.endLine,
          }))
        : undefined;

      // Persist the user message once we know the session
      const persistUserMessage = (sessionId: string) => {
        chatHistoryManager.append(sessionId, {
          role: "user",
          text: userText,
          images: historyImages,
          files: historyFiles,
        });
      };

      currentAgent.on("event", (event: AgentEvent) => {
        // Send normalized agent_event to the client
        send({ type: "agent_event", event });

        // Also send legacy claude_event for backward compatibility
        const legacyEvent = agentEventToClaudeEvent(event);
        if (legacyEvent) {
          send({ type: "claude_event", event: legacyEvent });
        }

        // Track agent session when we get the session_id from init event
        if (event.type === "agent_init") {
          if (activeAppSessionId) {
            // Store the agent's conversation ID on the app session
            sessionManager.setAgentSessionId(activeAppSessionId, event.sessionId);
            const session = sessionManager.get(activeAppSessionId);
            if (session) {
              send({ type: "session_started", session });
            }
            // Persist the user message for new sessions
            if (isNewSession) {
              persistUserMessage(activeAppSessionId);
            }
          } else {
            // Legacy fallback: no app session created (shouldn't happen with isolation)
            const title = userText.slice(0, 80) || "New session";
            const session = sessionManager.track(event.sessionId, title);
            activeAppSessionId = event.sessionId;
            send({ type: "session_started", session });
            persistUserMessage(event.sessionId);
          }

          // Forward model info to the client
          if (event.model) {
            send({
              type: "model_info",
              model: event.model,
              contextWindowTokens: getContextWindowSize(event.model),
            });
          }
        }

        // Collect assistant text and tool use blocks for commit message + persistence
        if (event.type === "agent_assistant") {
          const text = (event.content ?? [])
            .filter((b): b is ClaudeContentBlockText => b.type === "text")
            .map((b) => b.text)
            .join("");
          if (text) {
            turnSummary = text;
            accumulatedText += text;
          }

          const toolBlocks = (event.content ?? [])
            .filter((b): b is ClaudeContentBlockToolUse => b.type === "tool_use");
          if (toolBlocks.length > 0) {
            accumulatedToolUse.push(...toolBlocks);
          }
        }

        // On result: persist the final assistant message, update session, record usage
        if (event.type === "agent_result") {
          receivedResult = true;
          if (activeAppSessionId) {
            sessionManager.setAgentSessionId(activeAppSessionId, event.sessionId);
            sessionManager.track(activeAppSessionId);
          }

          const usageSessionId = activeAppSessionId ?? event.sessionId;
          // Record cost/duration if present
          if (event.cost?.totalUsd !== undefined) {
            usageManager.record(
              usageSessionId,
              event.cost.totalUsd,
              event.durationMs ?? 0,
              event.tokens?.input,
              event.tokens?.output,
            );
            const sessionUsage = usageManager.getSessionUsage(usageSessionId);
            if (sessionUsage) {
              const tokenTotals = usageManager.getSessionTokenTotals(usageSessionId);
              send({
                type: "usage_update",
                sessionId: sessionUsage.sessionId,
                totalCostUsd: sessionUsage.totalCostUsd,
                totalDurationMs: sessionUsage.totalDurationMs,
                turnCount: sessionUsage.turnCount,
                lastTurnInputTokens: event.tokens?.input,
                lastTurnOutputTokens: event.tokens?.output,
                cumulativeInputTokens: tokenTotals?.cumulativeInputTokens,
              });
            }
          }

          // Persist the assistant response
          if (accumulatedText || accumulatedToolUse.length > 0) {
            chatHistoryManager.append(usageSessionId, {
              role: "assistant",
              text: accumulatedText,
              toolUse: accumulatedToolUse.length > 0 ? accumulatedToolUse : undefined,
            });
          }
        }
      });

      // For resumed sessions (sessionId already known), persist user message immediately
      if (!isNewSession && activeAppSessionId) {
        persistUserMessage(activeAppSessionId);
      }

      currentAgent.on("done", async (code: number | null) => {
        console.log("[agent] process exited with code", code);
        broadcastLog("server", `Agent process exited with code ${code}`);
        claude = null;

        // If the process exited without producing a result event, notify the
        // client so it can clear the loading state instead of hanging forever.
        // Don't show an error for user-initiated interrupts.
        if (!receivedResult && !wasInterrupted) {
          const reason = code !== 0
            ? `Agent process exited with code ${code}`
            : "Agent process ended without a response";
          send({ type: "error", message: reason });
        }

        // Auto-commit after agent turn using the session's git manager
        try {
          const git = getActiveGitManager();
          const firstLine = turnSummary.split("\n")[0]?.slice(0, 120) || "Agent turn";
          const hash = await git.autoCommit(firstLine);
          if (hash) {
            send({ type: "git_committed", hash, message: firstLine });
            // Schedule auto-push (debounced)
            scheduleAutoPush(git, send);
          }
        } catch (err) {
          console.error("[git] auto-commit failed:", getErrorMessage(err));
        }

        // Restart Vite after agent finishes in case new files were created
        if (!viteManager.running) {
          viteManager.start(getActiveDir());
        }

        // Scan for non-Vite dev servers that the agent may have started.
        await runPortScan();

        // Mark Claude as no longer running, then process the next queued message
        // If interrupted, clear the queue instead of dequeuing — the user wants to redirect.
        isClaudeRunning = false;
        if (wasInterrupted && messageQueue.length > 0) {
          messageQueue.length = 0;
          send({ type: "queue_updated", queue: [] });
        }
        if (!wasInterrupted && messageQueue.length > 0) {
          const next = messageQueue.shift()!;
          // Notify the client that the queue is now one shorter
          send({
            type: "queue_updated",
            queue: messageQueue.map((item, idx) => ({ text: item.text, position: idx + 1 })),
          });
          isClaudeRunning = true;
          // Resolve file attachments for the queued message (session dir is already active)
          const nextImages = next.images && next.images.length > 0 ? next.images : undefined;
          const nextFileRefs = next.files && next.files.length > 0 ? next.files : undefined;
          let nextValidatedFiles: FileAttachment[] = [];
          if (nextFileRefs) {
            const dir = activeSessionDir ?? workspaceDir;
            const fileResult = await resolveFileAttachments(nextFileRefs, dir);
            if (fileResult.error) {
              send({ type: "error", message: fileResult.error });
              isClaudeRunning = false;
              return;
            }
            nextValidatedFiles = fileResult.files;
          }
          const nextSession = activeAppSessionId ? sessionManager.get(activeAppSessionId) : undefined;
          try {
            await runClaudeWithMessage({
              userText: next.text,
              images: nextImages,
              validatedFiles: nextValidatedFiles,
              agentSessionId: nextSession?.agentSessionId,
              permissionMode: next.permissionMode,
              isNewSession: false,
            });
          } catch (err) {
            console.error("[queue] Error processing queued message:", getErrorMessage(err));
            isClaudeRunning = false;
          }
        }
      });

      currentAgent.on("auth_required", () => {
        console.log("[server] Agent CLI requires authentication, starting OAuth flow");
        send({ type: "auth_required" });
        authManager.startOAuthFlow();
      });

      currentAgent.on("error", (err: Error) => {
        console.error("[agent] process error:", err.message);
        broadcastLog("server", `Agent process error: ${err.message}`);
        const errorMsg = `Agent process error: ${err.message}`;
        send({ type: "error", message: errorMsg });
        // Persist the error so it shows up in history
        if (activeAppSessionId) {
          chatHistoryManager.append(activeAppSessionId, {
            role: "assistant",
            text: `Error: ${err.message}`,
            isError: true,
          });
        }
        claude = null;
      });

      // Build the system prompt, incorporating conversation replay for forked threads
      let systemPrompt = await readSystemPrompt();
      if (activeAppSessionId) {
        const activeThread = threadManager.getActiveThread(activeAppSessionId);
        if (activeThread) {
          const replay = threadManager.consumeConversationReplay(
            activeAppSessionId,
            activeThread.id,
          );
          if (replay) {
            // On a forked thread with replay context, start a fresh session
            // (no --resume) and inject the conversation history as system prompt.
            agentSessionId = undefined;
            systemPrompt = systemPrompt
              ? `${systemPrompt}\n\n${replay}`
              : replay;
          }
        }
      }
      // Prepend file context to the prompt if files are attached
      let prompt = userText;
      if (validatedFiles.length > 0) {
        const context = formatFileContext(validatedFiles);
        prompt = `${context}\n\n${prompt}`;
      }

      currentAgent.run({
        prompt,
        sessionId: agentSessionId,
        systemPrompt,
        images,
        cwd: getActiveDir(),
        permissionMode,
      });
      broadcastLog("server", "Agent process started");
    };

    // ---- Handler context for extracted WebSocket handlers ----
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
      getAgent: () => claude,
      setAgent: (a) => { claude = a; },
      getIsClaudeRunning: () => isClaudeRunning,
      setIsClaudeRunning: (v) => { isClaudeRunning = v; },
      getWasInterrupted: () => wasInterrupted,
      setWasInterrupted: (v) => { wasInterrupted = v; },
      getMessageQueue: () => messageQueue,
      clearMessageQueue: () => { messageQueue.length = 0; },
      getTerminal: () => terminal,
      setTerminal: (t) => { terminal = t; },
      clearLogBuffer: () => { logBuffer = []; },
      sessionManager,
      chatHistoryManager,
      createGitManager,
      githubAuthManager,
      threadManager,
      deploymentManager,
      deploymentStore,
      featureManager,
      usageManager,
      viteManager,
      authManager,
      fileWatcher,
      agentRegistry,
      gitIdentityStore,
      createSessionDir,
      generateText,
      getSharedRepoDir,
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
        // ---- Git operations ----
        case "get_git_log": return gitHandlers.handleGetGitLog(ctx);
        case "rollback": return gitHandlers.handleRollback(ctx, msg);

        // ---- File operations ----
        case "get_file_tree": return fileHandlers.handleGetFileTree(ctx);
        case "get_file_content": return fileHandlers.handleGetFileContent(ctx, msg);
        case "list_docs": return fileHandlers.handleListDocs(ctx);
        case "get_doc": return fileHandlers.handleGetDoc(ctx, msg);

        // ---- Terminal operations ----
        case "terminal_start": return terminalHandlers.handleTerminalStart(ctx);
        case "terminal_input": return terminalHandlers.handleTerminalInput(ctx, msg);
        case "terminal_resize": return terminalHandlers.handleTerminalResize(ctx, msg);
        case "clear_logs": return terminalHandlers.handleClearLogs(ctx);

        // ---- Settings operations ----
        case "set_api_key": return settingsHandlers.handleSetApiKey(ctx, msg);
        case "clear_api_key": return settingsHandlers.handleClearApiKey(ctx);
        case "paste_auth_code": return settingsHandlers.handlePasteAuthCode(ctx, msg);
        case "set_git_identity": return settingsHandlers.handleSetGitIdentity(ctx, msg);
        case "get_global_settings": return settingsHandlers.handleGetGlobalSettings(ctx);
        case "save_global_settings": return settingsHandlers.handleSaveGlobalSettings(ctx, msg);
        case "set_agent": {
          const result = settingsHandlers.handleSetAgent(ctx, msg);
          if (result) activeAgentId = result.newAgentId as AgentId;
          break;
        }
        case "list_agents": return settingsHandlers.handleListAgents(ctx);
        case "set_agent_env": return settingsHandlers.handleSetAgentEnv(ctx, msg);
        case "list_features": return settingsHandlers.handleListFeatures(ctx);
        case "get_usage_stats": return settingsHandlers.handleGetUsageStats(ctx);

        // ---- Session operations ----
        case "list_sessions": return sessionHandlers.handleListSessions(ctx);
        case "new_session": return sessionHandlers.handleNewSession(ctx);
        case "archive_session": return sessionHandlers.handleArchiveSession(ctx, msg);
        case "rename_session": return sessionHandlers.handleRenameSession(ctx, msg);
        case "get_chat_history": return sessionHandlers.handleGetChatHistory(ctx, msg);

        // ---- Worktree operations ----
        case "fork_session": return worktreeHandlers.handleForkSession(ctx, msg);
        case "list_worktrees": return worktreeHandlers.handleListWorktrees(ctx);
        case "merge_session": return worktreeHandlers.handleMergeSession(ctx, msg);

        // ---- Template operations ----
        case "list_templates": return templateHandlers.handleListTemplates(ctx);
        case "apply_template": return templateHandlers.handleApplyTemplate(ctx, msg);
        case "home_create_repo_with_template": return templateHandlers.handleHomeCreateRepoWithTemplate(ctx, msg);

        // ---- GitHub operations ----
        case "github_set_token": return githubHandlers.handleGithubSetToken(ctx, msg);
        case "github_get_status": return githubHandlers.handleGithubGetStatus(ctx);
        case "github_push": return githubHandlers.handleGithubPush(ctx, msg);
        case "github_pull": return githubHandlers.handleGithubPull(ctx, msg);
        case "github_set_remote": return githubHandlers.handleGithubSetRemote(ctx, msg);
        case "github_get_remotes": return githubHandlers.handleGithubGetRemotes(ctx);
        case "github_logout": return githubHandlers.handleGithubLogout(ctx);
        case "github_search_repos": return githubHandlers.handleGithubSearchRepos(ctx, msg);
        case "github_list_branches": return githubHandlers.handleGithubListBranches(ctx);

        // ---- PR operations ----
        case "github_create_pr": return prHandlers.handleGithubCreatePr(ctx, msg);
        case "get_pr_status": return prHandlers.handleGetPrStatus(ctx);
        case "merge_pr": return prHandlers.handleMergePr(ctx, msg);
        case "generate_pr_description": return prHandlers.handleGeneratePrDescription(ctx);

        // ---- Deploy operations ----
        case "list_deploy_targets": return deployHandlers.handleListDeployTargets(ctx);
        case "deploy_configure": return deployHandlers.handleDeployConfigure(ctx, msg);
        case "initiate_deploy": return deployHandlers.handleInitiateDeploy(ctx, msg);
        case "get_deploy_history": return deployHandlers.handleGetDeployHistory(ctx);
        case "cancel_deploy": return deployHandlers.handleCancelDeploy(ctx);
        case "get_project_settings": return deployHandlers.handleGetProjectSettings(ctx);
        case "delete_deploy_config": return deployHandlers.handleDeleteDeployConfig(ctx, msg);

        // ---- Thread operations ----
        case "list_threads": return threadHandlers.handleListThreads(ctx);
        case "create_checkpoint": return threadHandlers.handleCreateCheckpoint(ctx, msg);
        case "fork_thread": return threadHandlers.handleForkThread(ctx, msg);
        case "switch_thread": return threadHandlers.handleSwitchThread(ctx, msg);

        // ---- Misc operations ----
        case "preview_error": return miscHandlers.handlePreviewError(ctx, msg);
        case "cancel_queued_message": return miscHandlers.handleCancelQueuedMessage(ctx, msg);
        case "interrupt_claude": return miscHandlers.handleInterruptClaude(ctx);
        case "full_reset": return miscHandlers.handleFullReset(ctx);

        // ---- Complex handlers (kept inline — deep coupling to per-connection state) ----

        case "send_message": {
          // Check auth before spawning — the CLI hangs if not authenticated
          if (!authManager.authenticated) {
            // Re-check in case credentials were added since startup
            authManager.checkCredentials();
          }
          if (!authManager.authenticated) {
            // Send auth_required immediately so the client shows the auth overlay.
            // The OAuth flow runs in the background and will broadcast an updated
            // auth_required with a URL if/when the CLI outputs one.
            send({ type: "auth_required" });
            authManager.startOAuthFlow();
            return;
          }
  
          // Validate images if provided (do this before queue check so we reject bad images immediately)
          const images: ImageAttachment[] | undefined = msg.images && msg.images.length > 0 ? msg.images : undefined;
          if (images) {
            const imageError = validateImages(images);
            if (imageError) {
              send({ type: "error", message: imageError });
              return;
            }
          }
  
          // If Claude is already processing, queue this message and return
          if (isClaudeRunning) {
            messageQueue.push({ text: msg.text, images: msg.images, files: msg.files, permissionMode: msg.permissionMode });
            send({
              type: "message_queued",
              position: messageQueue.length,
              text: msg.text,
            });
            return;
          }
  
          // Kill any stale process (safety net — normally null if not running)
          if (claude) {
            claude.kill();
          }
  
          // Validate and read file attachments from disk if provided
          const fileRefs: FileContextRef[] | undefined = msg.files && msg.files.length > 0 ? msg.files : undefined;
          let validatedFiles: FileAttachment[] = [];
          if (fileRefs) {
            const dir = activeSessionDir ?? workspaceDir;
            const result = await resolveFileAttachments(fileRefs, dir);
            if (result.error) {
              send({ type: "error", message: result.error });
              return;
            }
            validatedFiles = result.files;
          }
  
          const userText = msg.text;
  
          // Determine session context: resume existing or create new
          let agentSessionId: string | undefined;
          if (msg.sessionId) {
            // Resuming an existing session
            // Clear the queue when switching to a different session
            if (activeAppSessionId && msg.sessionId !== activeAppSessionId && messageQueue.length > 0) {
              messageQueue.length = 0;
              send({ type: "queue_updated", queue: [] });
            }
            activateSession(msg.sessionId);
            const session = sessionManager.get(msg.sessionId);
            // Only resume if we have a real Claude CLI session ID (set via system init event).
            // If agentSessionId was never set (e.g. previous attempt hung), start fresh.
            agentSessionId = session?.agentSessionId;
  
            // If session has a workspaceDir but it was deleted, recreate it
            if (session?.workspaceDir) {
              try {
                await fs.access(session.workspaceDir);
              } catch {
                console.log("[server] Recreating missing session directory:", session.workspaceDir);
                await fs.mkdir(session.workspaceDir, { recursive: true });
                const git = createGitManager(session.workspaceDir);
                await git.init();
              }
            }
          } else {
            // New session — create isolated directory
            const { appSessionId, sessionDir } = await createSessionDir(
              userText.slice(0, 80) || "New session",
            );
            activeAppSessionId = appSessionId;
            activeSessionDir = sessionDir;
  
            // Restart file watcher to the new session directory
            fileWatcher.stop();
            fileWatcher.start(sessionDir);
  
            // Check git identity for the new session
            checkGitIdentity(sessionDir);
          }
  
          isClaudeRunning = true;
          await runClaudeWithMessage({
            userText,
            images,
            validatedFiles,
            agentSessionId,
            permissionMode: msg.permissionMode,
            isNewSession: !msg.sessionId,
          });
          break;
        }

        case "answer_question": {
          const answerParts = Object.values(msg.answers);
          const answerText = answerParts.join(", ");
  
          if (!answerText.trim()) {
            send({ type: "error", message: "Answer cannot be empty" });
            return;
          }
  
          if (claude) {
            // Claude is still running — write answer to stdin (it may be blocking on input)
            claude.writeStdin(answerText + "\n");
          } else {
            // Check auth before spawning — the CLI hangs if not authenticated
            if (!authManager.authenticated) {
              authManager.checkCredentials();
            }
            if (!authManager.authenticated) {
              send({ type: "auth_required" });
              authManager.startOAuthFlow();
              return;
            }
  
            // Agent has finished — send the answer as a new prompt with --resume
            turnSummary = "";
            accumulatedText = "";
            accumulatedToolUse = [];
            claude = agentFactory(activeAgentId);
  
            claude.on("log", (source: string, text: string) => {
              broadcastLog(source as "stderr" | "stdout" | "server", text);
            });
  
            // Persist the user answer
            if (activeAppSessionId) {
              chatHistoryManager.append(activeAppSessionId, { role: "user", text: answerText });
            }
  
            // Look up agent session ID for --resume
            const session = activeAppSessionId ? sessionManager.get(activeAppSessionId) : undefined;
            const agentSessionId = session?.agentSessionId ?? activeAppSessionId;
  
            claude.on("event", (event: AgentEvent) => {
              send({ type: "agent_event", event });
  
              // Also send legacy claude_event for backward compatibility
              const legacyEvent = agentEventToClaudeEvent(event);
              if (legacyEvent) {
                send({ type: "claude_event", event: legacyEvent });
              }
  
              if (event.type === "agent_init") {
                if (activeAppSessionId) {
                  sessionManager.setAgentSessionId(activeAppSessionId, event.sessionId);
                  const sess = sessionManager.get(activeAppSessionId);
                  if (sess) {
                    send({ type: "session_started", session: sess });
                  }
                } else {
                  const title = answerText.slice(0, 80) || "Answer";
                  const sess = sessionManager.track(event.sessionId, title);
                  activeAppSessionId = event.sessionId;
                  send({ type: "session_started", session: sess });
                }
  
                // Forward model info to the client
                if (event.model) {
                  send({
                    type: "model_info",
                    model: event.model,
                    contextWindowTokens: getContextWindowSize(event.model),
                  });
                }
              }
  
              if (event.type === "agent_assistant") {
                const text = (event.content ?? [])
                  .filter((b): b is ClaudeContentBlockText => b.type === "text")
                  .map((b) => b.text)
                  .join("");
                if (text) {
                  turnSummary = text;
                  accumulatedText += text;
                }
  
                const toolBlocks = (event.content ?? [])
                  .filter((b): b is ClaudeContentBlockToolUse => b.type === "tool_use");
                if (toolBlocks.length > 0) {
                  accumulatedToolUse.push(...toolBlocks);
                }
              }
  
              if (event.type === "agent_result") {
                if (activeAppSessionId) {
                  sessionManager.setAgentSessionId(activeAppSessionId, event.sessionId);
                  sessionManager.track(activeAppSessionId);
                }
  
                const usageSessionId = activeAppSessionId ?? event.sessionId;
                // Record cost/duration if present
                if (event.cost?.totalUsd !== undefined) {
                  usageManager.record(
                    usageSessionId,
                    event.cost.totalUsd,
                    event.durationMs ?? 0,
                    event.tokens?.input,
                    event.tokens?.output,
                  );
                  const sessionUsage = usageManager.getSessionUsage(usageSessionId);
                  if (sessionUsage) {
                    const tokenTotals = usageManager.getSessionTokenTotals(usageSessionId);
                    send({
                      type: "usage_update",
                      sessionId: sessionUsage.sessionId,
                      totalCostUsd: sessionUsage.totalCostUsd,
                      totalDurationMs: sessionUsage.totalDurationMs,
                      turnCount: sessionUsage.turnCount,
                      lastTurnInputTokens: event.tokens?.input,
                      lastTurnOutputTokens: event.tokens?.output,
                      cumulativeInputTokens: tokenTotals?.cumulativeInputTokens,
                    });
                  }
                }
  
                if (accumulatedText || accumulatedToolUse.length > 0) {
                  chatHistoryManager.append(usageSessionId, {
                    role: "assistant",
                    text: accumulatedText,
                    toolUse: accumulatedToolUse.length > 0 ? accumulatedToolUse : undefined,
                  });
                }
              }
            });
  
            claude.on("done", async (code: number | null) => {
              console.log("[agent] process exited with code", code);
              broadcastLog("server", `Agent process exited with code ${code}`);
              claude = null;
  
              try {
                const git = getActiveGitManager();
                const firstLine = turnSummary.split("\n")[0]?.slice(0, 120) || "Agent turn";
                const hash = await git.autoCommit(firstLine);
                if (hash) {
                  send({ type: "git_committed", hash, message: firstLine });
                  // Schedule auto-push (debounced)
                  scheduleAutoPush(git, send);
                }
              } catch (err) {
                console.error("[git] auto-commit failed:", getErrorMessage(err));
              }
  
              if (!viteManager.running) {
                viteManager.start(getActiveDir());
              }
              await runPortScan();
            });
  
            claude.on("auth_required", () => {
              send({ type: "auth_required" });
              authManager.startOAuthFlow();
            });
  
            claude.on("error", (err: Error) => {
              console.error("[agent] process error:", err.message);
              broadcastLog("server", `Agent process error: ${err.message}`);
              send({ type: "error", message: `Agent process error: ${err.message}` });
              if (activeAppSessionId) {
                chatHistoryManager.append(activeAppSessionId, {
                  role: "assistant",
                  text: `Error: ${err.message}`,
                  isError: true,
                });
              }
              claude = null;
            });
  
            const systemPrompt = await readSystemPrompt();
            claude.run({
              prompt: answerText,
              sessionId: agentSessionId,
              systemPrompt,
              cwd: getActiveDir(),
            });
            broadcastLog("server", "Agent process started");
          }
          break;
        }

        case "home_send_with_repo": {
          // Check auth before spawning
          if (!authManager.authenticated) {
            authManager.checkCredentials();
          }
          if (!authManager.authenticated) {
            send({ type: "auth_required" });
            authManager.startOAuthFlow();
            return;
          }
  
          if (claude) {
            claude.kill();
          }
  
          let repoUrl = typeof msg.repoUrl === "string" ? msg.repoUrl.trim() : "";
          const text = typeof msg.text === "string" ? msg.text.trim() : "";
          if (!repoUrl) {
            send({ type: "error", message: "Repository URL is required" });
            return;
          }
          if (!text) {
            send({ type: "error", message: "Message text is required" });
            return;
          }
          if (text.length > 10000) {
            send({ type: "error", message: "Message too long (max 10000 characters)" });
            return;
          }
  
          // Support owner/repo shorthand
          if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repoUrl)) {
            repoUrl = `https://github.com/${repoUrl}.git`;
          }
  
          // Validate images if provided
          const images: ImageAttachment[] | undefined = msg.images && msg.images.length > 0 ? msg.images : undefined;
          if (images) {
            const imageError = validateImages(images);
            if (imageError) {
              send({ type: "error", message: imageError });
              return;
            }
          }
  
          // Validate file attachments
          const fileRefs: FileContextRef[] | undefined = msg.files && msg.files.length > 0 ? msg.files : undefined;
          let validatedFiles: FileAttachment[] = [];
          if (fileRefs) {
            const dir = activeSessionDir ?? workspaceDir;
            const result = await resolveFileAttachments(fileRefs, dir);
            if (result.error) {
              send({ type: "error", message: result.error });
              return;
            }
            validatedFiles = result.files;
          }
  
          try {
            // Shared repo dir — one clone per repo URL, all sessions are worktrees
            const repoDir = getSharedRepoDir(repoUrl);
            const repoExists = await fs.stat(repoDir).then(() => true, () => false);
  
            if (!repoExists) {
              // First time: clone into shared repo dir
              await fs.mkdir(repoDir, { recursive: true });
              const cloneUrl = githubAuthManager.getAuthenticatedCloneUrl(repoUrl);
              const repoGit = createGitManager(repoDir);
              await repoGit.clone(cloneUrl);
              console.log("[home] Cloned repo to shared dir:", repoDir);
            } else {
              // Fetch latest from remote so the worktree starts up-to-date
              try {
                const repoGit = createGitManager(repoDir);
                await repoGit.fetch("origin");
              } catch (err) {
                console.warn("[home] Fetch in shared repo failed (continuing):", getErrorMessage(err));
              }
            }
  
            // Create session dir (skip git init — worktree handles this)
            const branchPrefix = generateBranchPrefix();
            const created = await createSessionDir(text.slice(0, 80), { skipGitInit: true });
            const appSessionId = created.appSessionId;
            const sessionDir = created.sessionDir;
  
            // Remove the empty dir (worktree add needs it absent)
            await fs.rm(sessionDir, { recursive: true, force: true });
  
            // Create worktree from shared repo, starting from latest remote default branch
            const repoGit = createGitManager(repoDir);
            let startPoint: string | undefined;
            try {
              const defaultBranch = await repoGit.getDefaultBranch();
              if (defaultBranch && !defaultBranch.includes("(")) {
                startPoint = `origin/${defaultBranch}`;
              }
            } catch {
              // Fallback: let git use HEAD
            }
            await repoGit.createWorktree(sessionDir, branchPrefix, startPoint);
  
            // Configure credentials and identity in the worktree
            if (githubAuthManager.authenticated) {
              githubAuthManager.configureGitCredentials(sessionDir);
            }
            const storedId = gitIdentityStore.get();
            if (storedId) {
              const git = createGitManager(sessionDir);
              await git.setIdentity(storedId.name, storedId.email);
            }
  
            // Store metadata and activate session
            sessionManager.setRemoteUrl(appSessionId, repoUrl);
            sessionManager.setWorktreeInfo(appSessionId, {
              branch: branchPrefix,
              sessionType: "worktree",
            });
            activeAppSessionId = appSessionId;
            activeSessionDir = sessionDir;
            fileWatcher.stop();
            fileWatcher.start(sessionDir);
  
            const session = sessionManager.get(appSessionId);
            if (session) {
              send({ type: "session_started", session });
            }
  
            // Fire non-blocking Claude call to generate session name + branch slug
            generateSessionName(text, sessionDir).then(async (nameResult) => {
              if (!nameResult) return;
              try {
                const newBranchName = `${branchPrefix}-${nameResult.slug}`;
                const sessionGit = createGitManager(sessionDir);
                await sessionGit.renameBranch(branchPrefix, newBranchName);
                sessionManager.rename(appSessionId, nameResult.title);
                sessionManager.setWorktreeInfo(appSessionId, {
                  branch: newBranchName,
                  sessionType: "worktree",
                });
                const finalSession = sessionManager.get(appSessionId);
                if (finalSession) {
                  send({ type: "session_renamed", session: finalSession });
                }
              } catch (err) {
                console.warn("[home] Branch rename failed:", getErrorMessage(err));
              }
            }).catch((err) => {
              console.warn("[home] Session naming failed:", err);
            });
  
            // Run Claude with the user's message
            await runClaudeWithMessage({
              userText: text,
              images,
              validatedFiles,
              permissionMode: msg.permissionMode,
              isNewSession: true,
            });
          } catch (err) {
            send({ type: "error", message: `Failed to setup repo: ${getErrorMessage(err)}` });
          }
          break;
        }
      }
    });

    socket.on("close", () => {
      console.log("[ws] client disconnected");
      clients.delete(socket);
      if (claude) {
        claude.kill();
        claude = null;
      }
      if (terminal) {
        terminal.kill();
        terminal = null;
      }
      if (pushTimer) {
        clearTimeout(pushTimer);
        pushTimer = null;
      }
      // Clear the queue — it belongs to this connection's context
      messageQueue.length = 0;
      isClaudeRunning = false;

      // Stop periodic port scanning when the last client disconnects
      if (clients.size === 0) {
        stopPortScanInterval();
      }
    });
  });

  // Graceful shutdown — register once via app hook rather than per-call
  // process.on() to avoid MaxListeners warnings when buildApp() is called
  // repeatedly in tests.
  app.addHook("onClose", async () => {
    stopPortScanInterval();
    fileWatcher.stop();
    viteManager.stop();
    authManager.kill();
  });

  return app;
}

// Only start the server when this file is the entry point (not when imported by tests).
// Vitest sets process.env.VITEST; alternatively check import.meta.url vs process.argv[1].
if (!process.env.VITEST) {
  // Snapshot which ports are already listening before the session starts.
  // These belong to the host system (e.g. ShipIt's own Vite dev server, or
  // other tooling) and should never appear in the user-facing preview tab.
  const baselinePorts = await snapshotBaselinePorts();
  if (baselinePorts.length > 0) {
    console.log("[server] baseline ports (will be excluded from preview):", baselinePorts);
  }

  const app = await buildApp({ serveStatic: true, startVite: true, baselinePorts });

  const shutdown = () => {
    app.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  const port = Number(process.env.PORT) || 3000;
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`[server] listening on http://0.0.0.0:${port}`);
}
