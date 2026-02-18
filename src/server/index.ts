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
import { listTemplates, getTemplate, applyTemplate } from "./templates.js";
import { FeatureManager } from "./features.js";
import { ThreadManager } from "./threads.js";
import { DeploymentManager } from "./deployment-manager.js";
import { DeploymentStore } from "./deployment-store.js";
import { VercelTarget } from "./deploy-targets/vercel.js";
import { CloudflareTarget } from "./deploy-targets/cloudflare.js";
import { TerminalProcess } from "./terminal.js";
import type { WsClientMessage, WsServerMessage, WsLogEntry, ClaudeEvent, ClaudeResultEvent, ClaudeContentBlock, ClaudeContentBlockText, ClaudeContentBlockToolUse, ImageAttachment, FileAttachment, FileContextRef, PermissionMode } from "./types.js";

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Map model identifiers to context window sizes. */
export function getContextWindowSize(model: string): number {
  if (model.includes("opus")) return 200_000;
  if (model.includes("sonnet")) return 200_000;
  if (model.includes("haiku")) return 200_000;
  return 200_000;
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

// ---- File attachment validation constants ----
const MAX_FILE_SIZE_BYTES = 100 * 1024; // 100 KB per file
const MAX_TOTAL_FILE_SIZE_BYTES = 500 * 1024; // 500 KB total
const MAX_FILES_PER_MESSAGE = 10;

/**
 * Format file attachments as <file> tags for Claude's prompt context.
 */
function formatFileContext(files: FileAttachment[]): string {
  return files.map(f => {
    const lineRange = f.startLine && f.endLine
      ? ` lines="${f.startLine}-${f.endLine}"`
      : "";
    const header = `<file path="${f.path}"${lineRange}>`;
    return `${header}\n${f.content}\n</file>`;
  }).join("\n\n");
}

/**
 * Validate and read file attachments from disk. The client sends only paths;
 * the server reads the content and validates sizes.
 */
async function resolveFileAttachments(
  refs: FileContextRef[],
  sessionDir: string,
): Promise<{ files: FileAttachment[]; error: string | null }> {
  if (!Array.isArray(refs) || refs.length === 0) {
    return { files: [], error: null };
  }

  if (refs.length > MAX_FILES_PER_MESSAGE) {
    return { files: [], error: `Maximum ${MAX_FILES_PER_MESSAGE} file attachments per message` };
  }

  const validated: FileAttachment[] = [];
  let totalSize = 0;

  for (const ref of refs) {
    const filePath = typeof ref.path === "string" ? ref.path.trim() : "";
    if (!filePath) {
      return { files: [], error: "File path is required" };
    }

    // Path traversal check
    const resolved = path.resolve(sessionDir, filePath);
    if (!resolved.startsWith(sessionDir + "/") && resolved !== sessionDir) {
      return { files: [], error: `Invalid file path: ${filePath}` };
    }

    let content: string;
    try {
      content = await fs.readFile(resolved, "utf-8");
    } catch {
      return { files: [], error: `File not found: ${filePath}` };
    }

    const size = Buffer.byteLength(content, "utf-8");

    if (size > MAX_FILE_SIZE_BYTES) {
      return { files: [], error: `File too large: ${filePath} (max 100KB per file)` };
    }

    totalSize += size;
    if (totalSize > MAX_TOTAL_FILE_SIZE_BYTES) {
      return { files: [], error: "Total file attachments exceed 500KB" };
    }

    validated.push({
      path: filePath,
      content,
    });
  }

  return { files: validated, error: null };
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

  // ---- Text generation (AI-powered features) ----
  const generateText = deps.generateText ?? ((prompt: string, cwd?: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const cp = claudeFactory();
      let text = "";
      cp.on("event", (event: ClaudeEvent) => {
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "text") text += block.text;
          }
        }
      });
      cp.on("done", (exitCode: number) => {
        if (exitCode === 0 || text.length > 0) {
          resolve(text);
        } else {
          reject(new Error("Claude process exited with code " + exitCode));
        }
      });
      cp.on("error", (err: Error) => reject(err));
      cp.run(prompt, undefined, undefined, undefined, cwd, "auto");
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
    threadManager.init(appSessionId);
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
      }, 5000);
    };
    // Per-connection interactive terminal
    let terminal: TerminalProcess | null = null;

    // Per-connection active session state
    let activeAppSessionId: string | undefined;
    let activeSessionDir: string | null = null;
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
    const checkGitIdentity = async (sessionDir: string) => {
      try {
        const git = createGitManager(sessionDir);
        const has = await git.hasIdentity();
        if (!has) {
          send({ type: "git_identity_required" });
        }
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
          // Send auth_required immediately so the client shows the auth overlay.
          // The OAuth flow runs in the background and will broadcast an updated
          // auth_required with a URL if/when the CLI outputs one.
          send({ type: "auth_required" });
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

        turnSummary = "";
        accumulatedText = "";
        accumulatedToolUse = [];
        let receivedResult = false;
        const userText = msg.text;
        claude = claudeFactory();
        const currentClaude = claude;

        // Relay CLI log lines (PTY merges stdout+stderr) to the terminal panel
        currentClaude.on("log", (source: "stderr" | "stdout" | "server", text: string) => {
          broadcastLog(source as "stderr" | "stdout" | "server", text);
        });

        // Determine session context: resume existing or create new
        let agentSessionId: string | undefined;
        if (msg.sessionId) {
          // Resuming an existing session
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

        // If the claude process was replaced or killed during async session setup, bail out
        if (claude !== currentClaude) {
          return;
        }

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

        currentClaude.on("event", (event: ClaudeEvent) => {
          send({ type: "claude_event", event });

          // Log unrecognized event types for debugging
          const knownTypes = ["system", "assistant", "user", "result"];
          if (!knownTypes.includes(event.type)) {
            console.warn("[claude] Unrecognized event type:", event.type);
            broadcastLog("server", `Unknown Claude event type: ${event.type}`);
          }

          // Track agent session when we get the session_id from init event
          if (event.type === "system" && event.subtype === "init" && event.session_id) {
            if (activeAppSessionId) {
              // Store the agent's conversation ID on the app session
              sessionManager.setAgentSessionId(activeAppSessionId, event.session_id);
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
              send({ type: "session_started", session });
              persistUserMessage(event.session_id);
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
          if (event.type === "assistant") {
            const text = (event.message?.content ?? [])
              .filter((b: ClaudeContentBlock): b is ClaudeContentBlockText => b.type === "text")
              .map((b) => b.text)
              .join("");
            if (text) {
              turnSummary = text;
              accumulatedText += text;
            }

            const toolBlocks = (event.message?.content ?? [])
              .filter((b: ClaudeContentBlock): b is ClaudeContentBlockToolUse => b.type === "tool_use");
            if (toolBlocks.length > 0) {
              accumulatedToolUse.push(...toolBlocks);
            }
          }

          // On result: persist the final assistant message, update session, record usage
          if (event.type === "result") {
            receivedResult = true;
          }
          if (event.type === "result" && event.session_id) {
            const resultEvent = event as ClaudeResultEvent;
            if (activeAppSessionId) {
              sessionManager.setAgentSessionId(activeAppSessionId, event.session_id);
              sessionManager.track(activeAppSessionId);
            }

            const usageSessionId = activeAppSessionId ?? event.session_id;
            // Record cost/duration if present
            if (resultEvent.total_cost_usd !== undefined) {
              usageManager.record(
                usageSessionId,
                resultEvent.total_cost_usd,
                resultEvent.duration_ms ?? 0,
                resultEvent.input_tokens,
                resultEvent.output_tokens,
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
                  lastTurnInputTokens: resultEvent.input_tokens,
                  lastTurnOutputTokens: resultEvent.output_tokens,
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
              // Schedule auto-push (debounced)
              scheduleAutoPush(git, send);
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
          send({ type: "auth_required" });
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
        let prompt = msg.text;
        if (validatedFiles.length > 0) {
          const context = formatFileContext(validatedFiles);
          prompt = `${context}\n\n${prompt}`;
        }

        // Determine permission mode from client message
        const permissionMode: PermissionMode | undefined = msg.permissionMode;
        currentClaude.run(prompt, agentSessionId, systemPrompt, images, getActiveDir(), permissionMode);
        broadcastLog("server", "Claude process started");
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

      if (msg.type === "set_api_key") {
        const key = typeof msg.key === "string" ? msg.key.trim() : "";
        if (!key) {
          send({ type: "error", message: "API key cannot be empty" });
        } else if (!key.startsWith("sk-ant-")) {
          send({ type: "error", message: "Invalid API key format" });
        } else {
          process.env.ANTHROPIC_API_KEY = key;
          authManager.kill(); // Stop any pending OAuth flow
          authManager.checkCredentials(); // Re-check — will now see the API key
          broadcast({ type: "auth_complete" });
        }
      }

      if (msg.type === "paste_auth_code") {
        const code = typeof msg.code === "string" ? msg.code.trim() : "";
        if (!code) {
          send({ type: "error", message: "Authorization code cannot be empty" });
        } else {
          authManager.sendCode(code);
        }
      }

      if (msg.type === "list_sessions") {
        const sessions = sessionManager.list();
        // Lazy-populate remoteUrl for sessions that have a workspace but no cached URL.
        // One-time cost per session; subsequent calls are instant.
        await Promise.all(
          sessions.map(async (session) => {
            if (session.workspaceDir && !session.remoteUrl) {
              try {
                const git = createGitManager(session.workspaceDir);
                const remotes = await git.getRemotes();
                const origin = remotes.find((r) => r.name === "origin");
                if (origin?.url) {
                  sessionManager.setRemoteUrl(session.id, origin.url);
                  session.remoteUrl = origin.url;
                }
              } catch {
                // Workspace may not exist or not be a git repo — skip
              }
            }
          })
        );
        send({ type: "session_list", sessions });
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
        threadManager.delete(msg.sessionId);
        deploymentStore.deleteSession(msg.sessionId);
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

      if (msg.type === "list_features") {
        try {
          const features = await featureManager.list();
          send({ type: "feature_list", features });
        } catch (err) {
          send({ type: "error", message: `Failed to list features: ${getErrorMessage(err)}` });
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
            send({ type: "auth_required" });
            authManager.startOAuthFlow();
            return;
          }

          // Claude has finished — send the answer as a new prompt with --resume
          turnSummary = "";
          accumulatedText = "";
          accumulatedToolUse = [];
          claude = claudeFactory();

          claude.on("log", (source: "stderr" | "stdout" | "server", text: string) => {
            broadcastLog(source as "stderr" | "stdout" | "server", text);
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

              // Forward model info to the client
              if (event.model) {
                send({
                  type: "model_info",
                  model: event.model,
                  contextWindowTokens: getContextWindowSize(event.model),
                });
              }
            }

            if (event.type === "assistant") {
              const text = (event.message?.content ?? [])
                .filter((b: ClaudeContentBlock): b is ClaudeContentBlockText => b.type === "text")
                .map((b) => b.text)
                .join("");
              if (text) {
                turnSummary = text;
                accumulatedText += text;
              }

              const toolBlocks = (event.message?.content ?? [])
                .filter((b: ClaudeContentBlock): b is ClaudeContentBlockToolUse => b.type === "tool_use");
              if (toolBlocks.length > 0) {
                accumulatedToolUse.push(...toolBlocks);
              }
            }

            if (event.type === "result" && event.session_id) {
              const resultEvent = event as ClaudeResultEvent;
              if (activeAppSessionId) {
                sessionManager.setAgentSessionId(activeAppSessionId, event.session_id);
                sessionManager.track(activeAppSessionId);
              }

              const usageSessionId = activeAppSessionId ?? event.session_id;
              // Record cost/duration if present
              if (resultEvent.total_cost_usd !== undefined) {
                usageManager.record(
                  usageSessionId,
                  resultEvent.total_cost_usd,
                  resultEvent.duration_ms ?? 0,
                  resultEvent.input_tokens,
                  resultEvent.output_tokens,
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
                    lastTurnInputTokens: resultEvent.input_tokens,
                    lastTurnOutputTokens: resultEvent.output_tokens,
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
            console.log("[claude] process exited with code", code);
            broadcastLog("server", `Claude process exited with code ${code}`);
            claude = null;

            try {
              const git = getActiveGitManager();
              const firstLine = turnSummary.split("\n")[0]?.slice(0, 120) || "Claude turn";
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
          broadcastLog("server", "Claude process started");
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
            if (name === "origin" && activeAppSessionId) {
              sessionManager.setRemoteUrl(activeAppSessionId, url);
            }
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
                if (activeAppSessionId) {
                  sessionManager.setRemoteUrl(activeAppSessionId, result.cloneUrl);
                }
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

      if (msg.type === "github_create_pr") {
        if (!githubAuthManager.authenticated) {
          send({ type: "error", message: "Not authenticated with GitHub" });
          return;
        }

        const title = typeof msg.title === "string" ? msg.title.trim() : "";
        const body = typeof msg.body === "string" ? msg.body.trim() : "";
        const base = typeof msg.base === "string" ? msg.base.trim() : "";

        if (!title) {
          send({ type: "error", message: "PR title is required" });
          return;
        }
        if (title.length > 256) {
          send({ type: "error", message: "PR title too long (max 256 characters)" });
          return;
        }
        if (!base) {
          send({ type: "error", message: "Base branch is required" });
          return;
        }

        try {
          const git = getActiveGitManager();
          const remotes = await git.getRemotes();
          const origin = remotes.find((r) => r.name === "origin");
          if (!origin) {
            send({ type: "error", message: "No 'origin' remote configured" });
            return;
          }

          const parsed = GitManager.parseGitHubRemote(origin.url);
          if (!parsed) {
            send({ type: "error", message: "Remote URL is not a GitHub repository" });
            return;
          }

          const head = await git.getCurrentBranch();

          const result = await githubAuthManager.createPullRequest({
            owner: parsed.owner,
            repo: parsed.repo,
            title,
            body,
            head,
            base,
            draft: msg.draft,
          });

          send({
            type: "github_pr_created",
            success: result.success,
            url: result.url,
            number: result.number,
            message: result.message,
          });
        } catch (err) {
          send({ type: "error", message: `Failed to create PR: ${getErrorMessage(err)}` });
        }
      }

      if (msg.type === "github_import_repo") {
        if (!githubAuthManager.authenticated) {
          send({ type: "error", message: "Not authenticated with GitHub" });
          return;
        }

        let url = typeof msg.url === "string" ? msg.url.trim() : "";
        if (!url) {
          send({ type: "error", message: "Repository URL is required" });
          return;
        }

        // Support "owner/repo" shorthand → full HTTPS URL
        if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(url)) {
          url = `https://github.com/${url}.git`;
        }

        // Validate URL format
        if (!url.startsWith("https://") && !url.startsWith("git@")) {
          send({ type: "error", message: "Invalid repository URL" });
          return;
        }

        try {
          // 1. Create a new session
          send({ type: "github_import_progress", stage: "cloning", message: "Creating session..." });
          const importSessionId = crypto.randomUUID();
          const importSessionDir = path.join(sessionsRoot, importSessionId);
          await fs.mkdir(importSessionDir, { recursive: true });

          // 2. Clone the repo
          send({ type: "github_import_progress", stage: "cloning", message: "Cloning repository..." });
          const git = createGitManager(importSessionDir);
          await git.clone(url, msg.branch || undefined);

          // 3. Configure credentials for push
          if (githubAuthManager.authenticated) {
            githubAuthManager.configureGitCredentials(importSessionDir);
          }

          // 4. Register session
          const repoName = url.split("/").pop()?.replace(".git", "") ?? "imported-repo";
          sessionManager.track(importSessionId, repoName, importSessionDir);
          sessionManager.setRemoteUrl(importSessionId, url);
          threadManager.init(importSessionId);

          // 5. Detect and install dependencies
          const pkgJsonPath = path.join(importSessionDir, "package.json");
          const hasPkg = await fs.access(pkgJsonPath).then(() => true).catch(() => false);
          if (hasPkg) {
            send({ type: "github_import_progress", stage: "installing", message: "Installing dependencies..." });
          }

          send({ type: "github_import_progress", stage: "ready", message: "Import complete" });
          send({
            type: "github_import_complete",
            success: true,
            sessionId: importSessionId,
            message: `Imported ${repoName} successfully`,
          });
        } catch (err) {
          send({
            type: "github_import_complete",
            success: false,
            message: `Import failed: ${getErrorMessage(err)}`,
          });
        }
      }

      if (msg.type === "github_search_repos") {
        const query = typeof msg.query === "string" ? msg.query.trim() : "";
        if (!query || query.length < 2) {
          send({ type: "github_search_results", repos: [] });
          return;
        }

        const repos = await githubAuthManager.searchRepos(query);
        send({ type: "github_search_results", repos });
      }

      if (msg.type === "get_pr_status") {
        if (!githubAuthManager.authenticated) {
          send({ type: "pr_status", pr: null });
          return;
        }

        try {
          const git = getActiveGitManager();
          const remotes = await git.getRemotes();
          const origin = remotes.find((r) => r.name === "origin");
          if (!origin) {
            send({ type: "pr_status", pr: null });
            return;
          }

          const parsed = GitManager.parseGitHubRemote(origin.url);
          if (!parsed) {
            send({ type: "pr_status", pr: null });
            return;
          }

          const head = await git.getCurrentBranch();
          const pr = await githubAuthManager.findPullRequest(parsed.owner, parsed.repo, head);

          if (!pr) {
            send({ type: "pr_status", pr: null });
            return;
          }

          const stats = await git.diffStatVsBranch(pr.base);
          const checks = await githubAuthManager.getCheckStatus(parsed.owner, parsed.repo, head);

          send({
            type: "pr_status",
            pr: {
              url: pr.url,
              number: pr.number,
              title: pr.title,
              baseBranch: pr.base,
              headBranch: head,
              insertions: stats.insertions,
              deletions: stats.deletions,
              checks,
              autoMergeEnabled: false,
              mergeable: true,
            },
          });
        } catch {
          send({ type: "pr_status", pr: null });
        }
      }

      if (msg.type === "merge_pr") {
        if (!githubAuthManager.authenticated) {
          send({ type: "merge_pr_result", success: false, message: "Not authenticated with GitHub" });
          return;
        }

        try {
          const git = getActiveGitManager();
          const remotes = await git.getRemotes();
          const origin = remotes.find((r) => r.name === "origin");
          if (!origin) {
            send({ type: "merge_pr_result", success: false, message: "No origin remote configured" });
            return;
          }

          const parsed = GitManager.parseGitHubRemote(origin.url);
          if (!parsed) {
            send({ type: "merge_pr_result", success: false, message: "Remote URL is not a GitHub repository" });
            return;
          }

          const head = await git.getCurrentBranch();
          const pr = await githubAuthManager.findPullRequest(parsed.owner, parsed.repo, head);
          if (!pr) {
            send({ type: "merge_pr_result", success: false, message: "No active PR for current branch" });
            return;
          }

          const method = msg.method || "merge";

          // First, try direct merge
          const result = await githubAuthManager.mergePullRequest(parsed.owner, parsed.repo, pr.number, method);

          if (result.success) {
            send({ type: "merge_pr_result", success: true, message: "Pull request merged" });
            send({ type: "pr_status", pr: null });
            return;
          }

          // If merge failed because checks are pending, enable auto-merge
          const checks = await githubAuthManager.getCheckStatus(parsed.owner, parsed.repo, head);
          if (checks.state === "pending") {
            const graphqlMethod = method === "merge" ? "MERGE" as const : method === "squash" ? "SQUASH" as const : "REBASE" as const;
            const autoResult = await githubAuthManager.enableAutoMerge(parsed.owner, parsed.repo, pr.number, graphqlMethod);
            send({
              type: "merge_pr_result",
              success: autoResult.success,
              message: autoResult.message,
              autoMergeEnabled: autoResult.success,
            });
            return;
          }

          // Checks failed or other issue
          send({ type: "merge_pr_result", success: false, message: result.message });
        } catch (err) {
          send({ type: "merge_pr_result", success: false, message: `Merge failed: ${getErrorMessage(err)}` });
        }
      }

      if (msg.type === "github_list_branches") {
        try {
          const git = getActiveGitManager();
          const current = await git.getCurrentBranch();
          let remote: string[] = [];
          try {
            remote = await git.listRemoteBranches();
          } catch {
            // No remote branches (e.g., never pushed) — that's fine
          }
          send({ type: "github_branches", current, remote });
        } catch (err) {
          send({ type: "error", message: `Failed to list branches: ${getErrorMessage(err)}` });
        }
      }

      if (msg.type === "generate_pr_description") {
        try {
          const git = getActiveGitManager();
          const log = await git.log(20);
          const diff = await git.diffSummary();

          if (log.length === 0) {
            send({ type: "generated_pr_description", description: "" });
            return;
          }

          const prompt = [
            "Write a pull request description summarizing these changes.",
            "Format as markdown with ## Summary (1-2 sentences) and ## Changes (bullet points).",
            "Keep it concise — 5-10 bullet points maximum.",
            "Return ONLY the markdown description, no extra commentary.",
            "",
            "Recent commits:",
            ...log.map((c) => `- ${c.message}`),
            "",
            "Files changed:",
            ...(diff.length > 0
              ? diff.map((f) => `- ${f.file} (+${f.insertions} -${f.deletions})`)
              : ["(no file-level diff available)"]),
          ].join("\n");

          const description = await generateText(prompt, activeSessionDir ?? undefined);
          send({ type: "generated_pr_description", description: description.trim() });
        } catch (err) {
          send({ type: "error", message: `Failed to generate description: ${getErrorMessage(err)}` });
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

      // ---- Deployment operations ----

      if (msg.type === "list_deploy_targets") {
        send({ type: "deploy_targets", targets: deploymentManager.getTargets() });
      }

      if (msg.type === "deploy_configure") {
        const targetId = typeof msg.targetId === "string" ? msg.targetId.trim() : "";
        const target = deploymentManager.getTarget(targetId);
        if (!target) {
          send({ type: "error", message: `Unknown deploy target: "${targetId}"` });
          return;
        }

        // Validate credentials against the target's configFields
        const credentials: Record<string, string> = {};
        for (const field of target.info.configFields) {
          const value = typeof msg.credentials?.[field.key] === "string"
            ? msg.credentials[field.key].trim() : "";
          if (field.required && !value) {
            send({ type: "error", message: `${field.label} is required` });
            return;
          }
          if (value.length > 2000) {
            send({ type: "error", message: `${field.label} is too long` });
            return;
          }
          if (value) credentials[field.key] = value;
        }

        if (!activeAppSessionId) {
          send({ type: "error", message: "No active session" });
          return;
        }

        const projectName = typeof msg.projectName === "string" ? msg.projectName.trim() : undefined;
        deploymentStore.saveConfig(activeAppSessionId, { targetId, credentials, projectName });
        send({ type: "deploy_config_saved", targetId });
      }

      if (msg.type === "initiate_deploy") {
        if (!activeSessionDir) {
          send({ type: "error", message: "No active session" });
          return;
        }
        if (deploymentManager.deploying) {
          send({ type: "error", message: "Deployment already in progress" });
          return;
        }

        const targetId = typeof msg.targetId === "string" ? msg.targetId.trim() : "";
        const target = deploymentManager.getTarget(targetId);
        if (!target) {
          send({ type: "error", message: `Unknown deploy target: "${targetId}"` });
          return;
        }

        const environment = msg.environment === "production" ? "production" : "preview";
        const config = deploymentStore.loadConfig(activeAppSessionId!, targetId);
        if (!config) {
          send({ type: "error", message: `No credentials configured for ${target.info.name}. Set up deployment first.` });
          return;
        }

        // Detect framework and build
        broadcast({ type: "deploy_status", phase: "building" });
        const framework = await deploymentManager.detectFramework(activeSessionDir);

        if (framework.buildCommand) {
          const buildOk = await deploymentManager.build(activeSessionDir, framework.buildCommand);
          if (!buildOk) {
            broadcast({ type: "deploy_error", message: "Build failed", phase: "building" });
            return;
          }
        }

        // Deploy (target-agnostic — the manager dispatches to the right target)
        const deployCompleteHandler = async (result: { url: string; targetId: string; environment: "production" | "preview"; durationMs: number }) => {
          // Record in history
          let commitHash: string | undefined;
          let commitMessage: string | undefined;
          try {
            const git = getActiveGitManager();
            const commits = await git.log(1);
            if (commits.length > 0) {
              commitHash = commits[0].hash;
              commitMessage = commits[0].message;
            }
          } catch {
            // ok
          }

          deploymentStore.recordDeployment(activeAppSessionId!, {
            id: crypto.randomUUID(),
            targetId: result.targetId,
            environment: result.environment,
            url: result.url,
            commitHash,
            commitMessage,
            timestamp: new Date().toISOString(),
            durationMs: result.durationMs,
            status: "success",
          });

          broadcast({
            type: "deploy_complete",
            url: result.url,
            targetId: result.targetId,
            environment: result.environment,
            durationMs: result.durationMs,
          });
        };

        // Listen for complete event for this deployment (one-time)
        deploymentManager.once("complete", deployCompleteHandler);

        try {
          await deploymentManager.deploy(targetId, {
            workspaceDir: activeSessionDir,
            outputDir: framework.outputDirectory,
            credentials: config.credentials,
            environment,
            projectName: config.projectName || path.basename(activeSessionDir),
          });
        } catch {
          // Error already emitted via event; remove the complete handler since it didn't fire
          deploymentManager.removeListener("complete", deployCompleteHandler);
        }
      }

      if (msg.type === "get_deploy_history") {
        if (!activeAppSessionId) {
          send({ type: "error", message: "No active session" });
          return;
        }
        const history = deploymentStore.getHistory(activeAppSessionId);
        send({ type: "deploy_history", deployments: history });
      }

      if (msg.type === "cancel_deploy") {
        deploymentManager.cancel();
      }

      if (msg.type === "get_deploy_config") {
        if (!activeAppSessionId) {
          send({ type: "error", message: "No active session" });
          return;
        }
        const targets = deploymentManager.getTargets();
        const configured: Record<string, { configured: boolean; projectName?: string }> = {};
        for (const t of targets) {
          const config = deploymentStore.loadConfig(activeAppSessionId, t.id);
          configured[t.id] = config
            ? { configured: true, projectName: config.projectName }
            : { configured: false };
        }
        send({ type: "deploy_config", targets: configured });
      }

      if (msg.type === "delete_deploy_config") {
        if (!activeAppSessionId) {
          send({ type: "error", message: "No active session" });
          return;
        }
        const targetId = typeof msg.targetId === "string" ? msg.targetId.trim() : "";
        deploymentStore.deleteConfig(activeAppSessionId, targetId);
        send({ type: "deploy_config_saved", targetId });
      }

      // ---- Thread & checkpoint operations ----

      if (msg.type === "list_threads") {
        if (!activeAppSessionId) {
          send({ type: "error", message: "No active session" });
          return;
        }
        const data = threadManager.listThreads(activeAppSessionId);
        send({ type: "thread_list", threads: data.threads, activeThreadId: data.activeThreadId });
      }

      if (msg.type === "create_checkpoint") {
        if (!activeAppSessionId) {
          send({ type: "error", message: "No active session" });
          return;
        }
        const label = typeof msg.label === "string" ? msg.label.trim() : undefined;
        if (label !== undefined && label.length > 200) {
          send({ type: "error", message: "Checkpoint label too long (max 200 characters)" });
          return;
        }

        try {
          const git = getActiveGitManager();
          const commits = await git.log(1);
          const commitHash = commits.length > 0 ? commits[0].hash : "";
          const messages = chatHistoryManager.load(activeAppSessionId);

          const checkpoint = threadManager.createCheckpoint(
            activeAppSessionId,
            messages.length,
            commitHash,
            label || undefined,
          );

          if (!checkpoint) {
            send({ type: "error", message: "Failed to create checkpoint — no active thread" });
            return;
          }

          const activeThread = threadManager.getActiveThread(activeAppSessionId);
          send({
            type: "checkpoint_created",
            checkpoint,
            threadId: activeThread?.id ?? "",
          });
        } catch (err) {
          send({ type: "error", message: `Failed to create checkpoint: ${getErrorMessage(err)}` });
        }
      }

      if (msg.type === "fork_thread") {
        if (!activeAppSessionId) {
          send({ type: "error", message: "No active session" });
          return;
        }
        const checkpointId = typeof msg.checkpointId === "string" ? msg.checkpointId.trim() : "";
        if (!checkpointId) {
          send({ type: "error", message: "Checkpoint ID is required" });
          return;
        }

        const checkpoint = threadManager.getCheckpoint(activeAppSessionId, checkpointId);
        if (!checkpoint) {
          send({ type: "error", message: "Checkpoint not found" });
          return;
        }

        try {
          // Snapshot data BEFORE git rollback. `git reset --hard` reverts all
          // files in the working tree, including thread and chat-history JSON
          // files that live inside the workspace.
          const fullHistory = chatHistoryManager.load(activeAppSessionId);
          const threadMessages = fullHistory.slice(0, checkpoint.messageIndex);
          const threadSnapshot = threadManager.listThreads(activeAppSessionId);

          // Roll back git to the checkpoint's commit
          const git = getActiveGitManager();
          if (checkpoint.commitHash) {
            await git.rollback(checkpoint.commitHash);
          }

          // Restore thread data (may have been reverted by git rollback) and
          // fork the new thread. We call restore to re-persist the snapshot,
          // then forkThread to add the new thread.
          threadManager.restore(activeAppSessionId, threadSnapshot);
          const newThread = threadManager.forkThread(activeAppSessionId, checkpointId);
          if (!newThread) {
            send({ type: "error", message: "Failed to fork thread" });
            return;
          }

          // Build conversation replay for the new thread. When the first
          // message is sent on this fork, the replay is injected as a system
          // prompt so Claude has full context without --resume's hidden history.
          if (threadMessages.length > 0) {
            const replayLines: string[] = [
              "You are continuing a conversation. Here is the conversation so far:\n",
            ];
            for (const m of threadMessages) {
              const label = m.role === "user" ? "User" : "Assistant";
              replayLines.push(`${label}: ${m.text}`);
            }
            replayLines.push("\nContinue from here. The user's next message follows.");
            threadManager.setConversationReplay(
              activeAppSessionId,
              newThread.id,
              replayLines.join("\n"),
            );
          }

          // Save thread-specific chat history
          const threadHistoryKey = `${activeAppSessionId}__${newThread.id}`;
          for (const m of threadMessages) {
            chatHistoryManager.append(threadHistoryKey, m);
          }

          // Restart Vite after git rollback
          viteManager.restart(getActiveDir());

          send({
            type: "thread_forked",
            thread: newThread,
            messages: threadMessages,
          });
        } catch (err) {
          send({ type: "error", message: `Failed to fork thread from checkpoint: ${getErrorMessage(err)}` });
        }
      }

      // ---- Interactive terminal handlers ----

      if (msg.type === "terminal_start") {
        if (!terminal) {
          terminal = new TerminalProcess();
          terminal.on("data", (data: string) => {
            send({ type: "terminal_output", data });
          });
          terminal.on("exit", (code: number | null) => {
            send({ type: "terminal_exit", exitCode: code });
            terminal = null;
          });
          terminal.start(getActiveDir());
        }
      }

      if (msg.type === "terminal_input") {
        if (terminal) {
          terminal.write(msg.data);
        }
      }

      if (msg.type === "terminal_resize") {
        if (terminal) {
          const cols = typeof msg.cols === "number" ? Math.max(1, Math.min(500, msg.cols)) : 80;
          const rows = typeof msg.rows === "number" ? Math.max(1, Math.min(200, msg.rows)) : 24;
          terminal.resize(cols, rows);
        }
      }

      if (msg.type === "switch_thread") {
        if (!activeAppSessionId) {
          send({ type: "error", message: "No active session" });
          return;
        }
        const threadId = typeof msg.threadId === "string" ? msg.threadId.trim() : "";
        if (!threadId) {
          send({ type: "error", message: "Thread ID is required" });
          return;
        }

        // Snapshot thread data before switch (git rollback may revert files)
        const threadSnapshot = threadManager.listThreads(activeAppSessionId);

        const thread = threadManager.switchThread(activeAppSessionId, threadId);
        if (!thread) {
          send({ type: "error", message: "Thread not found" });
          return;
        }

        try {
          // Load conversation for this thread BEFORE any git rollback
          let messages;
          if (thread.parentCheckpointId === null) {
            messages = chatHistoryManager.load(activeAppSessionId);
          } else {
            const threadHistoryKey = `${activeAppSessionId}__${threadId}`;
            messages = chatHistoryManager.load(threadHistoryKey);
          }

          // Roll back git to the thread's parent checkpoint
          if (thread.parentCheckpointId) {
            const checkpoint = threadManager.getCheckpoint(activeAppSessionId, thread.parentCheckpointId);
            if (checkpoint?.commitHash) {
              const git = getActiveGitManager();
              await git.rollback(checkpoint.commitHash);
              // Restore thread data after rollback (git reset may have reverted it)
              threadManager.restore(activeAppSessionId, {
                ...threadSnapshot,
                activeThreadId: threadId,
                threads: threadSnapshot.threads.map((t) => ({
                  ...t,
                  isActive: t.id === threadId,
                })),
              });
              viteManager.restart(getActiveDir());
            }
          }

          send({
            type: "thread_switched",
            thread,
            messages,
          });
        } catch (err) {
          send({ type: "error", message: `Failed to switch thread: ${getErrorMessage(err)}` });
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
