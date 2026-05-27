/**
 * Integration tests for the container agent wiring — validates that
 * ProxyAgentProcess.run()/interrupt()/kill()/writeStdin() delegate to the
 * worker via HTTP, and that events flow back via SSE.
 *
 * These tests exercise the createAgent() + proxy.run() path (used by the
 * dynamic agentFactory in index.ts) rather than the startAgentOnWorker()
 * convenience method.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionWorker } from "../../session/session-worker.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import type { AgentProcess, AgentProcessEvents, AgentId, AgentRunParams, PermissionMode } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Fake AgentProcess for worker tests
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
  };

  runCalled = false;
  lastParams: AgentRunParams | null = null;
  killed = false;
  interrupted = false;
  stdinData: string[] = [];
  readonly isStreaming = false;

  run(params: AgentRunParams): void {
    this.runCalled = true;
    this.lastParams = params;
  }

  writeStdin(data: string): void {
    this.stdinData.push(data);
  }

  sendUserMessage(text: string): void {
    this.writeStdin(text);
  }

  interrupt(): void {
    this.interrupted = true;
    setTimeout(() => this.emit("done", 1), 10);
  }

  kill(): void {
    this.killed = true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitFor(
  fn: () => boolean,
  timeoutMs = 3000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: Container Agent Wiring (createAgent + proxy)", () => {
  let worker: SessionWorker;
  let lastAgent: FakeWorkerAgent;
  let workerUrl: string;

  beforeEach(async () => {
    lastAgent = null as unknown as FakeWorkerAgent;

    worker = new SessionWorker({
      agentFactory: () => {
        lastAgent = new FakeWorkerAgent();
        return lastAgent;
      },
      port: 0,
      host: "127.0.0.1",
    });

    const address = await worker.start();
    const match = /:(\d+)$/.exec(address);
    const port = match ? Number(match[1]) : 0;
    workerUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await worker.stop();
    await new Promise((r) => setTimeout(r, 50));
  });

  // ---- createAgent + proxy.run() ----

  it("proxy.run() POSTs to worker /agent/start and agent runs inside worker", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-proxy-run",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    // Use createAgent (the path used by dynamic agentFactory)
    const proxy = runner.createAgent("claude");
    expect(proxy.agentId).toBe("claude");

    // Call run() — fire-and-forget POST to worker
    proxy.run({ prompt: "Hello from proxy", cwd: "/some/host/path" });

    // Wait for the worker to receive the request
    await waitFor(() => lastAgent?.runCalled, 3000, "agent.run()");

    expect(lastAgent.lastParams?.prompt).toBe("Hello from proxy");
    // The worker overrides cwd to /workspace (session-worker.ts fix)
    expect(lastAgent.lastParams?.cwd).toBe("/workspace");

    runner.dispose();
  });

  it("proxy receives events via SSE after run()", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-proxy-events",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxy = runner.createAgent("claude");

    const events: { type: string }[] = [];
    proxy.on("event", (event: { type: string }) => events.push(event));

    const donePromise = new Promise<number>((resolve) => {
      proxy.on("done", (code: number) => resolve(code));
    });

    // Start the agent via proxy
    proxy.run({ prompt: "Event test", cwd: "/workspace" });
    await waitFor(() => lastAgent?.runCalled, 3000, "agent.run()");

    // Simulate events on the worker side
    lastAgent.emit("event", {
      type: "agent_init",
      agentId: "claude",
      sessionId: "s1",
      model: "claude-sonnet-4-6",
      tools: ["Read"],
    });

    lastAgent.emit("event", {
      type: "agent_result",
      status: "success",
      sessionId: "s1",
    });

    lastAgent.emit("done", 0);

    const exitCode = await donePromise;
    expect(exitCode).toBe(0);
    expect(events.some((e) => e.type === "agent_init")).toBe(true);
    expect(events.some((e) => e.type === "agent_result")).toBe(true);

    runner.dispose();
  });

  // Regression for the spawn-path SSE race: when an agent spawns a child
  // session via `shipit session create`, the orchestrator calls
  // `runner.dispatch(...)` synchronously after creating the
  // runner — no viewer is attached, so `attachViewer()` has not connected
  // SSE first. If `/agent/start` is POSTed before SSE is connected, the
  // worker's first agent events stream to a channel with no listener and
  // are dropped (the worker's `GET /events` does not replay agent events).
  // The runner is stuck at running=true with no output forever.
  //
  // Without the fix in `_startAgentViaProxy` (await SSE before POST),
  // this test races and intermittently misses the first event.
  it("proxy.run() receives events when called without prior attachViewer (spawn-path)", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-proxy-no-attach",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    // Deliberately do NOT call attachViewer — exercises the spawn path
    // where runner.dispatch runs before any viewer connects.
    const proxy = runner.createAgent("claude");

    const events: { type: string }[] = [];
    proxy.on("event", (event: { type: string }) => events.push(event));

    const donePromise = new Promise<number>((resolve) => {
      proxy.on("done", (code: number) => resolve(code));
    });

    proxy.run({ prompt: "Spawn-path test", cwd: "/workspace" });
    await waitFor(() => lastAgent?.runCalled, 3000, "agent.run()");

    // Emit events on the worker side immediately — these would be lost
    // if SSE were connected only after the POST returned.
    lastAgent.emit("event", {
      type: "agent_init",
      agentId: "claude",
      sessionId: "s1",
      model: "claude-sonnet-4-6",
      tools: ["Read"],
    });
    lastAgent.emit("event", {
      type: "agent_result",
      status: "success",
      sessionId: "s1",
    });
    lastAgent.emit("done", 0);

    const exitCode = await donePromise;
    expect(exitCode).toBe(0);
    expect(events.some((e) => e.type === "agent_init")).toBe(true);
    expect(events.some((e) => e.type === "agent_result")).toBe(true);

    runner.dispose();
  });

  // ---- proxy.interrupt() ----

  it("proxy.interrupt() POSTs to worker /agent/interrupt", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-proxy-interrupt",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxy = runner.createAgent("claude");
    proxy.run({ prompt: "Interrupt me", cwd: "/workspace" });
    await waitFor(() => lastAgent?.runCalled, 3000, "agent.run()");

    // Interrupt via proxy
    proxy.interrupt();
    await waitFor(() => lastAgent?.interrupted, 3000, "agent.interrupted");

    expect(lastAgent.interrupted).toBe(true);

    runner.dispose();
  });

  // ---- proxy.writeStdin() ----

  it("proxy.writeStdin() POSTs to worker /agent/stdin", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-proxy-stdin",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxy = runner.createAgent("claude");
    proxy.run({ prompt: "Ask me something", cwd: "/workspace" });
    await waitFor(() => lastAgent?.runCalled, 3000, "agent.run()");

    // Write stdin via proxy
    proxy.writeStdin("yes\n");
    await waitFor(() => lastAgent?.stdinData.length > 0, 3000, "stdin data");

    expect(lastAgent.stdinData).toEqual(["yes\n"]);

    runner.dispose();
  });

  // ---- proxy.kill() ----

  it("proxy.kill() POSTs to worker /agent/kill", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-proxy-kill",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxy = runner.createAgent("claude");
    proxy.run({ prompt: "Kill me", cwd: "/workspace" });
    await waitFor(() => lastAgent?.runCalled, 3000, "agent.run()");

    // Kill via proxy
    proxy.kill();
    await waitFor(() => lastAgent?.killed, 3000, "agent.killed");

    expect(lastAgent.killed).toBe(true);

    runner.dispose();
  });

  // ---- Sequential agent runs ----

  it("supports sequential agent runs (new proxy after done)", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-proxy-sequential",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    // First run
    const proxy1 = runner.createAgent("claude");
    proxy1.run({ prompt: "First run", cwd: "/workspace" });
    await waitFor(() => lastAgent?.runCalled, 3000, "first agent.run()");

    const firstAgent = lastAgent;
    expect(firstAgent.lastParams?.prompt).toBe("First run");

    // Complete first run
    firstAgent.emit("event", { type: "agent_result", status: "success", sessionId: "s1" });
    firstAgent.emit("done", 0);

    // Wait for done event and worker to clear agent
    await new Promise((r) => setTimeout(r, 200));

    // Second run (simulates answer_question creating a new agent)
    const proxy2 = runner.createAgent("claude");
    proxy2.run({ prompt: "Second run", sessionId: "s1", cwd: "/workspace" });
    await waitFor(() => lastAgent?.runCalled && lastAgent !== firstAgent, 3000, "second agent.run()");

    expect(lastAgent.lastParams?.prompt).toBe("Second run");

    runner.dispose();
  });

  // ---- Error handling ----

  it("proxy.run() emits error when worker is unreachable", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-proxy-error",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl: "http://127.0.0.1:1", // unreachable
    });

    const proxy = runner.createAgent("claude");

    const errorPromise = new Promise<Error>((resolve) => {
      proxy.on("error", (err: Error) => resolve(err));
    });

    proxy.run({ prompt: "This will fail", cwd: "/workspace" });

    const err = await errorPromise;
    expect(err).toBeInstanceOf(Error);

    runner.dispose();
  });

  // Regression: the worker rejects /agent/start with 409 if `this.agent` is
  // still set when the new request lands. That happens in a microseconds-wide
  // race after `agent_done` but before the worker's done handler clears the
  // slot. _startAgentViaProxy retries once after 150ms — long enough to let
  // the worker finish its cleanup.
  it("_startAgentViaProxy retries once on 409 'Agent already running'", async () => {
    // Pre-occupy the worker's agent slot so the next POST /agent/start gets
    // 409 — simulates the race where a previous turn's cleanup hasn't run yet.
    const preStartRes = await fetch(`${workerUrl}/agent/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "claude", params: { prompt: "occupier" } }),
    });
    expect(preStartRes.status).toBe(200);
    const occupier = lastAgent;
    expect(occupier).toBeTruthy();

    const runner = new ContainerSessionRunner({
      sessionId: "test-409-retry",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });
    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    // Within the 150ms retry window, free the slot by emitting `done` on the
    // occupier — its wireAgentEvents listener sets `worker.this.agent = null`.
    setTimeout(() => occupier.emit("done", 0), 50);

    // _startAgentViaProxy: first attempt → 409, wait 150ms, retry → success.
    await runner._startAgentViaProxy("claude", { prompt: "retry-me", cwd: "/workspace" });

    // The retry should have started a NEW agent on the worker for our prompt.
    await waitFor(
      () => lastAgent !== occupier && lastAgent.lastParams?.prompt === "retry-me",
      3000,
      "retry agent started",
    );
    expect(lastAgent.lastParams?.prompt).toBe("retry-me");

    runner.dispose();
  });

  // docs/142 (B2): if the retry ALSO 409s, the worker is holding a stale agent
  // that won't clear on its own (e.g. a persistent streaming process whose turn
  // errored without exiting). _startAgentViaProxy is only reached when the
  // orchestrator believes no turn is active, so a lingering worker agent is a
  // desync — kill it and start fresh rather than stranding the session.
  it("_startAgentViaProxy kills the stale agent and restarts when the slot stays busy", async () => {
    // Pre-occupy and DON'T release — both /agent/start attempts will 409, so
    // recovery must go through the kill path.
    const preStartRes = await fetch(`${workerUrl}/agent/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "claude", params: { prompt: "stuck" } }),
    });
    expect(preStartRes.status).toBe(200);
    const stale = lastAgent;
    expect(stale).toBeTruthy();

    const runner = new ContainerSessionRunner({
      sessionId: "test-409-kill-restart",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });
    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    // First attempt → 409, retry → 409, kill the stale agent (frees the slot),
    // start fresh → success.
    await runner._startAgentViaProxy("claude", { prompt: "wont-fit", cwd: "/workspace" });

    // The stale agent was killed, and a brand-new agent started for our prompt.
    expect(stale.killed).toBe(true);
    await waitFor(
      () => lastAgent !== stale && lastAgent.lastParams?.prompt === "wont-fit",
      3000,
      "restarted agent",
    );
    expect(lastAgent.lastParams?.prompt).toBe("wont-fit");

    runner.dispose();
  });

  // ---- auth_required ----

  it("proxy receives auth_required event via SSE", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-proxy-auth",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxy = runner.createAgent("claude");

    const authPromise = new Promise<void>((resolve) => {
      proxy.on("auth_required", () => resolve());
    });

    proxy.run({ prompt: "Auth test", cwd: "/workspace" });
    await waitFor(() => lastAgent?.runCalled, 3000, "agent.run()");

    // Simulate auth event on worker
    lastAgent.emit("auth_required");

    await authPromise; // Should resolve without timeout

    runner.dispose();
  });

  // ---- tryPushAgentSecrets (docs/088 compose-less agent-env path) ----

  describe("tryPushAgentSecrets()", () => {
    it("pushes account-level agent env into the worker's process.env", async () => {
      const runner = new ContainerSessionRunner({
        sessionId: "test-push-agent-env",
        sessionDir: "/tmp/test",
        defaultAgentId: "claude",
        workerUrl,
      });

      const key = "mcp__test__PUSH_KEY";
      try {
        await runner.tryPushAgentSecrets({ [key]: "secret-value" });
        // Worker runs in-process in this test — PUT /secrets mutates the
        // shared process.env directly.
        expect(process.env[key]).toBe("secret-value");

        // A subsequent push REPLACES the tracked set: the old key is unset.
        await runner.tryPushAgentSecrets({});
        expect(process.env[key]).toBeUndefined();
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- test cleanup of a fixed key
        delete process.env[key];
        runner.dispose();
      }
    });

    it("resolves without throwing when the worker is unreachable", async () => {
      const runner = new ContainerSessionRunner({
        sessionId: "test-push-unreachable",
        sessionDir: "/tmp/test",
        defaultAgentId: "claude",
        workerUrl: "http://127.0.0.1:1", // unreachable
      });

      // Must not throw — callers (agent-execution.ts) await this on the
      // hot path and a transient worker failure must not abort the turn.
      await expect(
        runner.tryPushAgentSecrets({ mcp__test__KEY: "v" }),
      ).resolves.toBeUndefined();

      runner.dispose();
    });
  });

  // ---- verifyRunningState (stuck running flag recovery) ----

  describe("verifyRunningState() stuck-running recovery", () => {
    it("returns false and resets running=true when worker reports no agent", async () => {
      // Reproduces the user-visible bug: orchestrator missed `agent_done`
      // (e.g. SSE drop mid-turn) so `running=true` is stuck. Without
      // verifyRunningState() the next send_message would queue forever.
      const runner = new ContainerSessionRunner({
        sessionId: "test-stuck-running",
        sessionDir: "/tmp/test",
        defaultAgentId: "claude",
        workerUrl,
      });

      runner.attachViewer();
      await new Promise((r) => setTimeout(r, 200));

      // Simulate the stuck-running state: orchestrator thinks agent is
      // running, but the worker has no agent (the terminal SSE event
      // never arrived).
      runner.running = true;
      // Sanity check: worker has no agent active.
      expect(lastAgent).toBeNull();

      // Listen for the recovery session_status broadcast.
      const messages: { type: string; running?: boolean; error?: string }[] = [];
      runner.on("message", (m: { type: string; running?: boolean; error?: string }) => messages.push(m));

      const idlePromise = new Promise<void>((resolve) => {
        runner.once("idle", () => resolve());
      });

      const actuallyRunning = await runner.verifyRunningState();

      expect(actuallyRunning).toBe(false);
      expect(runner.running).toBe(false);
      expect(runner.getAgent()).toBeNull();

      // Recovery session_status should be emitted to all viewers.
      const recovery = messages.find((m) => m.type === "session_status" && m.running === false);
      expect(recovery).toBeDefined();
      expect(recovery?.error).toMatch(/out of sync/i);

      // Idle event fires so the runner can be reclaimed normally.
      await idlePromise;

      runner.dispose();
    });

    it("returns true and preserves state when worker confirms agent is running", async () => {
      const runner = new ContainerSessionRunner({
        sessionId: "test-confirmed-running",
        sessionDir: "/tmp/test",
        defaultAgentId: "claude",
        workerUrl,
      });

      runner.attachViewer();
      await new Promise((r) => setTimeout(r, 200));

      // Start an agent through the proxy, then check verification agrees.
      const proxy = runner.createAgent("claude");
      proxy.run({ prompt: "Still running", cwd: "/workspace" });
      await waitFor(() => lastAgent?.runCalled, 3000, "agent.run()");

      runner.running = true;

      const actuallyRunning = await runner.verifyRunningState();

      expect(actuallyRunning).toBe(true);
      expect(runner.running).toBe(true);
      expect(runner.getAgent()).toBe(proxy);

      runner.dispose({ force: true });
    });

    it("returns false immediately without HTTP call when running is already false", async () => {
      const runner = new ContainerSessionRunner({
        sessionId: "test-already-idle",
        sessionDir: "/tmp/test",
        defaultAgentId: "claude",
        workerUrl,
      });

      // No attach — no SSE setup needed; the early-return path skips HTTP.
      expect(runner.running).toBe(false);
      const actuallyRunning = await runner.verifyRunningState();
      expect(actuallyRunning).toBe(false);

      runner.dispose();
    });

    it("keeps running=true when worker is unreachable (defensive fallback)", async () => {
      // If we can't reach the worker, we can't safely declare the agent
      // dead — the SSE reconnect loop should recover instead.
      const runner = new ContainerSessionRunner({
        sessionId: "test-unreachable",
        sessionDir: "/tmp/test",
        defaultAgentId: "claude",
        workerUrl: "http://127.0.0.1:1", // unreachable
      });

      runner.running = true;

      const actuallyRunning = await runner.verifyRunningState();

      expect(actuallyRunning).toBe(true);
      expect(runner.running).toBe(true);

      runner.dispose({ force: true });
    });
  });
});

// ---------------------------------------------------------------------------
// Regression: spawn-child install-gate deadlock
// ---------------------------------------------------------------------------
//
// Sessions spawned by an agent (`shipit session create -p "..."`) never get a
// viewer attached at dispatch time, so nothing on the orchestrator side calls
// `attachViewer()` — the only other caller of `ensureWorkerResourcesStarted()`.
// `_startAgentViaProxy` used to await `_waitForInstallBeforeAgent()` BEFORE
// kicking SSE setup, so the install-gate promise (resolved by the SSE-delivered
// `install_done` event) never resolved: the orchestrator never opened its end
// of the pipe, the worker's `install_done` sat in the ring buffer forever, and
// `/agent/start` was never POSTed. The session showed `running=false` in the
// worker and no chat output, until a viewer happened to open it.
//
// These tests use a real SessionWorker against a tmp workspaceDir (so the
// `.shipit/.install-done` marker doesn't pollute the repo) and a trivial
// install command (`true`) so the worker's `runInstallCommands` finishes
// near-instantly. The key contract: with NO viewer attached, both
// `runner.runInstall(...)` and `runner._startAgentViaProxy(...)` must complete
// without anyone calling `attachViewer()`.
// ---------------------------------------------------------------------------

describe("Integration: spawn-child install gate (no viewer attached)", () => {
  let worker: SessionWorker;
  let lastAgent: FakeWorkerAgent;
  let workerUrl: string;
  let tmpWorkspace: string;

  beforeEach(async () => {
    lastAgent = null as unknown as FakeWorkerAgent;
    tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-install-gate-"));

    worker = new SessionWorker({
      agentFactory: () => {
        lastAgent = new FakeWorkerAgent();
        return lastAgent;
      },
      port: 0,
      host: "127.0.0.1",
      workspaceDir: tmpWorkspace,
    });

    const address = await worker.start();
    const match = /:(\d+)$/.exec(address);
    const port = match ? Number(match[1]) : 0;
    workerUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await worker.stop();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // ignore cleanup errors
    }
  });

  it("runInstall + _startAgentViaProxy resolve without a viewer attached (spawn-child path)", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-install-gate-no-viewer",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    try {
      // Deliberately do NOT call attachViewer(). This is the production
      // spawn-child shape: orchestrator creates the runner via
      // `onRunnerCreated` → `setupServiceManager` → `runInstall(...)`, then
      // `runner.dispatch(...)` → `_startAgentViaProxy(...)`. No WS viewer
      // ever attaches.
      //
      // Create the proxy BEFORE issuing the install/start so its SSE event
      // listener is wired by the time the worker emits agent events.
      const proxy = runner.createAgent("claude");
      const proxyDone = new Promise<number>((resolve) => {
        proxy.on("done", (code: number) => resolve(code));
      });

      const installPromise = runner.runInstall(["true"]);
      const startPromise = runner._startAgentViaProxy("claude", {
        prompt: "spawn-child no-viewer",
        cwd: "/workspace",
      });

      // Both must resolve. With the deadlock present, `runInstall` never
      // resolved because its `_installComplete` resolver is only ever
      // called from the SSE handler — and SSE was never connected.
      // `_startAgentViaProxy` chained on `_waitForInstallBeforeAgent` so it
      // never reached the `/agent/start` POST.
      const installResult = await Promise.race([
        installPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("runInstall deadlocked (no SSE consumer)")), 5000),
        ),
      ]);
      expect(installResult.ok).toBe(true);

      await Promise.race([
        startPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("_startAgentViaProxy deadlocked behind install gate")), 5000),
        ),
      ]);

      // The worker must have actually received /agent/start and instantiated
      // the agent.
      await waitFor(() => lastAgent?.runCalled, 3000, "agent.run() on worker");
      expect(lastAgent.lastParams?.prompt).toBe("spawn-child no-viewer");

      // Drive the agent through to completion via the worker → SSE pipe.
      // The proxy's `done` event must fire — proving that agent events flow
      // end-to-end on the spawn-child path with no viewer attached. This is
      // the user-visible guarantee: a spawned child runs to completion even
      // if nobody opens it in the UI.
      lastAgent.emit("event", { type: "agent_result", status: "success", sessionId: "s1" });
      lastAgent.emit("done", 0);
      const exitCode = await Promise.race([
        proxyDone,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("proxy never emitted done after worker agent_done")), 3000),
        ),
      ]);
      expect(exitCode).toBe(0);
    } finally {
      runner.dispose({ force: true });
    }
  });
});
