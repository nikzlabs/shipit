import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeProcess } from "./claude.js";
import type { WsClientMessage, WsServerMessage, ClaudeEvent } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = Fastify({ logger: true });

  await app.register(fastifyWebsocket);

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
    let claude: ClaudeProcess | null = null;

    const send = (msg: WsServerMessage) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(msg));
      }
    };

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
      if (claude) {
        claude.kill();
        claude = null;
      }
    });
  });

  const port = Number(process.env.PORT) || 3000;
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`[server] listening on http://0.0.0.0:${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
