import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ClaudeProcess } from "./claude.js";
import { ViteManager } from "./vite-manager.js";
import { GitManager } from "./git.js";
import { AuthManager } from "./auth.js";
import { SessionManager } from "./sessions.js";
import type { WsClientMessage, WsServerMessage, ClaudeEvent } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WORKSPACE = "/workspace";

/** Recursively find .md files in a directory, skipping node_modules and .git */
async function findMarkdownFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      results.push(...await findMarkdownFiles(path.join(dir, entry.name), relativePath));
    } else if (entry.name.endsWith(".md")) {
      results.push(relativePath);
    }
  }

  return results.sort();
}

async function main() {
  const app = Fastify({ logger: true });

  await app.register(fastifyWebsocket);

  // ---- Git manager ----
  const gitManager = new GitManager();
  await gitManager.init();

  // ---- Vite dev server manager ----
  const viteManager = new ViteManager();

  // ---- Session manager ----
  const sessionManager = new SessionManager();

  // ---- Auth manager ----
  const authManager = new AuthManager();
  const hasCredentials = authManager.checkCredentials();
  console.log("[server] Claude credentials found:", hasCredentials);

  // Track connected WebSocket clients so we can broadcast
  // Using basic type since ws types aren't installed separately
  const clients = new Set<{ readyState: number; send: (data: string) => void }>();

  const broadcast = (msg: WsServerMessage) => {
    const payload = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  };

  const broadcastPreviewStatus = () => {
    const msg: WsServerMessage = {
      type: "preview_status",
      running: viteManager.running,
      port: viteManager.port,
      url: `http://localhost:${viteManager.port}`,
    };
    const payload = JSON.stringify(msg);
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

  // Start the Vite dev server
  viteManager.start();

  // Serve the built client files from dist/client/
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

  // ---- WebSocket route ----
  app.get("/ws", { websocket: true }, (socket) => {
    console.log("[ws] client connected");
    clients.add(socket);
    let claude: ClaudeProcess | null = null;
    let turnSummary = "";

    const send = (msg: WsServerMessage) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(msg));
      }
    };

    // Send current preview status on connect
    send({
      type: "preview_status",
      running: viteManager.running,
      port: viteManager.port,
      url: `http://localhost:${viteManager.port}`,
    });

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
        const userText = msg.text;
        claude = new ClaudeProcess();

        claude.on("event", (event: ClaudeEvent) => {
          send({ type: "claude_event", event });

          // Track session when we get the session_id from init event
          if (event.type === "system" && event.subtype === "init" && event.session_id) {
            const title = userText.slice(0, 80) || "New session";
            const session = sessionManager.track(event.session_id, title);
            send({ type: "session_started", session });
          }

          // Collect assistant text for commit message
          if (event.type === "assistant") {
            const text = (event.message?.content ?? [])
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("");
            if (text) turnSummary = text;
          }

          // Also track session on result event (updates lastUsedAt for resumed sessions)
          if (event.type === "result" && event.session_id) {
            sessionManager.track(event.session_id);
          }
        });

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
          } catch (err: any) {
            console.error("[git] auto-commit failed:", err.message);
          }

          // Restart Vite after Claude finishes in case new files were created
          if (!viteManager.running) {
            viteManager.start();
          }
        });

        claude.on("auth_required", () => {
          console.log("[server] Claude CLI requires authentication, starting OAuth flow");
          send({ type: "error", message: "Authentication required. Starting OAuth flow..." });
          authManager.startOAuthFlow();
        });

        claude.on("error", (err: Error) => {
          console.error("[claude] process error:", err.message);
          send({ type: "error", message: `Claude process error: ${err.message}` });
          claude = null;
        });

        claude.run(msg.text, msg.sessionId);
      }

      if (msg.type === "get_git_log") {
        try {
          const commits = await gitManager.log();
          send({ type: "git_log", commits });
        } catch (err: any) {
          send({ type: "error", message: `Git log failed: ${err.message}` });
        }
      }

      if (msg.type === "rollback") {
        try {
          await gitManager.rollback(msg.commitHash);
          send({ type: "rollback_complete", commitHash: msg.commitHash });

          // Restart Vite after rollback since files changed
          viteManager.restart();
        } catch (err: any) {
          send({ type: "error", message: `Rollback failed: ${err.message}` });
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
        send({ type: "session_list", sessions: sessionManager.list() });
      }

      if (msg.type === "list_docs") {
        try {
          const files = await findMarkdownFiles("/workspace");
          send({ type: "doc_list", files });
        } catch (err: any) {
          send({ type: "error", message: `Failed to list docs: ${err.message}` });
        }
      }

      if (msg.type === "get_doc") {
        try {
          const safePath = path.resolve("/workspace", msg.path);
          if (!safePath.startsWith("/workspace/")) {
            send({ type: "error", message: "Invalid path" });
            return;
          }
          const content = await fs.readFile(safePath, "utf-8");
          send({ type: "doc_content", path: msg.path, content });
        } catch (err: any) {
          send({ type: "error", message: `Failed to read doc: ${err.message}` });
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
    });
  });

  // Graceful shutdown
  const shutdown = () => {
    viteManager.stop();
    authManager.kill();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  const port = Number(process.env.PORT) || 3000;
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`[server] listening on http://0.0.0.0:${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
