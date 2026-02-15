import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeProcess } from "./claude.js";
import { ViteManager } from "./vite-manager.js";
import { GitManager } from "./git.js";
import { AuthManager } from "./auth.js";
import type { WsClientMessage, WsServerMessage, ClaudeEvent } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = Fastify({ logger: true });

  await app.register(fastifyWebsocket);

  // ---- Git manager ----
  const gitManager = new GitManager();
  await gitManager.init();

  // ---- Vite dev server manager ----
  const viteManager = new ViteManager();

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
        claude = new ClaudeProcess();

        claude.on("event", (event: ClaudeEvent) => {
          send({ type: "claude_event", event });

          // Collect assistant text for commit message
          if (event.type === "assistant") {
            const text = (event.message?.content ?? [])
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("");
            if (text) turnSummary = text;
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
