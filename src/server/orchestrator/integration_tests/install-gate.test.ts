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
  installResponse: Record<string, unknown>;
  status: { running: boolean; lastResult: { ok: boolean; message?: string; command?: string } | null };
  installDelayMs?: number;
  statusAfterPost?: StubOpts["status"];
  installDoneAfterPostMs?: number;
  runningForStatusProbes?: number;
  holdFirstStatus?: boolean;
}

interface StubWorker {
  app: FastifyInstance;
  url: string;
  agentStarted: () => boolean;
  installPosted: () => boolean;
  installDoneSent: () => boolean;
  postPostStatusProbes: () => number;
  sseConnects: () => number;
  releaseHeldStatus: () => void;
}

function setProbeInterval(runner: ContainerSessionRunner, ms: number): void {
  (runner as unknown as { _installProbeIntervalMs: number })._installProbeIntervalMs = ms;
}

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

// ServiceManager requires the clone to sit in a workspace subdirectory.
function makeSessionWorkspace(compose: string): { sessionDir: string; workspaceDir: string } {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-gate-e2e-"));
  const workspaceDir = path.join(sessionDir, SESSION_WORKSPACE_SUBDIR);
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "docker-compose.yml"), compose);
  return { sessionDir, workspaceDir };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

async function stillPending(p: Promise<unknown>, ms: number): Promise<boolean> {
  const PENDING = "pending";
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
    stub = await startStubWorker({
      installResponse: { started: true },
      installDelayMs: 250,
      status: { running: false, lastResult: null },
      statusAfterPost: { running: true, lastResult: null },
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
      expect(stub.installDoneSent()).toBe(true);
    } finally {
      runner.dispose({ force: true });
    }
  });

  it("recovers an install_done lost MID-install, with no SSE reconnect (docs/283)", async () => {
    stub = await startStubWorker({
      installResponse: { started: true },
      status: { running: false, lastResult: null },
      runningForStatusProbes: 2,
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
      expect(stub.installDoneSent()).toBe(false);
      expect(stub.sseConnects()).toBe(1);
      expect(stub.postPostStatusProbes()).toBeGreaterThanOrEqual(3);
    } finally {
      runner.dispose({ force: true });
    }
  });

  it("releases the reinstall bracket's gate after an install_done lost mid-reinstall (docs/283)", async () => {
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

    const gate: { running: boolean; failed?: boolean }[] = [];
    const priv = runner as unknown as {
      _serviceManager: {
        installGateFailed: boolean;
        setInstallRunning(running: boolean, opts?: { failed?: boolean }): boolean;
      };
      reinstallForDepChange(): Promise<void>;
    };
    let open = false;
    priv._serviceManager = {
      installGateFailed: false,
      setInstallRunning: (running, opts) => {
        if (open === running) return false;
        open = running;
        gate.push({ running, ...(opts?.failed !== undefined ? { failed: opts.failed } : {}) });
        return true;
      },
    };
    runner.setDepReinstallInputs(["npm install"], ["package-lock.json"]);

    try {
      await withTimeout(priv.reinstallForDepChange(), 5000, "reinstallForDepChange");
      expect(gate).toEqual([{ running: true }, { running: false, failed: false }]);
      expect(stub.installDoneSent()).toBe(false);
    } finally {
      runner.dispose({ force: true });
    }
  });

  it("does not let a probe outlive its install and resolve the NEXT one (docs/283)", async () => {
    stub = await startStubWorker({
      installResponse: { started: true },
      status: { running: false, lastResult: null },
      holdFirstStatus: true,
    });

    const runner = new ContainerSessionRunner({
      sessionId: "gate-stale-probe-across-generations",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl: stub.url,
    });
    // Keep periodic probes out of this generation-boundary race.
    setProbeInterval(runner, 5000);
    const priv = runner as unknown as { signalInstallComplete(ok?: boolean): void };

    try {
      const runA = runner.runInstall(["npm install"]);
      await waitFor(() => stub!.postPostStatusProbes() >= 1, 3000, "install A probe in flight");
      priv.signalInstallComplete(true);
      expect((await withTimeout(runA, 3000, "runInstall A")).ok).toBe(true);

      const probesBeforeB = stub.postPostStatusProbes();
      const runB = runner.runInstall(["npm install"]);
      await waitFor(() => stub!.postPostStatusProbes() > probesBeforeB, 3000, "install B probe issued");

      stub.releaseHeldStatus();

      expect(await stillPending(runB, 300)).toBe(true);

      priv.signalInstallComplete(true);
      await withTimeout(runB, 3000, "runInstall B");
    } finally {
      runner.dispose({ force: true });
    }
  });

  it("end-to-end: a lost install_done still gets the stopped services running again (docs/283)", async () => {
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

    // Three running responses exhaust both one-off probes, forcing periodic recovery.
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
      mgr.setInstallRunning(true);
      await mgr.start();
      mgr.setInstallRunning(false);
      await flushMicrotasks();
      expect(mgr.getService("web")?.status).toBe("running");
      expect(webUps()).toBe(1);

      await withTimeout(
        (runner as unknown as { reinstallForDepChange(): Promise<void> }).reinstallForDepChange(),
        5000,
        "reinstallForDepChange",
      );
      await flushMicrotasks();

      expect(stopCalls).toContain("web");
      expect(webUps()).toBe(2);
      expect(mgr.getService("web")?.status).toBe("running");
      expect(stub.installDoneSent()).toBe(false);
      expect(mgr.installRunning).toBe(false);
      expect(stub.postPostStatusProbes()).toBeGreaterThan(3);
    } finally {
      runner.dispose({ force: true });
      await mgr.stop();
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

describe("Integration: install gate — liveness watchdog (docs/286)", () => {
  const cleanups: (() => void)[] = [];

  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  const SETTLE_MS = 150;
  const POLL_MS = 25;
  const PAST_SETTLE_MS = SETTLE_MS + POLL_MS * 10;

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
      webUps: () => upCalls.filter(a => a === "web").length,
      stopCalls,
      gated: () => [...(mgr as unknown as { gatedServices: Set<string> }).gatedServices],
      parkStops: () => { parkStops = true; },
      releaseStops: () => { parkStops = false; for (const r of parkedStops.splice(0)) r(); },
    };
  }

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

  // Set the stuck state directly; the incident's failing release path was unknown.
  function loseTheGateRelease(mgr: ServiceManager): void {
    const priv = mgr as unknown as { _installRunning: boolean; _gatedTeardown: Promise<void> | null };
    priv._installRunning = false;
    priv._gatedTeardown = null;
  }

  it("reopens a gate whose release was lost mid-reinstall, and the held services start", async () => {
    const h = makeManager("gate-watchdog-reopen");
    const con = captureConsole();

    h.mgr.setInstallRunning(true);
    await h.mgr.start();
    h.mgr.setInstallRunning(false);
    await flushMicrotasks();
    await waitFor(() => h.mgr.getService("web")?.status === "running", 3000, "first start");
    expect(h.webUps()).toBe(1);

    h.mgr.setInstallRunning(true);
    await flushMicrotasks();
    expect(h.stopCalls).toContain("web");
    expect(h.gated()).toEqual(["web"]);

    loseTheGateRelease(h.mgr);

    await waitFor(() => h.webUps() === 2, 3000, "watchdog reopened the gate");
    await waitFor(() => h.mgr.getService("web")?.status === "running", 3000, "web running again");
    expect(h.gated()).toEqual([]);
    expect(con.lines().some(l => l.includes("install gate watchdog:") && l.includes("web"))).toBe(true);
  });

  it("does nothing while the install is still running", async () => {
    const h = makeManager("gate-watchdog-install-running");

    h.mgr.setInstallRunning(true);
    await h.mgr.start();

    await sleep(PAST_SETTLE_MS);
    expect(h.webUps()).toBe(0);
    expect(h.gated()).toEqual(["web"]);
    expect(h.mgr.getService("web")?.status).toBe("starting");

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

    h.parkStops();
    h.mgr.setInstallRunning(true);
    h.mgr.setInstallRunning(false);
    await flushMicrotasks();
    expect(h.gated()).toEqual(["web"]);
    expect(h.mgr.installRunning).toBe(false);

    await sleep(PAST_SETTLE_MS);
    expect(h.webUps()).toBe(1);
    expect(h.gated()).toEqual(["web"]);

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
    await h.mgr.stopService("web");
    expect(h.mgr.getService("web")?.status).toBe("stopped");

    loseTheGateRelease(h.mgr);

    await waitFor(() => h.gated().length === 0, 3000, "watchdog cleared the gate");
    await sleep(PAST_SETTLE_MS);
    expect(h.webUps()).toBe(0);
    expect(con.lines().some(l => l.includes("stopped by the user"))).toBe(true);
  });

  it("does not resurrect a service the user stops while the gated start waits on the stack queue", async () => {
    const sessionId = "gate-watchdog-stop-races-queue";
    const h = makeManager(sessionId);

    h.mgr.setInstallRunning(true);
    await h.mgr.start();
    expect(h.webUps()).toBe(0);

    let release!: () => void;
    const queued = serializeStackOp(sessionId, () => new Promise<void>((r) => { release = r; }));

    try {
      loseTheGateRelease(h.mgr);
      await waitFor(() => h.gated().length === 0, 3000, "watchdog opened the gate");
      expect(h.webUps()).toBe(0);

      await h.mgr.stopService("web");
      expect(h.mgr.getService("web")?.status).toBe("stopped");
    } finally {
      release();
    }
    await queued;
    await flushMicrotasks();
    await sleep(PAST_SETTLE_MS);

    // Check start calls: the fake ps always reports running, even after stop.
    expect(h.webUps()).toBe(0);
  });

  it("does not open a gate a newer hold owns", async () => {
    const h = makeManager("gate-watchdog-newer-hold");

    h.mgr.setInstallRunning(true);
    await h.mgr.start();
    loseTheGateRelease(h.mgr);

    await sleep(Math.round(SETTLE_MS * 0.5));
    expect(h.webUps()).toBe(0);

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

    await sleep(PAST_SETTLE_MS);
    expect(h.webUps()).toBe(0);
    expect(h.gated()).toEqual(["web"]);
    expect(h.mgr.getService("web")?.status).toBe("error");
    expect(h.mgr.getService("web")?.error).toContain("agent.install failed");

    (h.mgr as unknown as { _installFailed: boolean })._installFailed = false;
    await waitFor(() => h.webUps() === 1, 3000, "watchdog fired once the latch cleared");
  });
});
