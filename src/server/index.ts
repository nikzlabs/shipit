import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeProcess } from "./claude.js";
import { ViteManager } from "./vite-manager.js";
import type { WsClientMessage, WsServerMessage, ClaudeEvent } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = Fastify({ logger: true });

  await app.register(fastifyWebsocket);

  // ---- Vite dev server manager ----
  const viteManager = new ViteManager();

  // Track connected WebSocket clients so we can broadcast preview status
  // Using basic type since ws types aren't installed separately
  const clients = new Set<{ readyState: number; send: (data: string) => void }>();

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

    socket.on("message", (raw: Buffer) => {
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

        claude = new ClaudeProcess();

        claude.on("event", (event: ClaudeEvent) => {
          send({ type: "claude_event", event });
        });

        claude.on("done", (code: number | null) => {
          console.log("[claude] process exited with code", code);
          claude = null;

          // Restart Vite after Claude finishes in case new files were created
          // (e.g. Claude scaffolded a new project with package.json + vite config)
          if (!viteManager.running) {
            viteManager.start();
          }
        });

        claude.on("error", (err: Error) => {
          console.error("[claude] process error:", err.message);
          send({ type: "error", message: `Claude process error: ${err.message}` });
          claude = null;
        });

        claude.run(msg.text, msg.sessionId);
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
