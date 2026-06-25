import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";

/**
 * Create the Fastify instance and register the transport-level middleware that
 * every route depends on: WebSocket + multipart support and the dev CORS hook.
 *
 * This is pure app assembly — it instantiates and configures the server but
 * registers no application routes (those live in `route-registry.ts`) and wires
 * no managers (that's `bootstrap-managers.ts`). Extracted from `index.ts` as
 * part of the P4 split (docs/201).
 */
export async function createOrchestratorApp(): Promise<FastifyInstance> {
  // Fastify's maxParamLength defaults to 100: a request whose *decoded* path
  // param exceeds it doesn't 404 — it silently falls through to the SPA static
  // handler. The repo-scoped routes (DELETE /api/repos/:url and
  // POST /api/repos/:url/claim-session) carry a full encodeURIComponent'd remote
  // URL in the path, so any URL longer than ~100 chars (long org/repo names, or
  // a credential-bearing URL) makes the repo silently undeletable from the UI.
  // Raise the ceiling so every realistic remote URL routes correctly.
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } });

  await app.register(fastifyWebsocket);
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50 MB per file
      files: 20,                   // max 20 files per request
    },
  });

  // ---- CORS for dev (client on a different port) ----
  app.addHook("onRequest", (request, reply, done) => {
    const origin = request.headers.origin;
    if (origin) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Credentials", "true");
      reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    if (request.method === "OPTIONS") {
      reply.status(204).send();
      return;
    }
    done();
  });

  return app;
}

/**
 * Serve the built client files from `dist/client/` with an SPA fallback.
 * No-op (other than the guard) when `shouldServeStatic` is false — integration
 * tests run with static serving disabled.
 */
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
      // Own the Cache-Control header ourselves; @fastify/static's default
      // (`public, max-age=0`) would otherwise clobber what setHeaders sets.
      cacheControl: false,
      setHeaders: (res, filePath) => {
        // The PWA must always boot the latest code — never a cached shell or a
        // cached (and possibly stale-caching) service worker. The HTML
        // entrypoints and the worker script get `no-store` so a standalone
        // install behaves exactly like a fresh browser tab, paired with the
        // cache-free service worker (public/service-worker.js). Everything else
        // (Vite's content-hashed assets) keeps the prior always-revalidate
        // behavior — no new caching is introduced. See docs/222-pwa-installable.
        if (filePath.endsWith(".html") || filePath.endsWith("service-worker.js")) {
          res.setHeader("Cache-Control", "no-store, must-revalidate");
        } else {
          res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
        }
      },
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
