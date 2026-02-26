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
import { SessionWorker } from "../session-worker.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import type { AgentProcess, AgentProcessEvents, AgentId, AgentRunParams } from "../agents/agent-process.js";

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
    supportedPermissionModes: [] as import("../types.js").PermissionMode[],
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
    const match = address.match(/:(\d+)$/);
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
      idleTimeoutMs: 60_000,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    // Use createAgent (the path used by dynamic agentFactory)
    const proxy = runner.createAgent("claude");
    expect(proxy.agentId).toBe("claude");

    // Call run() — fire-and-forget POST to worker
    proxy.run({ prompt: "Hello from proxy", cwd: "/some/host/path" });

    // Wait for the worker to receive the request
    await waitFor(() => lastAgent?.runCalled === true, 3000, "agent.run()");

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
      idleTimeoutMs: 60_000,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxy = runner.createAgent("claude");

    const events: Array<{ type: string }> = [];
    proxy.on("event", (event: { type: string }) => events.push(event));

    const donePromise = new Promise<number>((resolve) => {
      proxy.on("done", (code: number) => resolve(code));
    });

    // Start the agent via proxy
    proxy.run({ prompt: "Event test", cwd: "/workspace" });
    await waitFor(() => lastAgent?.runCalled === true, 3000, "agent.run()");

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

  // ---- proxy.interrupt() ----

  it("proxy.interrupt() POSTs to worker /agent/interrupt", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-proxy-interrupt",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
      idleTimeoutMs: 60_000,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxy = runner.createAgent("claude");
    proxy.run({ prompt: "Interrupt me", cwd: "/workspace" });
    await waitFor(() => lastAgent?.runCalled === true, 3000, "agent.run()");

    // Interrupt via proxy
    proxy.interrupt();
    await waitFor(() => lastAgent?.interrupted === true, 3000, "agent.interrupted");

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
      idleTimeoutMs: 60_000,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxy = runner.createAgent("claude");
    proxy.run({ prompt: "Ask me something", cwd: "/workspace" });
    await waitFor(() => lastAgent?.runCalled === true, 3000, "agent.run()");

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
      idleTimeoutMs: 60_000,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxy = runner.createAgent("claude");
    proxy.run({ prompt: "Kill me", cwd: "/workspace" });
    await waitFor(() => lastAgent?.runCalled === true, 3000, "agent.run()");

    // Kill via proxy
    proxy.kill();
    await waitFor(() => lastAgent?.killed === true, 3000, "agent.killed");

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
      idleTimeoutMs: 60_000,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    // First run
    const proxy1 = runner.createAgent("claude");
    proxy1.run({ prompt: "First run", cwd: "/workspace" });
    await waitFor(() => lastAgent?.runCalled === true, 3000, "first agent.run()");

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
    await waitFor(() => lastAgent?.runCalled === true && lastAgent !== firstAgent, 3000, "second agent.run()");

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
      idleTimeoutMs: 60_000,
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

  // ---- auth_required ----

  it("proxy receives auth_required event via SSE", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-proxy-auth",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
      idleTimeoutMs: 60_000,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxy = runner.createAgent("claude");

    const authPromise = new Promise<void>((resolve) => {
      proxy.on("auth_required", () => resolve());
    });

    proxy.run({ prompt: "Auth test", cwd: "/workspace" });
    await waitFor(() => lastAgent?.runCalled === true, 3000, "agent.run()");

    // Simulate auth event on worker
    lastAgent.emit("auth_required");

    await authPromise; // Should resolve without timeout

    runner.dispose();
  });
});
