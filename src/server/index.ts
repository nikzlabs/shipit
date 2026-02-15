import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import fs from "node:fs/promises";
import { ClaudeProcess } from "./claude.js";
import { ViteManager } from "./vite-manager.js";
import { GitManager } from "./git.js";
import { AuthManager } from "./auth.js";
import { SessionManager } from "./sessions.js";
import { ChatHistoryManager } from "./chat-history.js";
import { findMarkdownFiles } from "./markdown.js";
import { scanFileTree } from "./file-tree.js";
import { scanPorts, DEFAULT_SCAN_PORTS } from "./port-scanner.js";
import type { WsClientMessage, WsServerMessage, ClaudeEvent, ClaudeContentBlock, ClaudeContentBlockText, ClaudeContentBlockToolUse } from "./types.js";

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const WORKSPACE = "/workspace";

/**
 * Dependencies that can be injected for testing. Every field is optional —
 * production uses real implementations, tests can supply mocks/stubs.
 */
export interface AppDeps {
  /** Git manager instance. Defaults to `new GitManager()` with init(). */
  gitManager?: GitManager;
  /** Vite dev server manager. Defaults to `new ViteManager()` with auto-start. */
  viteManager?: ViteManager;
  /** Session manager instance. Defaults to `new SessionManager()`. */
  sessionManager?: SessionManager;
  /** Auth manager instance. Defaults to `new AuthManager()`. */
  authManager?: AuthManager;
  /** Chat history manager instance. Defaults to `new ChatHistoryManager()`. */
  chatHistoryManager?: ChatHistoryManager;
  /** Factory for creating ClaudeProcess instances. Defaults to `() => new ClaudeProcess()`. */
  claudeFactory?: () => ClaudeProcess;
  /** Workspace directory for doc file operations. Defaults to `/workspace`. */
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
  } = deps;

  const app = Fastify({ logger: false });

  await app.register(fastifyWebsocket);

  // ---- Git manager ----
  const gitManager = deps.gitManager ?? new GitManager();
  if (!deps.gitManager) {
    await gitManager.init();
  }

  // ---- Vite dev server manager ----
  const viteManager = deps.viteManager ?? new ViteManager();

  // ---- Session manager ----
  const sessionManager = deps.sessionManager ?? new SessionManager();

  // ---- Chat history manager ----
  const chatHistoryManager = deps.chatHistoryManager ?? new ChatHistoryManager();

  // ---- Auth manager ----
  const authManager = deps.authManager ?? new AuthManager();
  const hasCredentials = authManager.checkCredentials();
  console.log("[server] Claude credentials found:", hasCredentials);

  // Track connected WebSocket clients so we can broadcast
  const clients = new Set<{ readyState: number; send: (data: string) => void }>();

  const broadcast = (msg: WsServerMessage) => {
    const payload = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  };

  // Track all auto-detected dev server ports (non-Vite)
  let detectedPorts: number[] = [];

  /**
   * Run a port scan and broadcast if the set of detected ports changed.
   * Shared between the post-turn scan and the periodic interval scanner.
   */
  const runPortScan = async () => {
    try {
      const excludeList = [serverPort, viteManager.port];
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
    let currentSessionId: string | undefined;
    // Accumulate the assistant response across streaming events for persistence
    let accumulatedText = "";
    let accumulatedToolUse: Array<{ type: "tool_use"; id: string; name: string; input: Record<string, unknown> }> = [];

    const send = (msg: WsServerMessage) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(msg));
      }
    };

    // Send current preview status on connect
    send(getPreviewStatus());

    socket.on("message", async (raw: Buffer) => {
      let msg: WsClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send({ type: "error", message: "Invalid JSON" });
        return;
      }

      if (msg.type === "send_message") {
        // Kill any existing process before starting a new one
        if (claude) {
          claude.kill();
        }

        turnSummary = "";
        accumulatedText = "";
        accumulatedToolUse = [];
        const userText = msg.text;
        claude = claudeFactory();

        // If the client already knows the session, use it for persistence
        if (msg.sessionId) {
          currentSessionId = msg.sessionId;
        }

        // Persist the user message once we know the session
        const persistUserMessage = (sessionId: string) => {
          chatHistoryManager.append(sessionId, { role: "user", text: userText });
        };

        claude.on("event", (event: ClaudeEvent) => {
          send({ type: "claude_event", event });

          // Track session when we get the session_id from init event
          if (event.type === "system" && event.subtype === "init" && event.session_id) {
            currentSessionId = event.session_id;
            const title = userText.slice(0, 80) || "New session";
            const session = sessionManager.track(event.session_id, title);
            send({ type: "session_started", session });
            // Now we know the session ID — persist the user message
            persistUserMessage(event.session_id);
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

          // On result: persist the final assistant message and update session
          if (event.type === "result" && event.session_id) {
            currentSessionId = event.session_id;
            sessionManager.track(event.session_id);

            // For resumed sessions, the user message was persisted on send_message
            // if currentSessionId was already set. For new sessions, it was persisted
            // in the system.init handler above. Now persist the assistant response.
            if (accumulatedText || accumulatedToolUse.length > 0) {
              chatHistoryManager.append(event.session_id, {
                role: "assistant",
                text: accumulatedText,
                toolUse: accumulatedToolUse.length > 0 ? accumulatedToolUse : undefined,
              });
            }
          }
        });

        // For resumed sessions (sessionId already known), persist user message immediately
        if (msg.sessionId) {
          persistUserMessage(msg.sessionId);
        }

        claude.on("done", async (code: number | null) => {
          console.log("[claude] process exited with code", code);
          claude = null;

          // Auto-commit after Claude turn
          try {
            const firstLine = turnSummary.split("\n")[0]?.slice(0, 120) || "Claude turn";
            const hash = await gitManager.autoCommit(firstLine);
            if (hash) {
              send({ type: "git_committed", hash, message: firstLine });
            }
          } catch (err) {
            console.error("[git] auto-commit failed:", getErrorMessage(err));
          }

          // Restart Vite after Claude finishes in case new files were created
          if (!viteManager.running) {
            viteManager.start();
          }

          // Scan for non-Vite dev servers that Claude may have started.
          await runPortScan();
        });

        claude.on("auth_required", () => {
          console.log("[server] Claude CLI requires authentication, starting OAuth flow");
          send({ type: "error", message: "Authentication required. Starting OAuth flow..." });
          authManager.startOAuthFlow();
        });

        claude.on("error", (err: Error) => {
          console.error("[claude] process error:", err.message);
          const errorMsg = `Claude process error: ${err.message}`;
          send({ type: "error", message: errorMsg });
          // Persist the error so it shows up in history
          if (currentSessionId) {
            chatHistoryManager.append(currentSessionId, {
              role: "assistant",
              text: `Error: ${err.message}`,
              isError: true,
            });
          }
          claude = null;
        });

        claude.run(msg.text, msg.sessionId);
      }

      if (msg.type === "get_git_log") {
        try {
          const commits = await gitManager.log();
          send({ type: "git_log", commits });
        } catch (err) {
          send({ type: "error", message: `Git log failed: ${getErrorMessage(err)}` });
        }
      }

      if (msg.type === "rollback") {
        try {
          await gitManager.rollback(msg.commitHash);
          send({ type: "rollback_complete", commitHash: msg.commitHash });

          // Restart Vite after rollback since files changed
          viteManager.restart();
        } catch (err) {
          send({ type: "error", message: `Rollback failed: ${getErrorMessage(err)}` });
        }
      }

      if (msg.type === "list_sessions") {
        send({ type: "session_list", sessions: sessionManager.list() });
      }

      if (msg.type === "new_session") {
        // Client clears its sessionId — next send_message will start a fresh session
        send({ type: "session_list", sessions: sessionManager.list() });
      }

      if (msg.type === "delete_session") {
        sessionManager.delete(msg.sessionId);
        chatHistoryManager.delete(msg.sessionId);
        send({ type: "session_list", sessions: sessionManager.list() });
      }

      if (msg.type === "get_chat_history") {
        const messages = chatHistoryManager.load(msg.sessionId);
        send({ type: "chat_history", sessionId: msg.sessionId, messages });
      }

      if (msg.type === "list_docs") {
        try {
          const files = await findMarkdownFiles(workspaceDir);
          send({ type: "doc_list", files });
        } catch (err) {
          send({ type: "error", message: `Failed to list docs: ${getErrorMessage(err)}` });
        }
      }

      if (msg.type === "get_doc") {
        try {
          const safePath = path.resolve(workspaceDir, msg.path);
          if (!safePath.startsWith(workspaceDir + "/")) {
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
          const tree = await scanFileTree(workspaceDir);
          send({ type: "file_tree", tree });
        } catch (err) {
          send({ type: "error", message: `Failed to scan file tree: ${getErrorMessage(err)}` });
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
    viteManager.stop();
    authManager.kill();
  });

  return app;
}

// Only start the server when this file is the entry point (not when imported by tests).
// Vitest sets process.env.VITEST; alternatively check import.meta.url vs process.argv[1].
if (!process.env.VITEST) {
  const app = await buildApp({ serveStatic: true, startVite: true });

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
