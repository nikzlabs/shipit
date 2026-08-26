/**
 * Regression tests for the install gate (docs/162).
 *
 * The orchestrator brackets `_startAgentViaProxy` behind `runInstall`, whose
 * completion promise (`_installComplete`) gates the first turn. Three ways it
 * can settle without hanging:
 *
 *  1. POST /install returns `{ skipped: true }` (marker already present) — the
 *     gate resolves directly from the HTTP response.
 *  2. POST /install returns `{ started: true }` and the SSE-delivered
 *     `install_done` is lost (the production race where the event is consumed
 *     before the resolver is armed). The first-connect `/install/status`
 *     resync must probe the worker, see it settled, and resolve the gate. Before
 *     the fix the resync ran only on RECONNECT, so a headless session hung.
 *  3. The event is lost while the install is still RUNNING, on a stream that
 *     never reconnects (docs/283). Both probes above have already had their
 *     turn, so only the periodic probe `awaitInstallCompletion` runs for the
 *     whole wait can settle the gate. This is the shape that wedged the
 *     ServiceManager install gate and left `preview: auto` services stopped.
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
  /**
   * Models a LOST `install_done` on a still-open SSE stream (docs/283): the
   * first N post-POST `/install/status` probes report `running: true`, and
   * every probe after that reports a settled successful install. Counting
   * probes rather than waiting on the clock keeps the test timing-independent
   * while still proving the recovery came from a probe the runner issued
   * ITSELF, not from the single post-POST resync.
   */
  runningForStatusProbes?: number;
}

interface StubWorker {
  app: FastifyInstance;
  url: string;
  agentStarted: () => boolean;
  installPosted: () => boolean;
  installDoneSent: () => boolean;
  /** `/install/status` requests served since POST /install returned. */
  postPostStatusProbes: () => number;
  /** How many times the runner has opened the SSE stream. */
  sseConnects: () => number;
}

/**
 * Reach the runner's private probe cadence. Tests only: the production value
 * is 30s, which no test can wait for.
 */
function setProbeInterval(runner: ContainerSessionRunner, ms: number): void {
  (runner as unknown as { _installProbeIntervalMs: number })._installProbeIntervalMs = ms;
}

/**
 * Minimal stub worker: a valid SSE /events endpoint that stays open but never
 * emits `install_done`, plus configurable POST /install + GET /install/status.
 * This lets us prove the orchestrator resolves the gate WITHOUT any SSE
 * `install_done` — either from the HTTP response or the first-connect
 * `/install/status` resync.
 */
async function startStubWorker(opts: StubOpts): Promise<StubWorker> {
  const app = Fastify();
  let agentStarted = false;
  let installPosted = false;
  let installDoneSent = false;
  let postPostStatusProbes = 0;
  let sseConnects = 0;
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
  app.get("/install/status", async () => {
    if (!installPosted) return opts.status;
    postPostStatusProbes += 1;
    if (opts.runningForStatusProbes !== undefined) {
      return postPostStatusProbes <= opts.runningForStatusProbes
        ? { running: true, lastResult: null }
        : { running: false, lastResult: { ok: true } };
    }
    return opts.statusAfterPost ?? opts.status;
  });
  app.get("/agent/status", async () => ({ running: agentStarted }));
  app.post("/agent/start", async () => { agentStarted = true; return { started: true }; });
  app.post("/agent/kill", async () => ({ ok: true }));
  // Catch-all for the various fire-and-forget worker calls the runner makes
  // (terminal/start, file-watcher, preview, secrets) so they don't 404-noise.
  app.post("/*", async () => ({ ok: true }));
  app.get("/events", (request, reply) => {
    sseConnects += 1;
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
    postPostStatusProbes: () => postPostStatusProbes,
    sseConnects: () => sseConnects,
  };
}

describe("Integration: install gate — resolution without SSE install_done (docs/162)", () => {
  let stub: StubWorker | null = null;

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

  it("recovers an install_done lost MID-install, with no SSE reconnect (docs/283)", async () => {
    // The production wedge. The post-POST resync fires while the install is
    // genuinely running, correctly sees `running: true`, and waits for the real
    // event — which is then lost. The SSE stream never drops, so `onSseOpen`
    // never fires again and the old code had no third chance: `await completion`
    // was unbounded, so `runInstall` never returned, `reinstallForDepChange`'s
    // `finally` never ran, and the gated `preview: auto` services stayed held
    // and stopped for the rest of the session.
    stub = await startStubWorker({
      installResponse: { started: true },
      status: { running: false, lastResult: null },  // pre-POST: worker hasn't seen it
      runningForStatusProbes: 2,                     // first two post-POST probes: still installing
      // No `installDoneAfterPostMs` — the event is NEVER delivered.
    });

    const runner = new ContainerSessionRunner({
      sessionId: "gate-lost-event-mid-install",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl: stub.url,
    });
    setProbeInterval(runner, 50);

    try {
      const result = await withTimeout(runner.runInstall(["npm install"]), 5000, "runInstall (lost mid-install event)");
      expect(result.ok).toBe(true);
      // Nothing but the runner's own periodic probe could have resolved this.
      expect(stub.installDoneSent()).toBe(false);
      expect(stub.sseConnects()).toBe(1);
      // >= 3: the post-POST resync plus at least two more the poll issued. The
      // stub reports `running: true` for the first two, so a single probe (the
      // pre-fix behaviour) could not have settled the gate.
      expect(stub.postPostStatusProbes()).toBeGreaterThanOrEqual(3);
    } finally {
      runner.dispose({ force: true });
    }
  });

  it("reopens the ServiceManager install gate after an install_done lost mid-reinstall (docs/283)", async () => {
    // The user-visible half of the same incident: `holdGatedServicesForReinstall`
    // stops the `preview: auto` services (SIGTERM → SIGKILL → exit 137), and
    // ONLY `setInstallRunning(false)` starts them again. It lives in
    // `reinstallForDepChange`'s `finally`, so a `runInstall` that never returns
    // leaves the services in `gatedServices` — where the poller and
    // `handleNonZeroExit` deliberately ignore them — permanently.
    stub = await startStubWorker({
      installResponse: { started: true },
      status: { running: false, lastResult: null },
      runningForStatusProbes: 2,
    });

    const runner = new ContainerSessionRunner({
      sessionId: "gate-reopen-after-lost-event",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl: stub.url,
    });
    setProbeInterval(runner, 50);

    // Stand in for the ServiceManager: `reinstallForDepChange` uses nothing of
    // it but the gate bracket, and a real one needs Docker.
    const gate: { running: boolean; failed?: boolean }[] = [];
    const priv = runner as unknown as {
      _serviceManager: { setInstallRunning(running: boolean, opts?: { failed?: boolean }): void };
      reinstallForDepChange(): Promise<void>;
    };
    priv._serviceManager = {
      setInstallRunning: (running, opts) => {
        gate.push({ running, ...(opts?.failed !== undefined ? { failed: opts.failed } : {}) });
      },
    };
    runner.setDepReinstallInputs(["npm install"], ["package-lock.json"]);

    try {
      await withTimeout(priv.reinstallForDepChange(), 5000, "reinstallForDepChange");
      // Held, then RELEASED as a success — the release is what starts the
      // gated services again.
      expect(gate).toEqual([{ running: true }, { running: false, failed: false }]);
      expect(stub.installDoneSent()).toBe(false);
    } finally {
      runner.dispose({ force: true });
    }
  });
});
