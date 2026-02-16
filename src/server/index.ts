import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { ClaudeProcess } from "./claude.js";
import { ViteManager } from "./vite-manager.js";
import { GitManager } from "./git.js";
import { AuthManager } from "./auth.js";
import { GitHubAuthManager } from "./github-auth.js";
import { SessionManager } from "./sessions.js";
import { ChatHistoryManager } from "./chat-history.js";
import { findMarkdownFiles } from "./markdown.js";
import { scanFileTree } from "./file-tree.js";
import { scanPorts, snapshotBaselinePorts, DEFAULT_SCAN_PORTS } from "./port-scanner.js";
import { UsageManager } from "./usage.js";
import { FileWatcher } from "./file-watcher.js";
import { BranchManager } from "./branches.js";
import { listTemplates, getTemplate, applyTemplate } from "./templates.js";
import type { WsClientMessage, WsServerMessage, WsLogEntry, ClaudeEvent, ClaudeContentBlock, ClaudeContentBlockText, ClaudeContentBlockToolUse, ImageAttachment } from "./types.js";

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const WORKSPACE = "/workspace";

// ---- Image validation constants ----
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB per image (decoded)
const MAX_IMAGES_PER_MESSAGE = 5;
const MAX_TOTAL_PAYLOAD_BYTES = 20 * 1024 * 1024; // 20 MB total

/**
 * Validate an array of image attachments. Returns an error message string
 * if validation fails, or null if all images are valid.
 */
function validateImages(images: ImageAttachment[]): string | null {
  if (images.length > MAX_IMAGES_PER_MESSAGE) {
    return `Too many images (max ${MAX_IMAGES_PER_MESSAGE}, got ${images.length})`;
  }

  let totalBytes = 0;

  for (let i = 0; i < images.length; i++) {
    const img = images[i];

    if (!img.data || typeof img.data !== "string") {
      return `Image ${i + 1}: missing or invalid base64 data`;
    }

    if (!ALLOWED_IMAGE_TYPES.has(img.mediaType)) {
      return `Image ${i + 1}: unsupported type "${img.mediaType}" (allowed: PNG, JPEG, GIF, WebP)`;
    }

    // Validate base64 and check decoded size
    let decodedSize: number;
    try {
      const buf = Buffer.from(img.data, "base64");
      decodedSize = buf.byteLength;
      // Verify the base64 round-trips (catches invalid base64)
      if (buf.toString("base64") !== img.data.replace(/\s/g, "")) {
        return `Image ${i + 1}: invalid base64 encoding`;
      }
    } catch {
      return `Image ${i + 1}: invalid base64 encoding`;
    }

    if (decodedSize > MAX_IMAGE_SIZE_BYTES) {
      return `Image ${i + 1}: too large (${(decodedSize / 1024 / 1024).toFixed(1)} MB, max 5 MB)`;
    }

    totalBytes += decodedSize;
  }

  if (totalBytes > MAX_TOTAL_PAYLOAD_BYTES) {
    return `Total image size too large (${(totalBytes / 1024 / 1024).toFixed(1)} MB, max 20 MB)`;
  }

  return null;
}


function buildConversationReplayPrompt(messages: Array<{ role: "user" | "assistant"; text: string }>): string {
  const transcript = messages
    .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.text}`)
    .join("\n\n");

  return [
    "You are continuing an existing conversation branch.",
    "Use the transcript below as context, then continue with the new user prompt.",
    transcript || "(No prior messages)",
  ].join("\n\n");
}

/**
 * Dependencies that can be injected for testing. Every field is optional —
 * production uses real implementations, tests can supply mocks/stubs.
 */
export interface AppDeps {
  /**
   * Legacy single git manager instance. Used as fallback when no per-session
   * directory is active. Defaults to `new GitManager()` with init().
   */
  gitManager?: GitManager;
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
  /** Optional factory for workspace-scoped branch managers. */
  createBranchManager?: (workspaceDir: string) => BranchManager;
  /** Factory for creating ClaudeProcess instances. Defaults to `() => new ClaudeProcess()`. */
  claudeFactory?: () => ClaudeProcess;
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
    workspaceDir = WORKSPACE,
    serveStatic: shouldServeStatic = true,
    startVite = true,
    detectPorts = (excludePorts: number[]) => scanPorts(DEFAULT_SCAN_PORTS, excludePorts),
    serverPort = 3000,
    portScanIntervalMs = 5000,
    baselinePorts = [],
  } = deps;

  const app = Fastify({ logger: false });

  await app.register(fastifyWebsocket);

  // ---- Per-session directory root ----
  const sessionsRoot = path.join(workspaceDir, "sessions");

  // ---- Git manager (legacy fallback) ----
  const gitManager = deps.gitManager ?? new GitManager();
  if (!deps.gitManager) {
    await gitManager.init();
  }

  // ---- Per-session GitManager factory ----
  const createGitManager = deps.createGitManager ?? ((dir: string) => new GitManager(dir));
  const createBranchManager = deps.createBranchManager ?? ((dir: string) => new BranchManager(path.join(dir, ".vibe-branches", "branches.json")));

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
  const createSessionDir = async (title: string): Promise<{ appSessionId: string; sessionDir: string }> => {
    const appSessionId = crypto.randomUUID();
    const sessionDir = path.join(sessionsRoot, appSessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    // Initialize a fresh git repo for this session
    const git = createGitManager(sessionDir);
    await git.init();

    // Configure GitHub credentials in the new repo if available
    if (githubAuthManager.authenticated) {
      githubAuthManager.configureGitCredentials(sessionDir);
    }

    sessionManager.track(appSessionId, title, sessionDir);
    console.log("[server] Created session directory:", sessionDir);

    return { appSessionId, sessionDir };
  };

  // ---- WebSocket route ----
  app.get("/ws", { websocket: true }, (socket) => {
    console.log("[ws] client connected");
    clients.add(socket);

    // Start periodic port scanning when the first client connects
    if (clients.size === 1) {
      startPortScanInterval();
    }
    let claude: ClaudeProcess | null = null;
    let turnSummary = "";
    // Per-connection active session state
    let activeAppSessionId: string | undefined;
    let activeSessionDir: string | null = null;
    // Accumulate the assistant response across streaming events for persistence
    let accumulatedText = "";
    let accumulatedToolUse: Array<{ type: "tool_use"; id: string; name: string; input: Record<string, unknown> }> = [];
    let replaySystemPrompt: string | undefined;

    const send = (msg: WsServerMessage) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(msg));
      }
    };

    /** Get the effective workspace directory for file operations. */
    const getActiveDir = (): string => activeSessionDir ?? workspaceDir;

    /** Get a GitManager for the active session, or fall back to the legacy instance. */
    const getActiveGitManager = (): GitManager => {
      if (activeSessionDir) {
        return createGitManager(activeSessionDir);
      }
      return gitManager;
    };

    /** Get the branch manager for the active workspace/session directory. */
    const getActiveBranchManager = (): BranchManager => createBranchManager(getActiveDir());

    const sendBranchList = () => {
      const { branches, activeBranchId } = getActiveBranchManager().listBranches();
      send({ type: "branch_list", branches, activeBranchId });
    };

    /**
     * Activate a session by ID — sets activeSessionDir and restarts the
     * file watcher to watch the session's directory.
     */
    const activateSession = (sessionId: string) => {
      const session = sessionManager.get(sessionId);
      activeAppSessionId = sessionId;
      const dir = session?.workspaceDir ?? workspaceDir;
      if (dir !== activeSessionDir) {
        activeSessionDir = dir === workspaceDir ? null : dir;
        // Restart file watcher to the new directory
        fileWatcher.stop();
        fileWatcher.start(getActiveDir());
      }
    };

    // Send current preview status on connect
    send(getPreviewStatus());

    // Send buffered log entries so new clients see existing terminal output
    for (const entry of logBuffer) {
      send(entry);
    }

    // Check if git identity is configured — prompt the user if not
    gitManager.hasIdentity().then((has) => {
      if (!has) {
        send({ type: "git_identity_required" });
      }
    });

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

    socket.on("message", async (raw: Buffer) => {
      let msg: WsClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send({ type: "error", message: "Invalid JSON" });
        return;
      }

      if (msg.type === "send_message") {
        // Check auth before spawning — the CLI hangs if not authenticated
        if (!authManager.authenticated) {
          // Re-check in case credentials were added since startup
          authManager.checkCredentials();
        }
        if (!authManager.authenticated) {
          send({ type: "error", message: "Not authenticated with Claude. Please complete the OAuth flow." });
          authManager.startOAuthFlow();
          return;
        }

        // Kill any existing process before starting a new one
        if (claude) {
          claude.kill();
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

        turnSummary = "";
        accumulatedText = "";
        accumulatedToolUse = [];
        let receivedResult = false;
        const userText = msg.text;
        claude = claudeFactory();
        const currentClaude = claude;
        broadcastLog("server", "Claude process started");

        // Relay CLI stderr and non-JSON stdout lines to the terminal panel
        currentClaude.on("log", (source: "stderr" | "stdout", text: string) => {
          broadcastLog(source, text);
        });

        // Determine session context: resume existing or create new
        let agentSessionId: string | undefined;
        if (msg.sessionId) {
          // Resuming an existing session
          activateSession(msg.sessionId);
          const session = sessionManager.get(msg.sessionId);
          // Prefer stored agent session ID. Only fall back to msg.sessionId when
          // the session record does not exist (legacy behavior).
          agentSessionId = session ? session.agentSessionId : msg.sessionId;

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
        }

        // If the claude process was replaced or killed during async session setup, bail out
        if (claude !== currentClaude) {
          return;
        }

        // Build images metadata for chat history persistence (inline base64)
        const historyImages = images?.map((img) => ({
          data: img.data,
          mediaType: img.mediaType,
        }));

        // Persist the user message once we know the session
        const persistUserMessage = (sessionId: string) => {
          chatHistoryManager.append(sessionId, {
            role: "user",
            text: userText,
            images: historyImages,
          });
        };

        currentClaude.on("event", (event: ClaudeEvent) => {
          send({ type: "claude_event", event });

          // Track agent session when we get the session_id from init event
          if (event.type === "system" && event.subtype === "init" && event.session_id) {
            if (activeAppSessionId) {
              // Store the agent's conversation ID on the app session
              sessionManager.setAgentSessionId(activeAppSessionId, event.session_id);
              getActiveBranchManager().setActiveBranchSessionId(event.session_id);
              replaySystemPrompt = undefined;
              const session = sessionManager.get(activeAppSessionId);
              if (session) {
                send({ type: "session_started", session });
              }
              // Persist the user message for new sessions
              if (!msg.sessionId) {
                persistUserMessage(activeAppSessionId);
              }
            } else {
              // Legacy fallback: no app session created (shouldn't happen with isolation)
              const title = userText.slice(0, 80) || "New session";
              const session = sessionManager.track(event.session_id, title);
              activeAppSessionId = event.session_id;
              getActiveBranchManager().setActiveBranchSessionId(event.session_id);
              replaySystemPrompt = undefined;
              send({ type: "session_started", session });
              persistUserMessage(event.session_id);
            }
          }

          // Collect assistant text and tool use blocks for commit message + persistence
          if (event.type === "assistant") {
            const text = (event.message?.content ?? [])
              .filter((b: ClaudeContentBlock): b is ClaudeContentBlockText => b.type === "text")
              .map((b) => b.text)
              .join("");
            if (text) {
              turnSummary = text;
              accumulatedText = text;
            }

            const toolBlocks = (event.message?.content ?? [])
              .filter((b: ClaudeContentBlock): b is ClaudeContentBlockToolUse => b.type === "tool_use");
            if (toolBlocks.length > 0) {
              accumulatedToolUse = toolBlocks;
            }
          }

          // On result: persist the final assistant message, update session, record usage
          if (event.type === "result") {
            receivedResult = true;
          }
          if (event.type === "result" && event.session_id) {
            if (activeAppSessionId) {
              sessionManager.setAgentSessionId(activeAppSessionId, event.session_id);
              sessionManager.track(activeAppSessionId);
            }

            const usageSessionId = activeAppSessionId ?? event.session_id;
            // Record cost/duration if present
            if (event.total_cost_usd !== undefined) {
              usageManager.record(
                usageSessionId,
                event.total_cost_usd,
                event.duration_ms ?? 0,
              );
              const sessionUsage = usageManager.getSessionUsage(usageSessionId);
              if (sessionUsage) {
                send({
                  type: "usage_update",
                  sessionId: sessionUsage.sessionId,
                  totalCostUsd: sessionUsage.totalCostUsd,
                  totalDurationMs: sessionUsage.totalDurationMs,
                  turnCount: sessionUsage.turnCount,
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
        if (msg.sessionId && activeAppSessionId) {
          persistUserMessage(activeAppSessionId);
        }

        currentClaude.on("done", async (code: number | null) => {
          console.log("[claude] process exited with code", code);
          broadcastLog("server", `Claude process exited with code ${code}`);
          claude = null;

          // If the process exited without producing a result event, notify the
          // client so it can clear the loading state instead of hanging forever.
          if (!receivedResult) {
            const reason = code !== 0
              ? `Claude process exited with code ${code}`
              : "Claude process ended without a response";
            send({ type: "error", message: reason });
          }

          // Auto-commit after Claude turn using the session's git manager
          try {
            const git = getActiveGitManager();
            const firstLine = turnSummary.split("\n")[0]?.slice(0, 120) || "Claude turn";
            const hash = await git.autoCommit(firstLine);
            if (hash) {
              send({ type: "git_committed", hash, message: firstLine });
            }
          } catch (err) {
            console.error("[git] auto-commit failed:", getErrorMessage(err));
          }

          // Restart Vite after Claude finishes in case new files were created
          if (!viteManager.running) {
            viteManager.start(getActiveDir());
          }

          // Scan for non-Vite dev servers that Claude may have started.
          await runPortScan();
        });

        currentClaude.on("auth_required", () => {
          console.log("[server] Claude CLI requires authentication, starting OAuth flow");
          send({ type: "error", message: "Authentication required. Starting OAuth flow..." });
          authManager.startOAuthFlow();
        });

        currentClaude.on("error", (err: Error) => {
          console.error("[claude] process error:", err.message);
          broadcastLog("server", `Claude process error: ${err.message}`);
          const errorMsg = `Claude process error: ${err.message}`;
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

        const projectSystemPrompt = await readSystemPrompt();
        const systemPrompt = [projectSystemPrompt, replaySystemPrompt].filter(Boolean).join("\n\n").trim() || undefined;
        currentClaude.run(msg.text, agentSessionId, systemPrompt, images, getActiveDir());
      }

      if (msg.type === "get_git_log") {
        try {
          const git = getActiveGitManager();
          const commits = await git.log();
          send({ type: "git_log", commits });
        } catch (err) {
          send({ type: "error", message: `Git log failed: ${getErrorMessage(err)}` });
        }
      }

      if (msg.type === "rollback") {
        try {
          const git = getActiveGitManager();
          await git.rollback(msg.commitHash);
          send({ type: "rollback_complete", commitHash: msg.commitHash });

          // Restart Vite after rollback since files changed
          viteManager.restart(getActiveDir());
        } catch (err) {
          send({ type: "error", message: `Rollback failed: ${getErrorMessage(err)}` });
        }
      }

      if (msg.type === "set_git_identity") {
        const name = typeof msg.name === "string" ? msg.name.trim() : "";
        const email = typeof msg.email === "string" ? msg.email.trim() : "";
        if (!name) {
          send({ type: "error", message: "Git user name cannot be empty" });
        } else if (!email) {
          send({ type: "error", message: "Git email cannot be empty" });
        } else if (name.length > 200) {
          send({ type: "error", message: "Git user name is too long (max 200 characters)" });
        } else if (email.length > 200) {
          send({ type: "error", message: "Git email is too long (max 200 characters)" });
        } else {
          try {
            const git = getActiveGitManager();
            await git.setIdentity(name, email);
            send({ type: "git_identity_set", name, email });
          } catch (err) {
            send({ type: "error", message: `Failed to set git identity: ${getErrorMessage(err)}` });
          }
        }
      }

      if (msg.type === "list_sessions") {
        send({ type: "session_list", sessions: sessionManager.list() });
      }

      if (msg.type === "new_session") {
        // Clear active session — next send_message or apply_template will create a new one
        activeAppSessionId = undefined;
        activeSessionDir = null;
        send({ type: "session_list", sessions: sessionManager.list() });
      }

      if (msg.type === "delete_session") {
        // If deleting the active session, clear it
        if (msg.sessionId === activeAppSessionId) {
          activeAppSessionId = undefined;
          activeSessionDir = null;
        }
        // Remove session directory if it has one
        const session = sessionManager.get(msg.sessionId);
        if (session?.workspaceDir) {
          try {
            await fs.rm(session.workspaceDir, { recursive: true, force: true });
            console.log("[server] Deleted session directory:", session.workspaceDir);
          } catch (err) {
            console.error("[server] Failed to delete session directory:", getErrorMessage(err));
          }
        }
        sessionManager.delete(msg.sessionId);
        chatHistoryManager.delete(msg.sessionId);
        usageManager.delete(msg.sessionId);
        send({ type: "session_list", sessions: sessionManager.list() });
      }

      if (msg.type === "rename_session") {
        const trimmed = msg.title.trim();
        if (!trimmed) {
          send({ type: "error", message: "Session title cannot be empty" });
        } else {
          const renamed = sessionManager.rename(msg.sessionId, trimmed);
          if (renamed) {
            send({ type: "session_renamed", session: renamed });
          } else {
            send({ type: "error", message: "Session not found" });
          }
        }
      }

      if (msg.type === "get_chat_history") {
        // Activate the requested session (session switch)
        activateSession(msg.sessionId);
        const messages = chatHistoryManager.load(msg.sessionId);
        send({ type: "chat_history", sessionId: msg.sessionId, messages });
      }

      if (msg.type === "create_checkpoint") {
        if (!activeAppSessionId) {
          send({ type: "error", message: "No active session to checkpoint" });
          return;
        }

        const label = typeof msg.label === "string" ? msg.label.trim() : undefined;
        if (label && label.length > 200) {
          send({ type: "error", message: "Checkpoint label too long (max 200 characters)" });
          return;
        }

        const history = chatHistoryManager.load(activeAppSessionId);
        const messageIndex = msg.messageIndex ?? history.length;
        if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex > history.length) {
          send({ type: "error", message: "Invalid checkpoint message index" });
          return;
        }

        try {
          const git = getActiveGitManager();
          const commits = await git.log(1);
          const commitHash = commits[0]?.hash;
          if (!commitHash) {
            send({ type: "error", message: "Cannot checkpoint before first commit" });
            return;
          }

          const checkpoint = getActiveBranchManager().createCheckpoint(
            activeAppSessionId,
            messageIndex,
            commitHash,
            history.slice(0, messageIndex),
            label,
          );
          send({ type: "checkpoint_created", checkpoint });
          sendBranchList();
        } catch (err) {
          send({ type: "error", message: `Checkpoint failed: ${getErrorMessage(err)}` });
        }
      }

      if (msg.type === "list_branches") {
        sendBranchList();
      }

      if (msg.type === "branch_from_checkpoint") {
        if (!activeAppSessionId) {
          send({ type: "error", message: "No active session to branch" });
          return;
        }

        const checkpointId = typeof msg.checkpointId === "string" ? msg.checkpointId.trim() : "";
        if (!checkpointId) {
          send({ type: "error", message: "checkpointId is required" });
          return;
        }

        try {
          const result = getActiveBranchManager().branchFromCheckpoint(checkpointId, msg.name);
          if (!result) {
            send({ type: "error", message: "Checkpoint not found" });
            return;
          }

          if (result.commitHash) {
            const git = getActiveGitManager();
            await git.rollback(result.commitHash);
          }

          sessionManager.clearAgentSessionId(activeAppSessionId);
          chatHistoryManager.replace(activeAppSessionId, result.messages);
          replaySystemPrompt = buildConversationReplayPrompt(result.messages);

          send({ type: "branch_switched", branchId: result.branch.id, messages: result.messages });
          sendBranchList();
          send({ type: "git_log", commits: await getActiveGitManager().log() });
          viteManager.restart(getActiveDir());
        } catch (err) {
          send({ type: "error", message: `Branch creation failed: ${getErrorMessage(err)}` });
        }
      }

      if (msg.type === "switch_branch") {
        if (!activeAppSessionId) {
          send({ type: "error", message: "No active session to switch branches" });
          return;
        }

        const branchId = typeof msg.branchId === "string" ? msg.branchId.trim() : "";
        if (!branchId) {
          send({ type: "error", message: "branchId is required" });
          return;
        }

        try {
          const result = getActiveBranchManager().switchBranch(branchId);
          if (!result) {
            send({ type: "error", message: "Branch not found" });
            return;
          }

          if (result.commitHash) {
            await getActiveGitManager().rollback(result.commitHash);
          }

          sessionManager.clearAgentSessionId(activeAppSessionId);
          chatHistoryManager.replace(activeAppSessionId, result.messages);
          replaySystemPrompt = buildConversationReplayPrompt(result.messages);

          send({ type: "branch_switched", branchId: result.branch.id, messages: result.messages });
          sendBranchList();
          send({ type: "git_log", commits: await getActiveGitManager().log() });
          viteManager.restart(getActiveDir());
        } catch (err) {
          send({ type: "error", message: `Branch switch failed: ${getErrorMessage(err)}` });
        }
      }

      if (msg.type === "list_docs") {
        try {
          const dir = getActiveDir();
          const files = await findMarkdownFiles(dir);
          send({ type: "doc_list", files });
        } catch (err) {
          send({ type: "error", message: `Failed to list docs: ${getErrorMessage(err)}` });
        }
      }

      if (msg.type === "get_doc") {
        try {
          const dir = getActiveDir();
          const safePath = path.resolve(dir, msg.path);
          if (!safePath.startsWith(dir + "/")) {
            send({ type: "error", message: "Invalid path" });
            return;
          }
          const content = await fs.readFile(safePath, "utf-8");
          send({ type: "doc_content", path: msg.path, content });
        } catch (err) {
          send({ type: "error", message: `Failed to read doc: ${getErrorMessage(err)}` });
        }
      }

      if (msg.type === "get_file_tree") {
        try {
          const dir = getActiveDir();
          const tree = await scanFileTree(dir);
          send({ type: "file_tree", tree });
        } catch (err) {
          send({ type: "error", message: `Failed to scan file tree: ${getErrorMessage(err)}` });
        }
      }

      if (msg.type === "get_file_content") {
        try {
          const dir = getActiveDir();
          const safePath = path.resolve(dir, msg.path);
          if (!safePath.startsWith(dir + "/")) {
            send({ type: "error", message: "Invalid path" });
            return;
          }
          // Guard against large files (>1 MB)
          const stat = await fs.stat(safePath);
          if (stat.size > 1_048_576) {
            send({
              type: "file_content",
              path: msg.path,
              content: `File is too large to display (${(stat.size / 1_048_576).toFixed(1)} MB). Maximum supported size is 1 MB.`,
              isBinary: true,
            });
            return;
          }
          // Read raw bytes to detect binary content
          const buf = await fs.readFile(safePath);
          const hasNullByte = buf.includes(0);
          if (hasNullByte) {
            send({
              type: "file_content",
              path: msg.path,
              content: "Binary file — cannot display.",
              isBinary: true,
            });
            return;
          }
          send({ type: "file_content", path: msg.path, content: buf.toString("utf-8") });
        } catch (err) {
          send({ type: "error", message: `Failed to read file: ${getErrorMessage(err)}` });
        }
      }

      if (msg.type === "answer_question") {
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
            send({ type: "error", message: "Not authenticated with Claude. Please complete the OAuth flow." });
            authManager.startOAuthFlow();
            return;
          }

          // Claude has finished — send the answer as a new prompt with --resume
          turnSummary = "";
          accumulatedText = "";
          accumulatedToolUse = [];
          claude = claudeFactory();
          broadcastLog("server", "Claude process started");

          claude.on("log", (source: "stderr" | "stdout", text: string) => {
            broadcastLog(source, text);
          });

          // Persist the user answer
          if (activeAppSessionId) {
            chatHistoryManager.append(activeAppSessionId, { role: "user", text: answerText });
          }

          // Look up agent session ID for --resume
          const session = activeAppSessionId ? sessionManager.get(activeAppSessionId) : undefined;
          const agentSessionId = session?.agentSessionId ?? activeAppSessionId;

          claude.on("event", (event: ClaudeEvent) => {
            send({ type: "claude_event", event });

            if (event.type === "system" && event.subtype === "init" && event.session_id) {
              if (activeAppSessionId) {
                sessionManager.setAgentSessionId(activeAppSessionId, event.session_id);
                const sess = sessionManager.get(activeAppSessionId);
                if (sess) {
                  send({ type: "session_started", session: sess });
                }
              } else {
                const title = answerText.slice(0, 80) || "Answer";
                const sess = sessionManager.track(event.session_id, title);
                activeAppSessionId = event.session_id;
                send({ type: "session_started", session: sess });
              }
            }

            if (event.type === "assistant") {
              const text = (event.message?.content ?? [])
                .filter((b: ClaudeContentBlock): b is ClaudeContentBlockText => b.type === "text")
                .map((b) => b.text)
                .join("");
              if (text) {
                turnSummary = text;
                accumulatedText = text;
              }

              const toolBlocks = (event.message?.content ?? [])
                .filter((b: ClaudeContentBlock): b is ClaudeContentBlockToolUse => b.type === "tool_use");
              if (toolBlocks.length > 0) {
                accumulatedToolUse = toolBlocks;
              }
            }

            if (event.type === "result" && event.session_id) {
              if (activeAppSessionId) {
                sessionManager.setAgentSessionId(activeAppSessionId, event.session_id);
                sessionManager.track(activeAppSessionId);
              }

              const usageSessionId = activeAppSessionId ?? event.session_id;
              // Record cost/duration if present
              if (event.total_cost_usd !== undefined) {
                usageManager.record(
                  usageSessionId,
                  event.total_cost_usd,
                  event.duration_ms ?? 0,
                );
                const sessionUsage = usageManager.getSessionUsage(usageSessionId);
                if (sessionUsage) {
                  send({
                    type: "usage_update",
                    sessionId: sessionUsage.sessionId,
                    totalCostUsd: sessionUsage.totalCostUsd,
                    totalDurationMs: sessionUsage.totalDurationMs,
                    turnCount: sessionUsage.turnCount,
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
            console.log("[claude] process exited with code", code);
            broadcastLog("server", `Claude process exited with code ${code}`);
            claude = null;

            try {
              const git = getActiveGitManager();
              const firstLine = turnSummary.split("\n")[0]?.slice(0, 120) || "Claude turn";
              const hash = await git.autoCommit(firstLine);
              if (hash) {
                send({ type: "git_committed", hash, message: firstLine });
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
            send({ type: "error", message: "Authentication required. Starting OAuth flow..." });
            authManager.startOAuthFlow();
          });

          claude.on("error", (err: Error) => {
            console.error("[claude] process error:", err.message);
            broadcastLog("server", `Claude process error: ${err.message}`);
            send({ type: "error", message: `Claude process error: ${err.message}` });
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
          claude.run(answerText, agentSessionId, systemPrompt, undefined, getActiveDir());
        }
      }

      if (msg.type === "list_templates") {
        send({ type: "template_list", templates: listTemplates() });
      }

      if (msg.type === "apply_template") {
        const templateId = msg.templateId;
        if (!templateId || typeof templateId !== "string" || !templateId.trim()) {
          send({ type: "error", message: "Template ID is required" });
          return;
        }
        const template = getTemplate(templateId.trim());
        if (!template) {
          send({ type: "error", message: `Unknown template: ${templateId}` });
          return;
        }
        try {
          // If no active session, create one for the template
          if (!activeAppSessionId) {
            const { appSessionId, sessionDir } = await createSessionDir(template.name);
            activeAppSessionId = appSessionId;
            activeSessionDir = sessionDir;

            // Restart file watcher to the new session directory
            fileWatcher.stop();
            fileWatcher.start(sessionDir);

            const session = sessionManager.get(appSessionId);
            if (session) {
              send({ type: "session_started", session });
            }
          }

          const dir = getActiveDir();
          await applyTemplate(template, dir);
          const git = getActiveGitManager();
          await git.autoCommit(`Apply template: ${template.name}`);
          // Restart Vite so it picks up the new project files
          viteManager.restart(dir);
          send({ type: "template_applied", templateId: template.id, name: template.name });
        } catch (err) {
          send({ type: "error", message: `Failed to apply template: ${getErrorMessage(err)}` });
        }
      }

      // ---- GitHub auth operations ----

      if (msg.type === "github_set_token") {
        const token = typeof msg.token === "string" ? msg.token.trim() : "";
        if (!token) {
          send({ type: "error", message: "GitHub token cannot be empty" });
        } else {
          const success = await githubAuthManager.setToken(token);
          if (success) {
            // Configure credentials in the active session's git repo too
            if (activeSessionDir) {
              githubAuthManager.configureGitCredentials(activeSessionDir);
            }
            send({ type: "github_status", ...githubAuthManager.getStatus() });
          } else {
            send({ type: "error", message: "Invalid GitHub token" });
          }
        }
      }

      if (msg.type === "github_get_status") {
        send({ type: "github_status", ...githubAuthManager.getStatus() });
      }

      if (msg.type === "github_push") {
        if (!githubAuthManager.authenticated) {
          send({ type: "error", message: "Not authenticated with GitHub" });
        } else {
          try {
            const git = getActiveGitManager();
            const remote = msg.remote || "origin";
            const branch = msg.branch || undefined;
            const message = await git.push(remote, branch);
            const currentBranch = await git.getCurrentBranch();
            send({ type: "github_push_result", success: true, message, branch: currentBranch });
          } catch (err) {
            send({ type: "github_push_result", success: false, message: `Push failed: ${getErrorMessage(err)}` });
          }
        }
      }

      if (msg.type === "github_pull") {
        if (!githubAuthManager.authenticated) {
          send({ type: "error", message: "Not authenticated with GitHub" });
        } else {
          try {
            const git = getActiveGitManager();
            const remote = msg.remote || "origin";
            const branch = msg.branch || undefined;
            const message = await git.pull(remote, branch);
            send({ type: "github_pull_result", success: true, message });
          } catch (err) {
            send({ type: "github_pull_result", success: false, message: `Pull failed: ${getErrorMessage(err)}` });
          }
        }
      }

      if (msg.type === "github_set_remote") {
        const name = typeof msg.name === "string" ? msg.name.trim() : "";
        const url = typeof msg.url === "string" ? msg.url.trim() : "";
        if (!name || !url) {
          send({ type: "error", message: "Remote name and URL are required" });
        } else {
          try {
            const git = getActiveGitManager();
            await git.addRemote(name, url);
            const remotes = await git.getRemotes();
            send({ type: "github_remotes", remotes });
          } catch (err) {
            send({ type: "error", message: `Failed to set remote: ${getErrorMessage(err)}` });
          }
        }
      }

      if (msg.type === "github_get_remotes") {
        try {
          const git = getActiveGitManager();
          const remotes = await git.getRemotes();
          send({ type: "github_remotes", remotes });
        } catch (err) {
          send({ type: "error", message: `Failed to list remotes: ${getErrorMessage(err)}` });
        }
      }

      if (msg.type === "github_logout") {
        githubAuthManager.clearCredentials();
        send({ type: "github_status", ...githubAuthManager.getStatus() });
      }

      if (msg.type === "github_create_repo") {
        if (!githubAuthManager.authenticated) {
          send({ type: "error", message: "Not authenticated with GitHub" });
        } else {
          const repoName = typeof msg.name === "string" ? msg.name.trim() : "";
          if (!repoName) {
            send({ type: "error", message: "Repository name is required" });
          } else if (!/^[a-zA-Z0-9._-]+$/.test(repoName)) {
            send({ type: "error", message: "Repository name contains invalid characters" });
          } else {
            const result = await githubAuthManager.createRepo(repoName, {
              description: msg.description,
              isPrivate: msg.isPrivate,
            });
            if (result.success && result.cloneUrl) {
              // Auto-configure the remote so the user can push immediately
              try {
                const git = getActiveGitManager();
                await git.addRemote("origin", result.cloneUrl);
              } catch {
                // Remote may already exist — that's fine
              }
            }
            send({
              type: "github_repo_created",
              success: result.success,
              name: result.name,
              fullName: result.fullName,
              url: result.url,
              cloneUrl: result.cloneUrl,
              message: result.message,
            });
          }
        }
      }

      if (msg.type === "get_system_prompt") {
        // System prompt is global (root workspace)
        try {
          const filePath = path.join(workspaceDir, ".shipit", "system-prompt.md");
          const content = await fs.readFile(filePath, "utf-8");
          send({ type: "system_prompt", content: content.trim() });
        } catch {
          // File doesn't exist — no system prompt
          send({ type: "system_prompt", content: "" });
        }
      }

      if (msg.type === "set_system_prompt") {
        // System prompt is global (root workspace)
        const content = msg.content;
        if (typeof content !== "string") {
          send({ type: "error", message: "System prompt must be a string" });
          return;
        }
        if (content.length > 50_000) {
          send({ type: "error", message: "System prompt too long (max 50,000 characters)" });
          return;
        }
        const dir = path.join(workspaceDir, ".shipit");
        const filePath = path.join(dir, "system-prompt.md");
        const trimmed = content.trim();
        if (trimmed) {
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(filePath, trimmed + "\n", "utf-8");
        } else {
          // Empty prompt — delete the file
          try { await fs.unlink(filePath); } catch { /* ok if missing */ }
        }
        send({ type: "system_prompt_saved", content: trimmed });
      }

      if (msg.type === "preview_error") {
        // Validate the preview error message
        const errorMsg = typeof msg.message === "string" ? msg.message : "";
        if (!errorMsg.trim()) {
          send({ type: "error", message: "Preview error message cannot be empty" });
          return;
        }
        if (errorMsg.length > 10_000) {
          send({ type: "error", message: "Preview error message too long (max 10,000 characters)" });
          return;
        }
        // Format the error for the terminal log buffer
        const parts = [errorMsg];
        if (msg.stack && typeof msg.stack === "string") {
          parts.push(msg.stack.slice(0, 5000));
        }
        broadcastLog("preview", parts.join("\n"));
      }

      if (msg.type === "clear_logs") {
        logBuffer = [];
      }

      if (msg.type === "get_usage_stats") {
        send({ type: "usage_stats", stats: usageManager.getStats() });
      }
    });

    socket.on("close", () => {
      console.log("[ws] client disconnected");
      clients.delete(socket);
      if (claude) {
        claude.kill();
        claude = null;
      }

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
