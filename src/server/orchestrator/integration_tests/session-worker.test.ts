/**
 * Integration tests for the Session Worker IPC layer.
 *
 * Tests the round-trip: orchestrator → HTTP → SessionWorker → AgentProcess
 * → SSE → ContainerSessionRunner → event emission.
 *
 * The worker runs as an in-process Fastify server (not a subprocess or Docker
 * container) to keep tests fast and deterministic.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
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
  };

  runCalled = false;
  lastParams: AgentRunParams | null = null;
  killed = false;
  interrupted = false;
  stdinData: string[] = [];

  run(params: AgentRunParams): void {
    this.runCalled = true;
    this.lastParams = params;
  }

  writeStdin(data: string): void {
    this.stdinData.push(data);
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

/** Wait for a condition to become true, polling every 50ms. */
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

describe("Integration: Session Worker IPC", () => {
  let worker: SessionWorker;
  let lastAgent: FakeWorkerAgent;
  let workerPort: number;
  let workerUrl: string;

  beforeEach(async () => {
    lastAgent = null as unknown as FakeWorkerAgent;

    worker = new SessionWorker({
      agentFactory: () => {
        lastAgent = new FakeWorkerAgent();
        return lastAgent;
      },
      port: 0, // Ephemeral port
      host: "127.0.0.1",
    });

    const address = await worker.start();
    const match = /:(\d+)$/.exec(address);
    workerPort = match ? Number(match[1]) : 0;
    workerUrl = `http://127.0.0.1:${workerPort}`;
  });

  afterEach(async () => {
    await worker.stop();
    // Small delay for cleanup
    await new Promise((r) => setTimeout(r, 50));
  });

  // ---- Worker health check ----

  it("worker responds to health check", async () => {
    const res = await worker.getApp().inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", mode: "session" });
  });

  // ---- Agent start/status ----

  it("starts an agent on the worker", async () => {
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/start",
      payload: {
        agentId: "claude",
        params: { prompt: "Hello world", cwd: "/tmp" },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ started: true });
    expect(lastAgent.runCalled).toBe(true);
    expect(lastAgent.lastParams?.prompt).toBe("Hello world");

    // Status should show running
    const status = await worker.getApp().inject({ method: "GET", url: "/agent/status" });
    expect(status.json()).toEqual({ running: true });
  });

  it("rejects starting a second agent while one is running", async () => {
    await worker.getApp().inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "First" } },
    });

    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "Second" } },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("already running");
  });

  // ---- Agent interrupt/kill ----

  it("interrupts a running agent", async () => {
    await worker.getApp().inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "Work" } },
    });

    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/interrupt",
    });

    expect(res.statusCode).toBe(200);
    expect(lastAgent.interrupted).toBe(true);
  });

  it("kills a running agent", async () => {
    await worker.getApp().inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "Work" } },
    });

    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/kill",
    });

    expect(res.statusCode).toBe(200);
    expect(lastAgent.killed).toBe(true);

    // Status should now be not running
    const status = await worker.getApp().inject({ method: "GET", url: "/agent/status" });
    expect(status.json()).toEqual({ running: false });
  });

  it("returns 404 when interrupting with no agent", async () => {
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/interrupt",
    });
    expect(res.statusCode).toBe(404);
  });

  // ---- Stdin ----

  it("writes to agent stdin", async () => {
    await worker.getApp().inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "Work" } },
    });

    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/stdin",
      payload: { data: "yes\n" },
    });

    expect(res.statusCode).toBe(200);
    expect(lastAgent.stdinData).toEqual(["yes\n"]);
  });

  // ---- SSE event streaming ----

  it("streams agent events via SSE to proxy agent on ContainerSessionRunner", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-session",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    // Attach a viewer so the SSE connection is established
    runner.attachViewer();

    // Give SSE connection time to establish
    await new Promise((r) => setTimeout(r, 200));

    // Start an agent on the worker — returns a proxy that receives SSE events
    const proxy = await runner.startAgentOnWorker("claude", {
      prompt: "Write a test",
      cwd: "/workspace",
    });

    expect(lastAgent.runCalled).toBe(true);

    // Collect events on the proxy agent
    const agentEvents: { type: string }[] = [];
    proxy.on("event", (event: { type: string }) => {
      agentEvents.push(event);
    });

    // Wait for result event to propagate through SSE
    const resultPromise = new Promise<void>((resolve) => {
      proxy.on("event", (event: { type: string }) => {
        if (event.type === "agent_result") resolve();
      });
    });

    // Simulate agent events on the worker side
    lastAgent.emit("event", {
      type: "agent_init",
      agentId: "claude",
      sessionId: "agent-session-1",
      model: "claude-sonnet-4-6",
      tools: ["Read", "Write", "Bash"],
    });

    lastAgent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Here is the test code" }],
    });

    lastAgent.emit("event", {
      type: "agent_result",
      status: "success",
      sessionId: "agent-session-1",
      cost: { totalUsd: 0.01 },
      durationMs: 500,
    });

    // Wait for all events to arrive
    await resultPromise;

    // Verify the proxy agent received all three event types
    const eventTypes = agentEvents.map((e) => e.type);
    expect(eventTypes).toContain("agent_init");
    expect(eventTypes).toContain("agent_assistant");
    expect(eventTypes).toContain("agent_result");

    runner.dispose();
  });

  it("streams agent done event via SSE", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-done",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxy = await runner.startAgentOnWorker("claude", {
      prompt: "Done test",
      cwd: "/workspace",
    });

    // Listen for the done event on the proxy
    const donePromise = new Promise<number>((resolve) => {
      proxy.on("done", (exitCode: number) => resolve(exitCode));
    });

    // Simulate agent completion
    lastAgent.emit("done", 0);

    const exitCode = await donePromise;
    expect(exitCode).toBe(0);

    runner.dispose();
  });

  it("streams agent error event via SSE", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-error",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxy = await runner.startAgentOnWorker("claude", {
      prompt: "Error test",
      cwd: "/workspace",
    });

    const errorPromise = new Promise<string>((resolve) => {
      proxy.on("error", (err: Error) => resolve(err.message));
    });

    lastAgent.emit("error", new Error("Agent crashed"));

    const message = await errorPromise;
    expect(message).toBe("Agent crashed");

    runner.dispose();
  });

  it("streams agent log events via SSE", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-log",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxy = await runner.startAgentOnWorker("claude", {
      prompt: "Log test",
      cwd: "/workspace",
    });

    const logPromise = new Promise<{ source: string; text: string }>((resolve) => {
      proxy.on("log", (source: string, text: string) => resolve({ source, text }));
    });

    lastAgent.emit("log", "stderr", "Some debug output");

    const log = await logPromise;
    expect(log.source).toBe("stderr");
    expect(log.text).toBe("Some debug output");

    runner.dispose();
  });

  // ---- ContainerSessionRunner interface compliance ----

  it("implements SessionRunnerInterface state management", () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-state",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    // Agent state
    expect(runner.running).toBe(false);
    runner.running = true;
    expect(runner.running).toBe(true);

    expect(runner.wasInterrupted).toBe(false);
    runner.wasInterrupted = true;
    expect(runner.wasInterrupted).toBe(true);

    expect(runner.accumulatedText).toBe("");
    runner.accumulatedText = "Hello";
    expect(runner.accumulatedText).toBe("Hello");

    expect(runner.turnSummary).toBe("");
    runner.turnSummary = "Did stuff";
    expect(runner.turnSummary).toBe("Did stuff");

    // Message queue
    expect(runner.queueLength).toBe(0);
    runner.enqueue({ text: "msg1" });
    expect(runner.queueLength).toBe(1);
    expect(runner.getQueueSnapshot()).toEqual([{ text: "msg1", position: 1 }]);

    const dequeued = runner.dequeue();
    expect(dequeued?.text).toBe("msg1");
    expect(runner.queueLength).toBe(0);

    // Turn event buffer
    expect(runner.getTurnEventBuffer()).toEqual([]);
    runner.emitMessage({ type: "error", message: "test" });
    expect(runner.getTurnEventBuffer().length).toBe(1);
    runner.clearTurnEventBuffer();
    expect(runner.getTurnEventBuffer()).toEqual([]);

    // Detected ports
    expect(runner.detectedPorts).toEqual([]);
    runner.detectedPorts = [3000, 8080];
    expect(runner.detectedPorts).toEqual([3000, 8080]);

    // Viewer management
    expect(runner.viewerCount).toBe(0);

    // Preview (Phase 3 — returns null)
    expect(runner.getPreview()).toBeNull();
    expect(runner.getFileWatcher()).toBeNull();

    // Lifecycle
    expect(runner.disposed).toBe(false);
    runner.dispose();
    expect(runner.disposed).toBe(true);
  });

  it("emits 'disposed' event on dispose", () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-dispose",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    let disposed = false;
    runner.on("disposed", () => { disposed = true; });

    runner.dispose();
    expect(disposed).toBe(true);
  });

  it("interrupts agent on worker via ContainerSessionRunner", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-interrupt",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    await runner.startAgentOnWorker("claude", {
      prompt: "Interrupt me",
      cwd: "/workspace",
    });

    await runner.interruptAgentOnWorker();
    expect(lastAgent.interrupted).toBe(true);

    runner.dispose();
  });

  it("writes stdin to agent on worker via ContainerSessionRunner", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-stdin",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    await runner.startAgentOnWorker("claude", {
      prompt: "Ask me",
      cwd: "/workspace",
    });

    await runner.writeAgentStdin("yes\n");
    expect(lastAgent.stdinData).toEqual(["yes\n"]);

    runner.dispose();
  });

  // ---- Agent cleanup on done ----

  it("clears agent reference after done event", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-cleanup",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    await runner.startAgentOnWorker("claude", {
      prompt: "Quick job",
      cwd: "/workspace",
    });

    // Agent status on worker is running
    const before = await worker.getApp().inject({ method: "GET", url: "/agent/status" });
    expect(before.json().running).toBe(true);

    // Complete the agent
    lastAgent.emit("event", {
      type: "agent_result",
      status: "success",
      sessionId: "s1",
    });
    lastAgent.emit("done", 0);

    // Wait for the done event to propagate
    await waitFor(() => {
      void worker.getApp().inject({ method: "GET", url: "/agent/status" });
      return true; // The agent reference is cleared in the worker's done handler
    }, 1000, "agent cleared");

    // Status should show not running
    const after = await worker.getApp().inject({ method: "GET", url: "/agent/status" });
    expect(after.json().running).toBe(false);

    runner.dispose();
  });
});
