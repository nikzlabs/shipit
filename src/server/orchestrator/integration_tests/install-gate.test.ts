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
 *
 * The last test in the file is the exception to that isolation, and deliberately
 * so: it drives a REAL `ServiceManager` alongside the stub worker so one test
 * spans the whole incident — services running, torn down for a reinstall, the
 * completion event lost, and the services actually started again.
 */
import { describe, it, expect, afterEach } from "vitest";
import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { ContainerSessionRunner } from "../container-session-runner.js";
import { ServiceManager, type ComposeRunner, type ComposeQuery } from "../service-manager.js";
import { SESSION_WORKSPACE_SUBDIR } from "../session-state-dir.js";
import { serializeStackOp } from "../stack-op-queue.js";

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
  /**
   * Hold the FIRST `/install/status` response open until the test releases it,
   * then answer `{running: false, lastResult: {ok: true}}`. Every later probe
   * answers `{running: true}` immediately. Lets a test park one probe in flight
   * across an install-generation boundary.
   */
  holdFirstStatus?: boolean;
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
  /** Let the held first `/install/status` response through (`holdFirstStatus`). */
  releaseHeldStatus: () => void;
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
  let releaseHeldStatus: () => void = () => {};
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
    if (opts.holdFirstStatus) {
      if (postPostStatusProbes > 1) return { running: true, lastResult: null };
      await new Promise<void>((r) => { releaseHeldStatus = r; });
      return { running: false, lastResult: { ok: true } };
    }
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
    releaseHeldStatus: () => { releaseHeldStatus(); },
  };
}

/**
 * A real session layout in a temp dir: the clone at `<sessionDir>/workspace`,
 * with `docker-compose.yml` in it. `ServiceManager` resolves its state dir from
 * the clone path and REFUSES a clone that does not sit at `workspace/`
 * (planning#288), so a bare temp dir is not a valid workspace.
 */
function makeSessionWorkspace(compose: string): { sessionDir: string; workspaceDir: string } {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-gate-e2e-"));
  const workspaceDir = path.join(sessionDir, SESSION_WORKSPACE_SUBDIR);
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "docker-compose.yml"), compose);
  return { sessionDir, workspaceDir };
}

/** Drain queued microtasks — several hops happen inside the gate-open path. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

/** Resolves to true if `p` is still pending after `ms`. */
async function stillPending(p: Promise<unknown>, ms: number): Promise<boolean> {
  const PENDING = "pending";
  // A rejection is a settlement too — either way `p` is no longer pending.
  const settle = async (): Promise<string> => {
    try { await p; } catch { /* settled by rejecting */ }
    return "settled";
  };
  const raced = await Promise.race([
    settle(),
    new Promise<string>((r) => setTimeout(() => r(PENDING), ms)),
  ]);
  return raced === PENDING;
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

  it("releases the reinstall bracket's gate after an install_done lost mid-reinstall (docs/283)", async () => {
    // The bracket half of the same incident. `holdGatedServicesForReinstall`
    // stops the `preview: auto` services (SIGTERM → SIGKILL → exit 137), and
    // ONLY `setInstallRunning(false)` starts them again — it lives in
    // `reinstallForDepChange`'s `finally`, so a `runInstall` that never returns
    // leaves the services in `gatedServices`, where the poller and
    // `handleNonZeroExit` deliberately ignore them, permanently.
    //
    // Scope, deliberately: this asserts the BRACKET reaches its `finally` and
    // releases as a success. It uses a recorder rather than a real
    // ServiceManager (which needs Docker), so it does NOT observe
    // `gatedServices`, `_gatedTeardown`, or a service actually restarting —
    // `service-manager.test.ts` covers the release itself.
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

  it("does not let a probe outlive its install and resolve the NEXT one (docs/283)", async () => {
    // Polling for the whole wait means a probe can still be awaiting HTTP when
    // the install it asked about settles by SSE and a new install arms a fresh
    // resolver. Every guard in `resyncInstallStateAfterReconnect` runs BEFORE
    // that await, so the late answer — truthfully "settled", but about the
    // PREVIOUS install — would resolve the current one. That is the docs/183
    // early-resolve bug displaced by one generation: install B's gate opens
    // while npm is still running, and the overlay publish hook snapshots a
    // not-yet-installed dep dir.
    stub = await startStubWorker({
      installResponse: { started: true },
      status: { running: false, lastResult: null },
      holdFirstStatus: true,   // park install A's post-POST probe in flight
    });

    const runner = new ContainerSessionRunner({
      sessionId: "gate-stale-probe-across-generations",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl: stub.url,
    });
    // Long enough that only the post-POST probes fire — the race under test is
    // about a probe's LIFETIME, not the cadence.
    setProbeInterval(runner, 5000);
    const priv = runner as unknown as { signalInstallComplete(ok?: boolean): void };

    try {
      // Install A: the stub holds its first probe open, so one probe belonging
      // to generation A is now parked in flight.
      const runA = runner.runInstall(["npm install"]);
      await waitFor(() => stub!.postPostStatusProbes() >= 1, 3000, "install A probe in flight");
      // A's real SSE `install_done` lands and settles it — while that probe is
      // still out there.
      priv.signalInstallComplete(true);
      expect((await withTimeout(runA, 3000, "runInstall A")).ok).toBe(true);

      // Install B starts and arms a new resolver. Its own probes truthfully
      // report `running: true`, so nothing legitimate can settle it.
      const probesBeforeB = stub.postPostStatusProbes();
      const runB = runner.runInstall(["npm install"]);
      await waitFor(() => stub!.postPostStatusProbes() > probesBeforeB, 3000, "install B probe issued");

      // Now A's probe finally answers `{running: false, lastResult: {ok: true}}`.
      stub.releaseHeldStatus();

      // B must still be waiting: that answer was never about B.
      expect(await stillPending(runB, 300)).toBe(true);

      priv.signalInstallComplete(true);   // B's real event, for a clean teardown
      await withTimeout(runB, 3000, "runInstall B");
    } finally {
      runner.dispose({ force: true });
    }
  });

  it("end-to-end: a lost install_done still gets the stopped services running again (docs/283)", async () => {
    // The whole incident in one test. The other tests here cut it in half — one
    // proves `runInstall` resolves without the SSE event, another proves the
    // reinstall bracket reaches its `finally` — but each half can pass while
    // the user-visible outcome fails, because neither watches a service. This
    // one drives a REAL ServiceManager: the `preview: auto` service is running,
    // the reinstall stops it, the completion event never arrives, and the only
    // thing that can bring it back is the periodic probe resolving the gate.
    const { sessionDir, workspaceDir } = makeSessionWorkspace(
      "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n",
    );

    const upCalls: string[][] = [];
    const stopCalls: string[] = [];
    const composeRunner: ComposeRunner = (args) => {
      const upIdx = args.indexOf("up");
      if (upIdx >= 0) upCalls.push(args.slice(upIdx));
      const stopIdx = args.indexOf("stop");
      if (stopIdx >= 0) stopCalls.push(args[stopIdx + 1]);
      return Promise.resolve();
    };
    const composeQuery: ComposeQuery = (args) => {
      const key = args.find(a => a === "ps" || a === "inspect" || a === "rm" || a === "network") ?? args[0];
      if (key === "ps") return Promise.resolve(JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 }));
      if (key === "inspect") return Promise.resolve(JSON.stringify([{ NetworkSettings: { Networks: {} } }]));
      return Promise.resolve("");
    };
    const webUps = () => upCalls.flat().filter(a => a === "web").length;

    // The worker: the install settles, but its `install_done` is NEVER sent and
    // the SSE stream never reconnects. Only the periodic probe can recover it.
    // 3, not 1. There are two probes that are NOT the periodic poll — the one
    // `runInstall` issues after the POST and the one `onSseOpen` issues — and
    // either can answer "settled" and resolve the gate on its own. Reporting
    // `running: true` for the first three is what forces the recovery to come
    // from the poll, and is the difference between this test failing without
    // the fix and passing for the wrong reason.
    stub = await startStubWorker({
      installResponse: { started: true },
      status: { running: false, lastResult: null },
      runningForStatusProbes: 3,
    });

    const mgr = new ServiceManager({
      sessionId: "gate-e2e",
      workspaceDir,
      serviceEnvDir: path.resolve(workspaceDir, "..", "service-env"),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });
    const runner = new ContainerSessionRunner({
      sessionId: "gate-e2e",
      sessionDir,
      defaultAgentId: "claude",
      workerUrl: stub.url,
    });
    setProbeInterval(runner, 50);
    runner.setServiceManager(mgr);
    runner.setDepReinstallInputs(["npm install"], ["package-lock.json"]);

    try {
      // Steady state: the gated service is up and running.
      mgr.setInstallRunning(true);
      await mgr.start();
      mgr.setInstallRunning(false);
      await flushMicrotasks();
      expect(mgr.getService("web")?.status).toBe("running");
      expect(webUps()).toBe(1);

      // A dependency input changed → the bracketed mid-session reinstall.
      await withTimeout(
        (runner as unknown as { reinstallForDepChange(): Promise<void> }).reinstallForDepChange(),
        5000,
        "reinstallForDepChange",
      );
      await flushMicrotasks();

      // The hold really did stop the service (this is the exit 137 the user
      // saw), and the gate really did reopen and start it again — with no SSE
      // completion event at any point.
      expect(stopCalls).toContain("web");
      expect(webUps()).toBe(2);
      expect(mgr.getService("web")?.status).toBe("running");
      expect(stub.installDoneSent()).toBe(false);
      expect(mgr.installRunning).toBe(false);
      // > 3 probes means the poll ran: the two non-periodic probes cannot get
      // past the `running: true` answers configured above.
      expect(stub.postPostStatusProbes()).toBeGreaterThan(3);
    } finally {
      runner.dispose({ force: true });
      await mgr.stop();
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The gate-liveness watchdog (docs/286)
// ---------------------------------------------------------------------------

/**
 * docs/283 closed two routes to "the install gate never reopens". A third was
 * then observed in production on build `3780af7e`, which already carried that
 * fix: session `064ea640` released its gate correctly on its FIRST install and
 * then wedged on all five subsequent mid-session re-installs, leaving its
 * `preview: auto` services `game` and `debug` stopped. Four other sessions on
 * the same host were in the same state.
 *
 * The branch that dropped the release was never identified — every candidate
 * returned with no log at all — so these tests deliberately do NOT model a
 * route. They put the manager in the wedged STATE and assert on what the
 * watchdog does with it, which is exactly the contract: a gate no gate event
 * will ever open is decidable without knowing what failed to open it.
 *
 * The negative tests all end by REMOVING the one condition that was holding the
 * watchdog back and watching it fire. Without that, "nothing happened for 300ms"
 * is equally consistent with "the poll loop was never running", and a deleted
 * guard could pass for the wrong reason on a loaded box.
 */
describe("Integration: install gate — liveness watchdog (docs/286)", () => {
  const cleanups: (() => void)[] = [];

  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  const SETTLE_MS = 150;
  const POLL_MS = 25;
  /** Comfortably past the settle window plus several heartbeats. */
  const PAST_SETTLE_MS = SETTLE_MS + POLL_MS * 10;

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /**
   * A real `ServiceManager` over a fake compose CLI. `stop` can be parked, which
   * is how a teardown is held in flight for the docs/239 case, and the session's
   * stack queue can be parked, which is how a queued gated start is held.
   */
  function makeManager(sessionId: string, compose = "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n") {
    const { sessionDir, workspaceDir } = makeSessionWorkspace(compose);
    const upCalls: string[] = [];
    const stopCalls: string[] = [];
    let parkStops = false;
    const parkedStops: (() => void)[] = [];

    const composeRunner: ComposeRunner = (args) => {
      const upIdx = args.indexOf("up");
      if (upIdx >= 0) {
        for (const a of args.slice(upIdx)) {
          if (a !== "up" && !a.startsWith("-")) upCalls.push(a);
        }
      }
      const stopIdx = args.indexOf("stop");
      if (stopIdx >= 0) {
        stopCalls.push(args[stopIdx + 1]);
        if (parkStops) return new Promise<void>((resolve) => { parkedStops.push(resolve); });
      }
      return Promise.resolve();
    };
    const composeQuery: ComposeQuery = (args) => {
      const key = args.find(a => a === "ps" || a === "inspect" || a === "rm" || a === "network") ?? args[0];
      if (key === "ps") {
        return Promise.resolve(JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 }));
      }
      if (key === "inspect") return Promise.resolve(JSON.stringify([{ NetworkSettings: { Networks: {} } }]));
      return Promise.resolve("");
    };

    const mgr = new ServiceManager({
      sessionId,
      workspaceDir,
      serviceEnvDir: path.resolve(workspaceDir, "..", "service-env"),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: POLL_MS,
      gateWatchdogSettleMs: SETTLE_MS,
    });

    cleanups.push(() => {
      for (const r of parkedStops.splice(0)) r();
      void mgr.stop();
      fs.rmSync(sessionDir, { recursive: true, force: true });
    });

    return {
      mgr,
      /** How many times `web` has been named in a `docker compose up`. */
      webUps: () => upCalls.filter(a => a === "web").length,
      /** Every service name passed to a `docker compose stop`. */
      stopCalls,
      /** Services the gate is currently holding. */
      gated: () => [...(mgr as unknown as { gatedServices: Set<string> }).gatedServices],
      parkStops: () => { parkStops = true; },
      releaseStops: () => { parkStops = false; for (const r of parkedStops.splice(0)) r(); },
    };
  }

  /** Capture `console.warn` / `console.log` for the duration of a test. */
  function captureConsole(): { lines: () => string[] } {
    const lines: string[] = [];
    const warn = console.warn;
    const log = console.log;
    const push = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    console.warn = push;
    console.log = push;
    cleanups.push(() => { console.warn = warn; console.log = log; });
    return { lines: () => [...lines] };
  }

  /**
   * Model a LOST gate release: the install has finished, the services are still
   * held, and no `releaseInstallGate` will ever complete.
   *
   * Both fields, because both are what the manager looks like AFTER any of the
   * five candidate branches returned. `releaseInstallGate` nulls `_gatedTeardown`
   * on its first line and only then reaches the branches that can drop the
   * open, so a wedge that came through any of them has a null teardown and a
   * cleared `_installRunning`.
   *
   * Reaching for the fields directly is the point. Every candidate branch
   * returned silently, so no public call reproduces "the release was dropped"
   * without also deciding WHICH branch dropped it — and the incident
   * deliberately left that unknown.
   */
  function loseTheGateRelease(mgr: ServiceManager): void {
    const priv = mgr as unknown as { _installRunning: boolean; _gatedTeardown: Promise<void> | null };
    priv._installRunning = false;
    priv._gatedTeardown = null;
  }

  it("reopens a gate whose release was lost mid-reinstall, and the held services start", async () => {
    const h = makeManager("gate-watchdog-reopen");
    const con = captureConsole();

    // Steady state, through the real bracket: install runs, gate opens, the
    // `preview: auto` service is up.
    h.mgr.setInstallRunning(true);
    await h.mgr.start();
    h.mgr.setInstallRunning(false);
    await flushMicrotasks();
    await waitFor(() => h.mgr.getService("web")?.status === "running", 3000, "first start");
    expect(h.webUps()).toBe(1);

    // A dependency input changed → the mid-session re-install bracket. This is
    // the real hold: the service is re-gated and OUR OWN `docker compose stop`
    // goes out — the exit 137 the user reported as a crash.
    h.mgr.setInstallRunning(true);
    await flushMicrotasks();
    expect(h.stopCalls).toContain("web");
    expect(h.gated()).toEqual(["web"]);

    // ...and then the release is lost. Nothing polls a held service, so without
    // the watchdog this is where the preview stays for the rest of the session.
    loseTheGateRelease(h.mgr);

    await waitFor(() => h.webUps() === 2, 3000, "watchdog reopened the gate");
    await waitFor(() => h.mgr.getService("web")?.status === "running", 3000, "web running again");
    expect(h.gated()).toEqual([]);
    // Requirement 4: the recovery says why it happened. Until docs/286 the hold
    // was logged and nothing else was.
    expect(con.lines().some(l => l.includes("install gate watchdog:") && l.includes("web"))).toBe(true);
  });

  it("does nothing while the install is still running", async () => {
    const h = makeManager("gate-watchdog-install-running");

    h.mgr.setInstallRunning(true);
    await h.mgr.start();

    // A running install OWNS the gate — its completion is the release. Firing
    // here would start the service against a half-written dependency tree,
    // which is the docs/137 race the gate exists to remove.
    await sleep(PAST_SETTLE_MS);
    expect(h.webUps()).toBe(0);
    expect(h.gated()).toEqual(["web"]);
    expect(h.mgr.getService("web")?.status).toBe("starting");

    // Drop that one condition and the watchdog fires — which is what proves the
    // heartbeat was running all along and `_installRunning` was the only thing
    // holding it back.
    loseTheGateRelease(h.mgr);
    await waitFor(() => h.webUps() === 1, 3000, "watchdog fired once install stopped running");
  });

  it("does nothing while the teardown's compose stop is still in flight (docs/239)", async () => {
    const h = makeManager("gate-watchdog-teardown-pending");

    h.mgr.setInstallRunning(true);
    await h.mgr.start();
    h.mgr.setInstallRunning(false);
    await flushMicrotasks();
    await waitFor(() => h.webUps() === 1, 3000, "first start");

    // Mid-session re-install: hold + `compose stop`, and park that stop. The
    // release is now awaiting a teardown, so `_gatedTeardown` has ALREADY been
    // nulled by `releaseInstallGate` — the field cannot tell the watchdog the
    // bracket is still closing, which is what `_gateReleasesInFlight` is for.
    h.parkStops();
    h.mgr.setInstallRunning(true);
    h.mgr.setInstallRunning(false);
    await flushMicrotasks();
    expect(h.gated()).toEqual(["web"]);
    expect(h.mgr.installRunning).toBe(false);

    // Reopening here would let the gate open before our own SIGKILL lands, and
    // our teardown would surface to the user as a service crash (docs/239).
    await sleep(PAST_SETTLE_MS);
    expect(h.webUps()).toBe(1);
    expect(h.gated()).toEqual(["web"]);

    // The teardown lands → the REAL release opens the gate, exactly once.
    h.releaseStops();
    await waitFor(() => h.webUps() === 2, 3000, "release started web");
    await sleep(PAST_SETTLE_MS);
    expect(h.webUps()).toBe(2);
  });

  it("clears a wedged gate that holds only services the user stopped, and starts nothing", async () => {
    const h = makeManager("gate-watchdog-stopped-by-user");
    const con = captureConsole();

    h.mgr.setInstallRunning(true);
    await h.mgr.start();
    // The user stops the service while it is held. Requirement 5: their last
    // instruction is the one that holds, and the watchdog is an automatic
    // lifecycle event, not a newer instruction.
    await h.mgr.stopService("web");
    expect(h.mgr.getService("web")?.status).toBe("stopped");

    loseTheGateRelease(h.mgr);

    // The gate is still cleared — leaving the name in the set would look like
    // the same wedge forever, and re-report it on every heartbeat.
    await waitFor(() => h.gated().length === 0, 3000, "watchdog cleared the gate");
    await sleep(PAST_SETTLE_MS);
    expect(h.webUps()).toBe(0);
    expect(con.lines().some(l => l.includes("stopped by the user"))).toBe(true);
  });

  it("does not resurrect a service the user stops while the gated start waits on the stack queue", async () => {
    // The `stoppedByUser` filter in `startGatedServices` runs BEFORE the batch
    // is queued, and the queue can hold that batch for as long as the
    // `compose up` ahead of it takes. A Stop landing inside that window records
    // itself and finds no `up` in flight to chase, so without the re-check in
    // `startGatedBatch` the queued start walks the service straight back up.
    // Review finding on docs/286.
    const sessionId = "gate-watchdog-stop-races-queue";
    const h = makeManager(sessionId);

    h.mgr.setInstallRunning(true);
    await h.mgr.start();
    expect(h.webUps()).toBe(0);

    // Stand in for the plugin-service reconcile a session activation runs
    // concurrently with `agent.install`: it holds the session's stack op.
    let release!: () => void;
    const queued = serializeStackOp(sessionId, () => new Promise<void>((r) => { release = r; }));

    try {
      loseTheGateRelease(h.mgr);
      // The watchdog fires and queues the batch behind the parked op.
      await waitFor(() => h.gated().length === 0, 3000, "watchdog opened the gate");
      expect(h.webUps()).toBe(0);

      // The user stops the service while the batch is still queued.
      await h.mgr.stopService("web");
      expect(h.mgr.getService("web")?.status).toBe("stopped");
    } finally {
      release();
    }
    await queued;
    await flushMicrotasks();
    await sleep(PAST_SETTLE_MS);

    // No `up` for `web` is the whole assertion. Its *status* is not: the fake
    // `ps` here always answers `running`, so once the gate stops holding the
    // service the poller reports whatever the fixture says. Asserting on that
    // would be asserting on the fixture.
    expect(h.webUps()).toBe(0);
  });

  it("does not open a gate a newer hold owns", async () => {
    const h = makeManager("gate-watchdog-newer-hold");

    h.mgr.setInstallRunning(true);
    await h.mgr.start();
    loseTheGateRelease(h.mgr);

    // Let the wedge clock start, but not expire.
    await sleep(Math.round(SETTLE_MS * 0.5));
    expect(h.webUps()).toBe(0);

    // A newer cycle takes ownership: fresh generation, fresh teardown, and a
    // release awaiting it. Acting on the older observation would start the very
    // services that newer teardown is in the middle of stopping.
    h.parkStops();
    h.mgr.setInstallRunning(true);
    h.mgr.setInstallRunning(false);
    await flushMicrotasks();

    await sleep(PAST_SETTLE_MS);
    expect(h.webUps()).toBe(0);
    expect(h.gated()).toEqual(["web"]);

    h.releaseStops();
    await waitFor(() => h.webUps() === 1, 3000, "newer cycle's release started web");
  });

  it("leaves a gate held by a FAILED install alone", async () => {
    const h = makeManager("gate-watchdog-install-failed");

    h.mgr.setInstallRunning(true);
    await h.mgr.start();
    h.mgr.setInstallRunning(false, { failed: true });
    await flushMicrotasks();

    // Held on purpose: latched to `error` with the real cause, kept in the set
    // so a later SUCCESSFUL re-install starts them. Starting them here walks
    // them straight into the `vite: not found` the latch exists to prevent —
    // and the user can already see why they are down.
    await sleep(PAST_SETTLE_MS);
    expect(h.webUps()).toBe(0);
    expect(h.gated()).toEqual(["web"]);
    expect(h.mgr.getService("web")?.status).toBe("error");
    expect(h.mgr.getService("web")?.error).toContain("agent.install failed");

    // Same proof as the install-running case: clear only that condition and the
    // watchdog fires, so the silence above was the latch and not a dead loop.
    (h.mgr as unknown as { _installFailed: boolean })._installFailed = false;
    await waitFor(() => h.webUps() === 1, 3000, "watchdog fired once the latch cleared");
  });
});
