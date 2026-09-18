import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { registerOriginGuard, type OriginPolicy } from "./api-origin-guard.js";
import { framePolicyFor, registerFrameGuard } from "./frame-guard.js";
import type { RuntimeMode } from "../shared/types.js";

export async function createOrchestratorApp(
  originPolicy?: OriginPolicy,
  runtimeMode: RuntimeMode = "containerized",
): Promise<FastifyInstance> {
  // Repo routes carry full remote URLs; Fastify's 100-character default is too short.
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } });

  await app.register(fastifyWebsocket);
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 50 * 1024 * 1024,
      files: 20,
    },
  });

  // The origin guard must precede the container guard and preview proxy.
  registerOriginGuard(app, originPolicy);

  registerFrameGuard(app, framePolicyFor(runtimeMode));

  return app;
}

export async function serveStaticClient(
  app: FastifyInstance,
  clientDir: string,
  shouldServeStatic: boolean,
): Promise<void> {
  if (!shouldServeStatic) return;
  try {
    await app.register(fastifyStatic, {
      root: clientDir,
      prefix: "/",
      wildcard: false,
      // Prevent @fastify/static from overwriting setHeaders' cache policy.
      cacheControl: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".html") || filePath.endsWith("service-worker.js")) {
          res.header("Cache-Control", "no-store, must-revalidate");
        } else {
          res.header("Cache-Control", "public, max-age=0, must-revalidate");
        }
      },
    });
    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile("index.html", clientDir);
    });
  } catch {
    console.log("[server] No built client found at", clientDir);
  }
}
