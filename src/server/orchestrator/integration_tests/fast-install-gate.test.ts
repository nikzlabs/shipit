/**
 * Regression tests for the fast-install gate deadlock (docs/162).
 *
 * Symptom: on a fresh headless session whose repo hits the docs/148
 * fast-install cache, the worker logs `[install] fast-path hit ...` and then
 * the agent never starts — no `/agent/start`, no first turn. Slow/real-install
 * sessions are unaffected.
 *
 * Root cause: the orchestrator's install gate (`_waitForInstallBeforeAgent`)
 * awaited `_installComplete`, which was only ever resolved by the SSE-delivered
 * `install_done` event. On the fast path that event is broadcast within a few
 * ms — it can be delivered/consumed before the gate's resolver is armed (or its
 * SSE handshake completes), and `signalInstallComplete()` is a no-op when the
 * resolver is null. With no fallback on the FIRST connect, the gate hung
 * forever.
 *
 * Fix:
 *  1. (Primary, deterministic) The worker resolves a fast-install cache HIT
 *     SYNCHRONOUSLY inside the POST /install request and reports it as
 *     `{ completed: true, ok }` — the orchestrator settles the gate from the
 *     HTTP response, never depending on the racy SSE event.
 *  2. (Backstop) `onSseOpen` re-polls `/install/status` on the FIRST connect
 *     too (not just reconnects), so a lost `install_done` on the streamed
 *     real-install path is still recovered.
 *
 * These tests use real Fastify servers (no Docker): a real `SessionWorker`
 * with a pre-populated nm-store to exercise the genuine fast path, and small
 * stub workers to isolate the gate-resolution contract from SSE delivery.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionWorker } from "../../session/session-worker.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import {
  computeStoreKey,
  findLockfile,
  runtimeKey,
  tuneNpmInstall,
  NM_STORE_DIR_ENV,
} from "../../session/nm-store.js";
import type { AgentProcess, AgentProcessEvents, AgentId, AgentRunParams, PermissionMode } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Fakes / helpers
// ---------------------------------------------------------------------------

class FakeWorkerAgent extends EventEmitter<AgentProcessEvents> implements AgentProcess {
  readonly agentId: AgentId = "claude";
  readonly capabilities = {
    supportsResume: true,
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: true,
    supportedPermissionModes: [] as PermissionMode[],
    toolNames: [] as string[],
    models: [] as string[],
    supportsReview: true,
    supportsSteering: false,
    skillsDirName: ".claude",
    skillInvocationPrefix: "/",
  };
  runCalled = false;
  lastParams: AgentRunParams | null = null;
  readonly isStreaming = false;
  run(params: AgentRunParams): void { this.runCalled = true; this.lastParams = params; }
  writeStdin(): void { /* unused */ }
  sendUserMessage(): void { /* unused */ }
  interrupt(): void { /* unused */ }
  kill(): void { /* unused */ }
  writeMcpConfig(): { mcpConfigPath?: string; runtimeEnv?: Record<string, string>; cleanup?: () => void } { return {}; }
}

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

// ---------------------------------------------------------------------------
// Test 1 + 2 — real SessionWorker, genuine fast path
// ---------------------------------------------------------------------------

describe("Integration: fast-install gate — real worker fast path (docs/162)", () => {
  let worker: SessionWorker;
  let lastAgent: FakeWorkerAgent;
  let workerUrl: string;
  let workspaceDir: string;
  let storeRoot: string;
  let prevStoreEnv: string | undefined;

  beforeEach(async () => {
    lastAgent = null as unknown as FakeWorkerAgent;
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-fast-gate-ws-"));
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-fast-gate-store-"));

    // Single lockfile → fast-path candidate.
    fs.writeFileSync(path.join(workspaceDir, "package-lock.json"), JSON.stringify({ name: "t", lockfileVersion: 3 }));
    // node_modules subdir creation needs the parent for left-pad.
    fs.mkdirSync(path.join(storeRoot), { recursive: true });
    const storeDir = computeStoreDir(storeRoot, workspaceDir, "npm ci");
    fs.mkdirSync(path.join(storeDir, "left-pad"), { recursive: true });
    fs.writeFileSync(path.join(storeDir, "left-pad", "index.js"), "module.exports = 0;");
    fs.writeFileSync(path.join(storeDir, ".materialized"), "1");

    prevStoreEnv = process.env[NM_STORE_DIR_ENV];
    process.env[NM_STORE_DIR_ENV] = storeRoot;

    worker = new SessionWorker({
      agentFactory: () => { lastAgent = new FakeWorkerAgent(); return lastAgent; },
      port: 0,
      host: "127.0.0.1",
      workspaceDir,
    });
    const address = await worker.start();
    const match = /:(\d+)$/.exec(address);
    workerUrl = `http://127.0.0.1:${match ? Number(match[1]) : 0}`;
  });

  afterEach(async () => {
    await worker.stop();
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- NM_STORE_DIR_ENV is a fixed const key
    if (prevStoreEnv === undefined) delete process.env[NM_STORE_DIR_ENV];
    else process.env[NM_STORE_DIR_ENV] = prevStoreEnv;
    await new Promise((r) => setTimeout(r, 30));
    for (const dir of [workspaceDir, storeRoot]) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
    }
  });

  it("worker reports a cache HIT as { completed: true } in the POST /install response", async () => {
    const res = await fetch(`${workerUrl}/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: ["npm ci"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { completed?: boolean; ok?: boolean; started?: boolean };

    // The deterministic contract: a hit is resolved IN the response, not
    // deferred to the SSE `install_done` event. Before the fix the worker
    // returned `{ started: true }` and completion rode the SSE event.
    expect(body.completed).toBe(true);
    expect(body.ok).toBe(true);
    expect(body.started).toBeUndefined();

    // The materialize actually ran and the marker was written.
    expect(fs.existsSync(path.join(workspaceDir, "node_modules", ".materialized"))).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, ".shipit", ".install-done"))).toBe(true);

    // /install/status reflects a settled, successful run.
    const statusRes = await fetch(`${workerUrl}/install/status`);
    const status = await statusRes.json() as { running?: boolean; lastResult?: { ok?: boolean } };
    expect(status.running).toBe(false);
    expect(status.lastResult?.ok).toBe(true);
  });

  it("runInstall + _startAgentViaProxy resolve and start the agent on the fast path with NO viewer", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "fast-gate-no-viewer",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    try {
      // Production spawn-child / headless shape: no viewer ever attaches.
      const proxy = runner.createAgent("claude");
      const proxyDone = new Promise<number>((resolve) => proxy.on("done", (c: number) => resolve(c)));

      const installResult = await withTimeout(runner.runInstall(["npm ci"]), 5000, "runInstall (fast path)");
      expect(installResult.ok).toBe(true);

      await withTimeout(
        runner._startAgentViaProxy("claude", { prompt: "fast-path no-viewer", cwd: "/workspace" }),
        5000,
        "_startAgentViaProxy (behind fast-install gate)",
      );

      await waitFor(() => lastAgent?.runCalled, 3000, "agent.run() on worker");
      expect(lastAgent.lastParams?.prompt).toBe("fast-path no-viewer");

      lastAgent.emit("event", { type: "agent_result", status: "success", sessionId: "s1" });
      lastAgent.emit("done", 0);
      const code = await withTimeout(proxyDone, 3000, "proxy done");
      expect(code).toBe(0);
    } finally {
      runner.dispose({ force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3 + 4 — stub workers isolating gate resolution from SSE delivery
// ---------------------------------------------------------------------------

interface StubOpts {
  /** Response body for POST /install. */
  installResponse: Record<string, unknown>;
  /** GET /install/status body (worker's view). */
  status: { running: boolean; lastResult: { ok: boolean; message?: string; command?: string } | null };
  /** If true, the SSE /events stream NEVER emits install_done. */
}

/**
 * Minimal stub worker: a valid SSE /events endpoint that stays open but never
 * emits `install_done`, plus configurable POST /install + GET /install/status.
 * This lets us prove the orchestrator resolves the gate WITHOUT any SSE
 * `install_done` — either from the HTTP response (Test 3) or the first-connect
 * `/install/status` resync (Test 4).
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

describe("Integration: fast-install gate — resolution without SSE install_done (docs/162)", () => {
  let stub: { app: FastifyInstance; url: string; agentStarted: () => boolean } | null = null;

  afterEach(async () => {
    if (stub) { await stub.app.close(); stub = null; }
    await new Promise((r) => setTimeout(r, 20));
  });

  it("resolves the gate from the { completed: true } HTTP response (SSE never delivers install_done)", async () => {
    // /install/status reports STILL running, so the resync backstop CANNOT
    // resolve the gate — only the HTTP-response path can. This isolates the
    // primary fix.
    stub = await startStubWorker({
      installResponse: { completed: true, ok: true },
      status: { running: true, lastResult: null },
    });

    const runner = new ContainerSessionRunner({
      sessionId: "gate-http-only",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl: stub.url,
    });

    try {
      const result = await withTimeout(runner.runInstall(["npm ci"]), 5000, "runInstall (HTTP-resolved gate)");
      expect(result.ok).toBe(true);

      // And the agent gate unblocks → /agent/start is POSTed.
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

// ---------------------------------------------------------------------------
// helper: recompute the seeded store dir (kept out of seedStore to avoid the
// half-built directory dance in setup).
// ---------------------------------------------------------------------------
function computeStoreDir(storeRoot: string, workspaceDir: string, command: string): string {
  const lockfile = findLockfile(workspaceDir);
  if (!lockfile) throw new Error("test setup: workspace has no single lockfile");
  const storeKey = computeStoreKey({
    lockfile,
    runtimeKey: runtimeKey(),
    installCommand: tuneNpmInstall(command),
  });
  return path.join(storeRoot, storeKey);
}
