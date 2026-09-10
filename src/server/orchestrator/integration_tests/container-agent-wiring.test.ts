import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionWorker } from "../../session/session-worker.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import type { SystemTurnDeps } from "../session-runner.js";
import { prepareDispatch, type PreparedDispatch } from "../prepared-dispatch.js";
import { TURN_COMPLETED, type TurnOutcome } from "../turn-settlement.js";
import type { AgentProcess, AgentProcessEvents, AgentId, AgentRunParams, PermissionMode } from "../../shared/types.js";

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
    supportsCompaction: false,
    skillsDirName: ".claude",
    skillInvocationPrefix: "/",
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

  writeMcpConfig(): { mcpConfigPath?: string; runtimeEnv?: Record<string, string>; cleanup?: () => void } {
    return {};
  }
}

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

function makeDispatchStubbedRunner(
  sessionId: string,
  workerUrl: string,
): ContainerSessionRunner & { dispatched: PreparedDispatch[] } {
  const runner = new ContainerSessionRunner({
    sessionId,
    sessionDir: "/tmp/test",
    defaultAgentId: "claude",
    workerUrl,
  }) as ContainerSessionRunner & { dispatched: PreparedDispatch[] };
  // Dependencies only need to pass canRunDispatchedTurn; the executor is stubbed.
  runner.setSystemTurnDeps({} as SystemTurnDeps);
  runner.dispatched = [];
  runner.runDispatchedTurn = async (opts: PreparedDispatch): Promise<void> => {
    runner.dispatched.push(opts);
    return new Promise<void>(() => { /* never settles — the dropped-events case */ });
  };
  return runner;
}

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

  it("proxy.run() POSTs to worker /agent/start and agent runs inside worker", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-proxy-run",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxy = runner.createAgent("claude");
    expect(proxy.agentId).toBe("claude");

    proxy.run({ prompt: "Hello from proxy", cwd: "/some/host/path" });

    await waitFor(() => lastAgent?.runCalled, 3000, "agent.run()");

    expect(lastAgent.lastParams?.prompt).toBe("Hello from proxy");
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

    proxy.run({ prompt: "Event test", cwd: "/workspace" });
    await waitFor(() => lastAgent?.runCalled, 3000, "agent.run()");

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

  it("proxy.run() receives events when called without prior attachViewer (spawn-path)", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-proxy-no-attach",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    const proxy = runner.createAgent("claude");

    const events: { type: string }[] = [];
    proxy.on("event", (event: { type: string }) => events.push(event));

    const donePromise = new Promise<number>((resolve) => {
      proxy.on("done", (code: number) => resolve(code));
    });

    proxy.run({ prompt: "Spawn-path test", cwd: "/workspace" });
    await waitFor(() => lastAgent?.runCalled, 3000, "agent.run()");

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

  it("proxy.run() does not attach stale idle-worker replay to the fresh turn", async () => {
    const oldStart = await fetch(`${workerUrl}/agent/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "claude",
        params: { prompt: "old turn", cwd: "/workspace" },
      }),
    });
    expect(oldStart.status).toBe(200);
    const oldAgent = lastAgent;
    oldAgent.emit("event", {
      type: "agent_init",
      agentId: "claude",
      sessionId: "old-agent-session",
      model: "claude-sonnet-4-6",
      tools: [],
    });
    oldAgent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "STALE_REPLAY_CANARY" }],
    });
    oldAgent.emit("event", {
      type: "agent_result",
      status: "success",
      sessionId: "old-agent-session",
    });
    oldAgent.emit("done", 0);
    await waitFor(() => lastAgent === oldAgent, 500, "old agent still latest");

    const idleStatus = await fetch(`${workerUrl}/agent/status`);
    const idle = await idleStatus.json() as { running: boolean; latestSseSeq: number };
    expect(idle.running).toBe(false);
    expect(idle.latestSseSeq).toBeGreaterThan(0);

    const runner = new ContainerSessionRunner({
      sessionId: "test-stale-replay",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    const proxy = runner.createAgent("claude");
    const events: unknown[] = [];
    proxy.on("event", (event) => events.push(event));

    proxy.run({ prompt: "fresh turn", cwd: "/workspace" });
    await waitFor(() => lastAgent !== oldAgent && lastAgent?.runCalled, 3000, "fresh agent.run()");
    expect(lastAgent.lastParams?.prompt).toBe("fresh turn");

    await new Promise((r) => setTimeout(r, 150));
    expect(JSON.stringify(events)).not.toContain("STALE_REPLAY_CANARY");

    lastAgent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "fresh output" }],
    });
    await waitFor(
      () => JSON.stringify(events).includes("fresh output"),
      3000,
      "fresh event delivered",
    );

    lastAgent.emit("done", 0);
    runner.dispose();
  });

  it("attaching a viewer before a fresh turn does not replay the prior completed turn (post-restart double-render)", async () => {
    const oldStart = await fetch(`${workerUrl}/agent/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "claude",
        params: { prompt: "old turn", cwd: "/workspace" },
      }),
    });
    expect(oldStart.status).toBe(200);
    const oldAgent = lastAgent;
    oldAgent.emit("event", {
      type: "agent_init",
      agentId: "claude",
      sessionId: "old-agent-session",
      model: "claude-sonnet-4-6",
      tools: [],
    });
    oldAgent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "STALE_REPLAY_CANARY" }],
    });
    oldAgent.emit("event", {
      type: "agent_result",
      status: "success",
      sessionId: "old-agent-session",
    });
    oldAgent.emit("done", 0);
    await waitFor(() => lastAgent === oldAgent, 500, "old agent still latest");

    const idleStatus = await fetch(`${workerUrl}/agent/status`);
    const idle = await idleStatus.json() as { running: boolean; latestSseSeq: number };
    expect(idle.running).toBe(false);
    expect(idle.latestSseSeq).toBeGreaterThan(0);

    const runner = new ContainerSessionRunner({
      sessionId: "test-viewer-stale-replay",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    // Create the proxy synchronously, before attachViewer's async SSE setup resumes.
    runner.attachViewer();
    const proxy = runner.createAgent("claude");
    const events: unknown[] = [];
    proxy.on("event", (event) => events.push(event));

    // Allow stale replay to arrive before checking the canary.
    await new Promise((r) => setTimeout(r, 300));
    expect(JSON.stringify(events)).not.toContain("STALE_REPLAY_CANARY");

    proxy.run({ prompt: "fresh turn", cwd: "/workspace" });
    await waitFor(() => lastAgent !== oldAgent && lastAgent?.runCalled, 3000, "fresh agent.run()");
    expect(lastAgent.lastParams?.prompt).toBe("fresh turn");

    lastAgent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "fresh output" }],
    });
    await waitFor(
      () => JSON.stringify(events).includes("fresh output"),
      3000,
      "fresh event delivered",
    );

    lastAgent.emit("done", 0);
    runner.dispose();
  });

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

    proxy.interrupt();
    await waitFor(() => lastAgent?.interrupted, 3000, "agent.interrupted");

    expect(lastAgent.interrupted).toBe(true);

    runner.dispose();
  });

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

    proxy.writeStdin("yes\n");
    await waitFor(() => lastAgent?.stdinData.length > 0, 3000, "stdin data");

    expect(lastAgent.stdinData).toEqual(["yes\n"]);

    runner.dispose();
  });

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

    proxy.kill();
    await waitFor(() => lastAgent?.killed, 3000, "agent.killed");

    expect(lastAgent.killed).toBe(true);

    runner.dispose();
  });

  it("a late kill from a retired proxy does not kill or unhook the newer resident spawn", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-late-kill-wrong-victim",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });
    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxyOld = runner.createAgent("claude");
    proxyOld.run({ prompt: "old spawn", cwd: "/workspace" });
    await waitFor(() => lastAgent?.runCalled, 3000, "old agent.run()");
    const oldAgent = lastAgent;
    oldAgent.emit("done", 0);
    await new Promise((r) => setTimeout(r, 200));

    const proxyNew = runner.createAgent("claude");
    const newEvents: string[] = [];
    proxyNew.on("event", (e: { type?: string }) => { if (e.type) newEvents.push(e.type); });
    proxyNew.run({ prompt: "new spawn", cwd: "/workspace" });
    await waitFor(
      () => lastAgent !== oldAgent && lastAgent?.lastParams?.prompt === "new spawn",
      3000,
      "new agent.run()",
    );
    const newAgent = lastAgent;

    proxyOld.kill();
    await new Promise((r) => setTimeout(r, 300));

    expect(newAgent.killed).toBe(false);
    expect(runner.getAgent()).toBe(proxyNew);
    newAgent.emit("event", { type: "agent_result", status: "success", sessionId: "s-new" });
    await waitFor(() => newEvents.includes("agent_result"), 3000, "new spawn's events still delivered");

    runner.dispose({ force: true });
  });

  it("supports sequential agent runs (new proxy after done)", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-proxy-sequential",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxy1 = runner.createAgent("claude");
    proxy1.run({ prompt: "First run", cwd: "/workspace" });
    await waitFor(() => lastAgent?.runCalled, 3000, "first agent.run()");

    const firstAgent = lastAgent;
    expect(firstAgent.lastParams?.prompt).toBe("First run");

    firstAgent.emit("event", { type: "agent_result", status: "success", sessionId: "s1" });
    firstAgent.emit("done", 0);

    await new Promise((r) => setTimeout(r, 200));

    const proxy2 = runner.createAgent("claude");
    proxy2.run({ prompt: "Second run", sessionId: "s1", cwd: "/workspace" });
    await waitFor(() => lastAgent?.runCalled && lastAgent !== firstAgent, 3000, "second agent.run()");

    expect(lastAgent.lastParams?.prompt).toBe("Second run");

    runner.dispose();
  });

  it("proxy.run() emits error when worker is unreachable", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-proxy-error",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl: "http://127.0.0.1:1",
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

  it("_startAgentViaProxy retries once on 409 'Agent already running'", async () => {
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

    // Free the slot within the 150ms retry window.
    setTimeout(() => occupier.emit("done", 0), 50);

    await runner._startAgentViaProxy("claude", { prompt: "retry-me", cwd: "/workspace" });

    await waitFor(
      () => lastAgent !== occupier && lastAgent.lastParams?.prompt === "retry-me",
      3000,
      "retry agent started",
    );
    expect(lastAgent.lastParams?.prompt).toBe("retry-me");

    runner.dispose();
  });

  it("_startAgentViaProxy kills the stale agent and restarts when the slot stays busy", async () => {
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

    await runner._startAgentViaProxy("claude", { prompt: "wont-fit", cwd: "/workspace" });

    expect(stale.killed).toBe(true);
    await waitFor(
      () => lastAgent !== stale && lastAgent.lastParams?.prompt === "wont-fit",
      3000,
      "restarted agent",
    );
    expect(lastAgent.lastParams?.prompt).toBe("wont-fit");

    runner.dispose();
  });

  it("_startAgentViaProxy serializes concurrent start sequences (no kill+restart race)", async () => {
    const preStartRes = await fetch(`${workerUrl}/agent/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "claude", params: { prompt: "stuck" } }),
    });
    expect(preStartRes.status).toBe(200);
    expect(lastAgent).toBeTruthy();

    const runner = new ContainerSessionRunner({
      sessionId: "test-409-serialize",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });
    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const N = 5;
    const results = await Promise.all(
      Array.from({ length: N }, async (_, i): Promise<{ ok: true } | { ok: false; err: unknown }> => {
        try {
          await runner._startAgentViaProxy("claude", { prompt: `caller-${i}`, cwd: "/workspace" });
          return { ok: true };
        } catch (err) {
          return { ok: false, err };
        }
      }),
    );
    for (const [i, r] of results.entries()) {
      const errMsg = r.ok ? "" : ((r.err as Error | undefined)?.message ?? "unknown");
      expect(r.ok, `caller ${i} failed: ${errMsg}`).toBe(true);
    }

    runner.dispose();
  });

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

    lastAgent.emit("auth_required");

    await authPromise;

    runner.dispose();
  });

  it("a stale agent_done from a reused (killed) spawn does NOT strand the new turn's events", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-stale-done-slot-reuse",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });
    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxy1 = runner.createAgent("claude");
    proxy1.run({ prompt: "resident turn", cwd: "/workspace" });
    await waitFor(() => lastAgent?.runCalled, 3000, "agent1.run()");
    const agent1 = lastAgent;
    expect(proxy1.runToken).toBeTruthy();

    const proxy2 = runner.createAgent("claude");
    expect(proxy2.runToken).not.toBe(proxy1.runToken);

    let proxy2Done = false;
    proxy2.on("done", () => {
      proxy2Done = true;
      if (runner.getAgent() === proxy2) runner.setAgent(null);
    });
    const proxy2Events: string[] = [];
    proxy2.on("event", (e: { type?: string }) => { if (e.type) proxy2Events.push(e.type); });

    proxy2.run({ prompt: "rebase resolution turn", cwd: "/workspace" });
    await waitFor(
      () => lastAgent !== agent1 && lastAgent?.lastParams?.prompt === "rebase resolution turn",
      3000,
      "agent2.run() after slot reuse",
    );
    const agent2 = lastAgent;
    expect(agent1.killed).toBe(true);

    agent1.emit("done", 143);

    await new Promise((r) => setTimeout(r, 200));
    expect(proxy2Done).toBe(false);
    expect(runner.getAgent()).toBe(proxy2);

    agent2.emit("event", { type: "agent_init", agentId: "claude", sessionId: "s-rebase", model: "claude-sonnet-4-6", tools: ["Read"] });
    agent2.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Resolved the conflict." }],
    });
    agent2.emit("event", { type: "agent_result", status: "success", sessionId: "s-rebase" });
    await waitFor(() => proxy2Events.includes("agent_result"), 3000, "resolution events delivered");
    expect(proxy2Events).toContain("agent_init");
    expect(proxy2Events).toContain("agent_assistant");
    expect(proxy2Events).toContain("agent_result");

    agent2.emit("done", 0);
    await waitFor(() => proxy2Done, 3000, "proxy2 own done");
    expect(runner.getAgent()).toBeNull();

    runner.dispose({ force: true });
  });

  it("re-adopts the live streaming proxy when a stale spawn's exit nulled the slot — events are NOT dropped", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-stream-readopt",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });
    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxyStream = runner.createAgent("claude");
    proxyStream.run({ prompt: "streaming work", cwd: "/workspace", useStreaming: true });
    await waitFor(() => lastAgent?.runCalled, 3000, "agent1.run()");
    const agent1 = lastAgent;
    runner.isStreamingActive = true;

    const streamEvents: string[] = [];
    proxyStream.on("event", (e: { type?: string }) => { if (e.type) streamEvents.push(e.type); });

    runner.setAgent(null);
    expect(runner.getAgent()).toBeNull();

    agent1.emit("event", { type: "agent_init", agentId: "claude", sessionId: "s-stream", model: "claude-sonnet-4-6", tools: ["Read"] });
    agent1.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "Working." }] });
    agent1.emit("event", { type: "agent_result", status: "success", sessionId: "s-stream" });
    await waitFor(() => streamEvents.includes("agent_result"), 3000, "streaming events re-adopted");
    expect(streamEvents).toContain("agent_init");
    expect(streamEvents).toContain("agent_assistant");
    expect(runner.getAgent()).toBe(proxyStream);

    runner.dispose({ force: true });
  });

  it("delivers the live streaming process's own exit after a stale spawn nulled the slot", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-stream-done-readopt",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });
    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxyStream = runner.createAgent("claude");
    proxyStream.run({ prompt: "streaming work", cwd: "/workspace", useStreaming: true });
    await waitFor(() => lastAgent?.runCalled, 3000, "agent1.run()");
    const agent1 = lastAgent;
    runner.isStreamingActive = true;

    let exitCode: number | null = null;
    proxyStream.on("done", (code: number) => { exitCode = code; });

    runner.setAgent(null);
    expect(runner.getAgent()).toBeNull();

    agent1.emit("done", 137);
    await waitFor(() => exitCode !== null, 3000, "streaming exit delivered");
    expect(exitCode).toBe(137);
    expect(runner.getAgent()).toBe(proxyStream);

    runner.dispose({ force: true });
  });

  it("delivers the live streaming process's error after a stale spawn nulled the slot", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-stream-error-readopt",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });
    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxyStream = runner.createAgent("claude");
    proxyStream.run({ prompt: "streaming work", cwd: "/workspace", useStreaming: true });
    await waitFor(() => lastAgent?.runCalled, 3000, "agent1.run()");
    const agent1 = lastAgent;
    runner.isStreamingActive = true;

    let seen: Error | null = null;
    proxyStream.on("error", (err: Error) => { seen = err; });

    runner.setAgent(null);
    agent1.emit("error", new Error("stream died"));

    await waitFor(() => seen !== null, 3000, "streaming error delivered");
    expect((seen as unknown as Error).message).toContain("stream died");
    expect(runner.getAgent()).toBe(proxyStream);

    runner.dispose({ force: true });
  });

  it("still drops events from a genuinely-orphaned stream when no streaming turn is live", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-orphan-drop",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });
    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxy = runner.createAgent("claude");
    proxy.run({ prompt: "one-shot work", cwd: "/workspace" });
    await waitFor(() => lastAgent?.runCalled, 3000, "agent.run()");
    const agent1 = lastAgent;

    const events: string[] = [];
    proxy.on("event", (e: { type?: string }) => { if (e.type) events.push(e.type); });
    let sawDone = false;
    proxy.on("done", () => { sawDone = true; });

    runner.isStreamingActive = false;
    runner.setAgent(null);

    agent1.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "stale" }] });
    agent1.emit("done", 0);
    await new Promise((r) => setTimeout(r, 300));
    expect(events).toHaveLength(0);
    expect(sawDone).toBe(false);
    expect(runner.getAgent()).toBeNull();

    runner.dispose({ force: true });
  });

  it("reconciles an idle runner that still believes a streaming process is resident", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-stale-resident-reconcile",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });
    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    runner.isStreamingActive = true;
    runner.setBackgroundTasks([{ id: "bg-1", description: "npm test" }]);
    expect(runner.running).toBe(false);
    expect(runner.backgroundWorkDescriptions).toEqual(["npm test"]);

    const emitted: { type: string }[] = [];
    runner.on("message", (m) => emitted.push(m as { type: string }));

    const stillRunning = await runner.verifyRunningState();

    expect(stillRunning).toBe(false);
    expect(runner.isStreamingActive).toBe(false);
    expect(runner.backgroundWorkDescriptions).toEqual([]);
    expect(emitted.filter((m) => m.type === "background_tasks")).toEqual([
      { type: "background_tasks", sessionId: "test-stale-resident-reconcile", count: 0, descriptions: [] },
    ]);

    runner.dispose({ force: true });
  });

  it("stands down when a turn starts while the worker probe is in flight", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-verify-race",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });
    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    runner.isStreamingActive = true;
    runner.setBackgroundTasks([{ id: "bg-1", description: "npm test" }]);
    let abandoned = false;
    runner.on("turn_abandoned", () => { abandoned = true; });

    const verifying = runner.verifyRunningState();
    runner.running = true;
    const fresh = runner.createAgent("claude");

    await verifying;

    expect(abandoned).toBe(false);
    expect(runner.running).toBe(true);
    expect(runner.getAgent()).toBe(fresh);
    expect(runner.isStreamingActive).toBe(true);

    runner.running = false;
    runner.dispose({ force: true });
  });

  it("a fire-and-forget kill of the outgoing proxy does NOT null the incoming proxy's slot", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-kill-races-new-spawn",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });
    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxyStream = runner.createAgent("claude");
    proxyStream.run({ prompt: "resident streaming work", cwd: "/workspace", useStreaming: true });
    await waitFor(() => lastAgent?.runCalled, 3000, "resident agent.run()");
    const residentAgent = lastAgent;
    runner.isStreamingActive = true;

    // Do not await the kill: the new proxy must occupy the slot before its response.
    const outgoing = runner.getAgent();
    expect(outgoing).toBe(proxyStream);
    outgoing?.kill();
    runner.setAgent(null);
    runner.isStreamingActive = false;

    const proxySystem = runner.createAgent("claude");
    const systemEvents: string[] = [];
    proxySystem.on("event", (e: { type?: string }) => { if (e.type) systemEvents.push(e.type); });

    proxySystem.run({ prompt: "rebase resolution turn", cwd: "/workspace" });
    await waitFor(
      () => lastAgent !== residentAgent && lastAgent?.lastParams?.prompt === "rebase resolution turn",
      3000,
      "system turn agent.run()",
    );
    const systemAgent = lastAgent;
    expect(residentAgent.killed).toBe(true);

    await new Promise((r) => setTimeout(r, 300));
    expect(runner.getAgent()).toBe(proxySystem);

    systemAgent.emit("event", { type: "agent_init", agentId: "claude", sessionId: "s-sys", model: "claude-sonnet-4-6", tools: ["Read"] });
    systemAgent.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "Resolved 6 conflicts." }] });
    systemAgent.emit("event", { type: "agent_result", status: "success", sessionId: "s-sys" });
    await waitFor(() => systemEvents.includes("agent_result"), 3000, "system turn events delivered");
    expect(systemEvents).toEqual(["agent_init", "agent_assistant", "agent_result"]);

    runner.dispose({ force: true });
  });

  it("a late agent_event from the retired spawn is not routed into the incoming turn", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-stale-agent-event",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });
    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxyOld = runner.createAgent("claude");
    proxyOld.run({ prompt: "resident streaming work", cwd: "/workspace", useStreaming: true });
    await waitFor(() => lastAgent?.runCalled, 3000, "resident agent.run()");
    const oldAgent = lastAgent;

    const proxyNew = runner.createAgent("claude");
    expect(proxyNew.runToken).not.toBe(proxyOld.runToken);
    const newEvents: string[] = [];
    proxyNew.on("event", (e: { type?: string }) => { if (e.type) newEvents.push(e.type); });

    proxyNew.run({ prompt: "incoming turn", cwd: "/workspace" });
    await waitFor(
      () => lastAgent !== oldAgent && lastAgent?.lastParams?.prompt === "incoming turn",
      3000,
      "incoming agent.run()",
    );
    const newAgent = lastAgent;

    oldAgent.emit("event", { type: "agent_result", status: "success", sessionId: "s-old" });
    await new Promise((r) => setTimeout(r, 300));
    expect(newEvents).toHaveLength(0);
    expect(runner.getAgent()).toBe(proxyNew);

    newAgent.emit("event", { type: "agent_init", agentId: "claude", sessionId: "s-new", model: "claude-sonnet-4-6", tools: ["Read"] });
    newAgent.emit("event", { type: "agent_result", status: "success", sessionId: "s-new" });
    await waitFor(() => newEvents.includes("agent_result"), 3000, "incoming events delivered");
    expect(newEvents).toEqual(["agent_init", "agent_result"]);

    runner.dispose({ force: true });
  });

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
        // The in-process worker shares process.env with this test.
        expect(process.env[key]).toBe("secret-value");

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
        workerUrl: "http://127.0.0.1:1",
      });

      await expect(
        runner.tryPushAgentSecrets({ mcp__test__KEY: "v" }),
      ).resolves.toBeUndefined();

      runner.dispose();
    });
  });

  describe("verifyRunningState() stuck-running recovery", () => {
    it("returns false and resets running=true when worker reports no agent", async () => {
      const runner = new ContainerSessionRunner({
        sessionId: "test-stuck-running",
        sessionDir: "/tmp/test",
        defaultAgentId: "claude",
        workerUrl,
      });

      runner.attachViewer();
      await new Promise((r) => setTimeout(r, 200));

      runner.running = true;
      expect(lastAgent).toBeNull();

      const messages: { type: string; running?: boolean; error?: string }[] = [];
      runner.on("message", (m: { type: string; running?: boolean; error?: string }) => messages.push(m));

      const idlePromise = new Promise<void>((resolve) => {
        runner.once("idle", () => resolve());
      });

      const actuallyRunning = await runner.verifyRunningState();

      expect(actuallyRunning).toBe(false);
      expect(runner.running).toBe(false);
      expect(runner.getAgent()).toBeNull();

      const recovery = messages.find((m) => m.type === "session_status" && m.running === false);
      expect(recovery).toBeDefined();
      expect(recovery?.error).toMatch(/out of sync/i);

      await idlePromise;

      runner.dispose();
    });

    it("releases a queued entry through the branded dispatch path after the reset", async () => {
      const runner = makeDispatchStubbedRunner("test-stuck-drains-queue", workerUrl);

      const outcomes: TurnOutcome[] = [];
      runner.enqueue({
        text: "Child PR #1939 merged: Retire the docs/246 one-time clone migration",
        execution: "dispatched",
        systemTurn: true,
        postTurn: "none",
        activity: "Waking on merge…",
        deliveryId: "delivery-queued",
        onTurnComplete: (outcome) => outcomes.push(outcome),
      });

      runner.running = true;
      expect(await runner.verifyRunningState()).toBe(false);

      expect(runner.queueLength).toBe(0);
      expect(runner.dispatched).toHaveLength(1);
      expect(runner.running).toBe(true);

      const opts = runner.dispatched[0];
      expect(opts.text).toMatch(/Child PR #1939 merged/);
      expect(opts.execution).toBe("dispatched");
      expect(opts.systemTurn).toBe(true);
      expect(opts.postTurn).toBe("none");
      expect(opts.activity).toBe("Waking on merge…");
      expect(opts.deliveryId).toBe("delivery-queued");
      expect(typeof opts.onTurnComplete).toBe("function");
      opts.onTurnComplete?.(TURN_COMPLETED);
      expect(outcomes).toEqual([TURN_COMPLETED]);

      runner.dispose({ force: true });
    });

    it("settles the abandoned turn as dropped and stops publishing its delivery", async () => {
      const runner = makeDispatchStubbedRunner("test-stuck-settles-turn", workerUrl);

      const handle = runner.dispatch(prepareDispatch({
        text: "wake up",
        agentInterface: undefined,
        execution: "dispatched",
        activity: undefined,
        images: undefined,
        files: undefined,
        uploads: undefined,
        permissionMode: undefined,
        postTurn: undefined,
        systemTurn: true,
        onTurnComplete: undefined,
        deliveryId: "delivery-running",
        dictated: undefined,
        resetMergedBranch: undefined,
        compactContext: undefined,
        silent: undefined,
      }));
      expect(runner.running).toBe(true);
      expect(runner.hasDelivery("delivery-running")).toBe(true);

      expect(await runner.verifyRunningState()).toBe(false);

      const settled = await Promise.race<TurnOutcome | null>([
        handle.settled,
        new Promise<null>((r) => setTimeout(() => r(null), 1000)),
      ]);

      expect(settled?.status).toBe("dropped");
      expect(runner.activeDeliveryId).toBeUndefined();
      expect(runner.hasDelivery("delivery-running")).toBe(false);

      runner.dispose({ force: true });
    });

    it("still signals idle when the queue is empty", async () => {
      const runner = makeDispatchStubbedRunner("test-stuck-empty-queue", workerUrl);

      runner.running = true;
      const idlePromise = new Promise<void>((resolve) => { runner.once("idle", () => resolve()); });

      expect(await runner.verifyRunningState()).toBe(false);
      await idlePromise;
      expect(runner.dispatched).toHaveLength(0);

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

      expect(runner.running).toBe(false);
      const actuallyRunning = await runner.verifyRunningState();
      expect(actuallyRunning).toBe(false);

      runner.dispose();
    });

    it("keeps running=true when worker is unreachable (defensive fallback)", async () => {
      const runner = new ContainerSessionRunner({
        sessionId: "test-unreachable",
        sessionDir: "/tmp/test",
        defaultAgentId: "claude",
        workerUrl: "http://127.0.0.1:1",
      });

      runner.running = true;

      const actuallyRunning = await runner.verifyRunningState();

      expect(actuallyRunning).toBe(true);
      expect(runner.running).toBe(true);

      runner.dispose({ force: true });
    });
  });
});

describe("Integration: spawn-child install gate (no viewer attached)", () => {
  let worker: SessionWorker;
  let lastAgent: FakeWorkerAgent;
  let workerUrl: string;
  let tmpWorkspace: string;
  let tmpStateDir: string;

  beforeEach(async () => {
    lastAgent = null as unknown as FakeWorkerAgent;
    tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-install-gate-"));
    tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-install-gate-state-"));

    worker = new SessionWorker({
      agentFactory: () => {
        lastAgent = new FakeWorkerAgent();
        return lastAgent;
      },
      port: 0,
      host: "127.0.0.1",
      workspaceDir: tmpWorkspace,
      stateDir: tmpStateDir,
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
      fs.rmSync(tmpStateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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
      // Attach the event listener before starting the worker agent.
      const proxy = runner.createAgent("claude");
      const proxyDone = new Promise<number>((resolve) => {
        proxy.on("done", (code: number) => resolve(code));
      });

      const installPromise = runner.runInstall(["true"]);
      const startPromise = runner._startAgentViaProxy("claude", {
        prompt: "spawn-child no-viewer",
        cwd: "/workspace",
      });

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

      await waitFor(() => lastAgent?.runCalled, 3000, "agent.run() on worker");
      expect(lastAgent.lastParams?.prompt).toBe("spawn-child no-viewer");

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
