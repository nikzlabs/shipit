/**
 * Regression tests for the install gate (docs/162).
 *
 * The orchestrator brackets `_startAgentViaProxy` behind `runInstall`, whose
 * completion promise (`_installComplete`) gates the first turn. Two ways it can
 * settle without hanging:
 *
 *  1. POST /install returns `{ skipped: true }` (marker already present) — the
 *     gate resolves directly from the HTTP response.
 *  2. POST /install returns `{ started: true }` and the SSE-delivered
 *     `install_done` is lost (the production race where the event is consumed
 *     before the resolver is armed). The first-connect `/install/status`
 *     resync must probe the worker, see it settled, and resolve the gate. Before
 *     the fix the resync ran only on RECONNECT, so a headless session hung.
 *
 * The docs/148 lockfile-keyed fast path that originally motivated a third,
 * synchronous `{ completed: true }` resolution was removed in docs/183 Phase 1,
 * so the worker no longer reports `{ completed }` and the gate has just these
 * two settle paths. These tests use small stub workers (no Docker, no real
 * `npm`) to isolate the gate-resolution contract from SSE delivery.
 */
import { describe, it, expect, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { ContainerSessionRunner } from "../container-session-runner.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function waitFor(fn: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms)),
  ]);
}

interface StubOpts {
  /** Response body for POST /install. */
  installResponse: Record<string, unknown>;
  /** GET /install/status body (worker's view). */
  status: { running: boolean; lastResult: { ok: boolean; message?: string; command?: string } | null };
}

/**
 * Minimal stub worker: a valid SSE /events endpoint that stays open but never
 * emits `install_done`, plus configurable POST /install + GET /install/status.
 * This lets us prove the orchestrator resolves the gate WITHOUT any SSE
 * `install_done` — either from the HTTP response or the first-connect
 * `/install/status` resync.
 */
async function startStubWorker(opts: StubOpts): Promise<{ app: FastifyInstance; url: string; agentStarted: () => boolean }> {
  const app = Fastify();
  let agentStarted = false;

  app.post("/install", async () => opts.installResponse);
  app.get("/install/status", async () => opts.status);
  app.get("/agent/status", async () => ({ running: agentStarted }));
  app.post("/agent/start", async () => { agentStarted = true; return { started: true }; });
  app.post("/agent/kill", async () => ({ ok: true }));
  // Catch-all for the various fire-and-forget worker calls the runner makes
  // (terminal/start, file-watcher, preview, secrets) so they don't 404-noise.
  app.post("/*", async () => ({ ok: true }));
  app.get("/events", (request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(": connected\n\n");
    const ka = setInterval(() => { try { reply.raw.write(": keepalive\n\n"); } catch { clearInterval(ka); } }, 1000);
    request.raw.on("close", () => clearInterval(ka));
    // Deliberately never write an `install_done` event.
  });

  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const match = /:(\d+)$/.exec(address);
  return { app, url: `http://127.0.0.1:${match ? Number(match[1]) : 0}`, agentStarted: () => agentStarted };
}

describe("Integration: install gate — resolution without SSE install_done (docs/162)", () => {
  let stub: { app: FastifyInstance; url: string; agentStarted: () => boolean } | null = null;

  afterEach(async () => {
    if (stub) { await stub.app.close(); stub = null; }
    await new Promise((r) => setTimeout(r, 20));
  });

  it("resolves the gate from a { skipped: true } HTTP response and starts the agent", async () => {
    // Marker already present → the worker short-circuits to `{ skipped: true }`.
    // The gate must resolve directly from the response (no SSE event involved),
    // and the agent gate must unblock with NO viewer attached.
    stub = await startStubWorker({
      installResponse: { skipped: true },
      status: { running: false, lastResult: null },
    });

    const runner = new ContainerSessionRunner({
      sessionId: "gate-skipped",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl: stub.url,
    });

    try {
      const result = await withTimeout(runner.runInstall(["npm ci"]), 5000, "runInstall (skipped)");
      expect(result.ok).toBe(true);

      await withTimeout(
        runner._startAgentViaProxy("claude", { prompt: "go", cwd: "/workspace" }),
        5000,
        "_startAgentViaProxy",
      );
      await waitFor(() => stub!.agentStarted(), 3000, "agent started on stub");
    } finally {
      runner.dispose({ force: true });
    }
  });

  it("recovers a lost install_done via the first-connect /install/status resync (streamed path)", async () => {
    // Real-install (streamed) shape: POST /install returns { started: true }
    // and the SSE `install_done` is NEVER delivered (the production race). The
    // first-connect resync must probe /install/status, see it settled, and
    // resolve the gate. Before the fix the resync ran only on RECONNECT, so
    // this hung forever.
    stub = await startStubWorker({
      installResponse: { started: true },
      status: { running: false, lastResult: { ok: true } },
    });

    const runner = new ContainerSessionRunner({
      sessionId: "gate-resync-first-connect",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl: stub.url,
    });

    try {
      const result = await withTimeout(runner.runInstall(["npm install"]), 5000, "runInstall (first-connect resync)");
      expect(result.ok).toBe(true);
    } finally {
      runner.dispose({ force: true });
    }
  });
});
