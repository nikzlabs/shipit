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
  /** Delay (ms) before POST /install responds — widens the SSE-connect-vs-POST race window. */
  installDelayMs?: number;
  /** When set, /install/status reports this AFTER POST /install has been served (pre-POST it reports `status`). */
  statusAfterPost?: StubOpts["status"];
  /** When set, broadcast a real SSE `install_done` this many ms after POST /install is served. */
  installDoneAfterPostMs?: number;
}

/**
 * Minimal stub worker: a valid SSE /events endpoint that stays open but never
 * emits `install_done`, plus configurable POST /install + GET /install/status.
 * This lets us prove the orchestrator resolves the gate WITHOUT any SSE
 * `install_done` — either from the HTTP response or the first-connect
 * `/install/status` resync.
 */
async function startStubWorker(opts: StubOpts): Promise<{ app: FastifyInstance; url: string; agentStarted: () => boolean; installPosted: () => boolean; installDoneSent: () => boolean }> {
  const app = Fastify();
  let agentStarted = false;
  let installPosted = false;
  let installDoneSent = false;
  const sseClients = new Set<NodeJS.WritableStream>();

  app.post("/install", async () => {
    if (opts.installDelayMs) await new Promise((r) => setTimeout(r, opts.installDelayMs));
    installPosted = true;
    if (opts.installDoneAfterPostMs !== undefined) {
      setTimeout(() => {
        installDoneSent = true;
        for (const c of sseClients) {
          try { c.write(`event: install_done\ndata: {}\n\n`); } catch { /* closed */ }
        }
      }, opts.installDoneAfterPostMs);
    }
    return opts.installResponse;
  });
  app.get("/install/status", async () => (installPosted && opts.statusAfterPost ? opts.statusAfterPost : opts.status));
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
    sseClients.add(reply.raw);
    const ka = setInterval(() => { try { reply.raw.write(": keepalive\n\n"); } catch { clearInterval(ka); } }, 1000);
    request.raw.on("close", () => { clearInterval(ka); sseClients.delete(reply.raw); });
    // Writes an `install_done` only when opts.installDoneAfterPostMs is set.
  });

  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const match = /:(\d+)$/.exec(address);
  return {
    app,
    url: `http://127.0.0.1:${match ? Number(match[1]) : 0}`,
    agentStarted: () => agentStarted,
    installPosted: () => installPosted,
    installDoneSent: () => installDoneSent,
  };
}

describe("Integration: install gate — resolution without SSE install_done (docs/162)", () => {
  let stub: { app: FastifyInstance; url: string; agentStarted: () => boolean; installPosted: () => boolean; installDoneSent: () => boolean } | null = null;

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

  it("does not resolve the gate from a pre-POST status probe (docs/183 early-resolve race)", async () => {
    // The SSE stream opens inside runInstall BEFORE the POST is sent, so the
    // first-connect resync can probe /install/status while the worker hasn't
    // seen the install at all — `{ running: false, lastResult: null }`. The
    // old "worker restarted" heuristic synthesized a completion from that,
    // so the moment the (delayed) POST returned `{ started: true }`, the
    // already-resolved promise made runInstall settle instantly — while the
    // worker reported `running: true` and no `install_done` had been emitted.
    // Observed live on the docs/183 canary: install_ms read ~1.5s for a 20s+
    // npm install and the overlay publish hook snapshotted a not-yet-installed
    // dep dir. The fix skips the pre-POST probe and re-probes after the POST;
    // the gate must now stay open until the real `install_done` (sent here
    // 300ms after the POST).
    stub = await startStubWorker({
      installResponse: { started: true },
      installDelayMs: 250,
      status: { running: false, lastResult: null },           // pre-POST: worker never saw an install
      statusAfterPost: { running: true, lastResult: null },   // post-POST: install genuinely in progress
      installDoneAfterPostMs: 300,
    });

    const runner = new ContainerSessionRunner({
      sessionId: "gate-pre-post-race",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl: stub.url,
    });

    try {
      const result = await withTimeout(runner.runInstall(["npm install"]), 5000, "runInstall (pre-POST race)");
      expect(result.ok).toBe(true);
      // The gate must have stayed open until the worker actually finished —
      // resolving before install_done is exactly the early-resolve bug.
      expect(stub.installDoneSent()).toBe(true);
    } finally {
      runner.dispose({ force: true });
    }
  });
});
