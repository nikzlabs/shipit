import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionWorker } from "../../session/session-worker.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
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
  sentMessages: string[] = [];
  readonly isStreaming = false;

  run(params: AgentRunParams): void {
    this.runCalled = true;
    this.lastParams = params;
  }

  writeStdin(data: string): void {
    this.stdinData.push(data);
  }

  sendUserMessage(text: string): void {
    this.sentMessages.push(text);
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

// Keep the base fake without setPermissionMode to test unsupported agents.
class FakeSteeringWorkerAgent extends FakeWorkerAgent {
  permissionModeCalls: (PermissionMode | undefined)[] = [];

  setPermissionMode(mode?: PermissionMode): void {
    this.permissionModeCalls.push(mode);
  }
}

async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
}


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
      port: 0,
      host: "127.0.0.1",
    });

    const address = await worker.start();
    const match = /:(\d+)$/.exec(address);
    workerPort = match ? Number(match[1]) : 0;
    workerUrl = `http://127.0.0.1:${workerPort}`;
  });

  afterEach(async () => {
    await worker.stop();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("worker responds to health check", async () => {
    const res = await worker.getApp().inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

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

    const status = await worker.getApp().inject({ method: "GET", url: "/agent/status" });
    expect(status.json()).toMatchObject({ running: true });
    expect(status.json().latestSseSeq).toBeGreaterThanOrEqual(0);
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

    const status = await worker.getApp().inject({ method: "GET", url: "/agent/status" });
    expect(status.json()).toMatchObject({ running: false });
  });

  it("a kill naming a retired spawn's runToken does NOT kill the newer resident", async () => {
    await worker.getApp().inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "First" }, runToken: "tok-old" },
    });
    const agentA = lastAgent;
    agentA.emit("done", 0);
    await waitFor(async () => {
      const status = await worker.getApp().inject({ method: "GET", url: "/agent/status" });
      return status.json().running === false;
    }, 3000, "slot freed after A's exit");

    await worker.getApp().inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "Second" }, runToken: "tok-new" },
    });
    const agentB = lastAgent;
    expect(agentB).not.toBe(agentA);

    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/kill",
      payload: { runToken: "tok-old" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ killed: false, staleVictim: true });
    expect(agentB.killed).toBe(false);
    const status = await worker.getApp().inject({ method: "GET", url: "/agent/status" });
    expect(status.json()).toMatchObject({ running: true, runToken: "tok-new" });
  });

  it("a kill naming the resident spawn's own runToken still kills it", async () => {
    await worker.getApp().inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "Work" }, runToken: "tok-A" },
    });

    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/kill",
      payload: { runToken: "tok-A" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ killed: true });
    expect(lastAgent.killed).toBe(true);
    const status = await worker.getApp().inject({ method: "GET", url: "/agent/status" });
    expect(status.json()).toMatchObject({ running: false });
  });

  it("a kill naming a runToken no-ops when the resident spawn has none", async () => {
    await worker.getApp().inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "Work" } },
    });

    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/kill",
      payload: { runToken: "tok-A" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ killed: false, staleVictim: true });
    expect(lastAgent.killed).toBe(false);
  });

  it("returns 404 when interrupting with no agent", async () => {
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/interrupt",
    });
    expect(res.statusCode).toBe(404);
  });

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

  it("rejects /agent/message when no agent is running", async () => {
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/message",
      payload: { text: "steer me" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("No agent running");
  });

  it("rejects /agent/message with a non-string text", async () => {
    await worker.getApp().inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "Work" } },
    });

    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/message",
      payload: { text: 42 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("text is required");
    expect(lastAgent.sentMessages).toEqual([]);
  });

  it("rejects /agent/message with empty text", async () => {
    await worker.getApp().inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "Work" } },
    });

    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/message",
      payload: { text: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("text is required");
    expect(lastAgent.sentMessages).toEqual([]);
  });

  it("forwards /agent/message to agent.sendUserMessage on the happy path", async () => {
    await worker.getApp().inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "Work" } },
    });

    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/message",
      payload: { text: "change course" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(lastAgent.sentMessages).toEqual(["change course"]);
  });

  it("returns 404 on /agent/permission-mode when no agent is running", async () => {
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/permission-mode",
      payload: { mode: "plan" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("No agent running");
  });

  it("returns 400 on /agent/permission-mode when the agent lacks setPermissionMode", async () => {
    await worker.getApp().inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "Work" } },
    });

    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/permission-mode",
      payload: { mode: "plan" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("does not support");
  });

  it("streams agent events via SSE to proxy agent on ContainerSessionRunner", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-session",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    runner.attachViewer();

    // Allow the SSE connection to open.
    await new Promise((r) => setTimeout(r, 200));

    const proxy = await runner.startAgentOnWorker("claude", {
      prompt: "Write a test",
      cwd: "/workspace",
    });

    expect(lastAgent.runCalled).toBe(true);

    const agentEvents: { type: string }[] = [];
    proxy.on("event", (event: { type: string }) => {
      agentEvents.push(event);
    });

    const resultPromise = new Promise<void>((resolve) => {
      proxy.on("event", (event: { type: string }) => {
        if (event.type === "agent_result") resolve();
      });
    });

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

    await resultPromise;

    const eventTypes = agentEvents.map((e) => e.type);
    expect(eventTypes).toContain("agent_init");
    expect(eventTypes).toContain("agent_assistant");
    expect(eventTypes).toContain("agent_result");

    runner.dispose();
  });

  it("injects an AskUserQuestion tool_use into the event stream on POST /agent-ops/ask/submit", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-ask",
      sessionDir: "/tmp/test",
      defaultAgentId: "codex",
      workerUrl,
    });
    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxy = await runner.startAgentOnWorker("codex", {
      prompt: "Decide something",
      cwd: "/workspace",
    });

    interface AssistantEvent { type: string; content?: { name?: string; input?: { questions?: unknown[] } }[] }
    const askEvents: AssistantEvent[] = [];
    const got = new Promise<void>((resolve) => {
      proxy.on("event", (event: { type: string }) => {
        const e = event as AssistantEvent;
        askEvents.push(e);
        if (
          e.type === "agent_assistant" &&
          e.content?.some((b) => b.name === "AskUserQuestion")
        ) {
          resolve();
        }
      });
    });

    const res = await fetch(`${workerUrl}/agent-ops/ask/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        questions: [
          {
            question: "Which database?",
            header: "Database",
            options: [{ label: "Postgres" }, { label: "Redis" }],
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "asked" });

    await got;

    const ask = askEvents.find(
      (e) => e.type === "agent_assistant" && e.content?.some((b) => b.name === "AskUserQuestion"),
    );
    const block = ask?.content?.find((b) => b.name === "AskUserQuestion");
    expect(block?.input?.questions).toEqual([
      {
        question: "Which database?",
        header: "Database",
        multiSelect: false,
        options: [
          { label: "Postgres", description: "" },
          { label: "Redis", description: "" },
        ],
      },
    ]);

    runner.dispose();
  });

  it("round-trips a permission request: open returns a requestId, await holds, then resolves (docs/193, Thread B)", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-perm",
      sessionDir: "/tmp/test",
      defaultAgentId: "codex",
      workerUrl,
    });
    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxy = await runner.startAgentOnWorker("codex", { prompt: "edit .npmrc", cwd: "/workspace" });

    interface PermEvent { type: string; requestId?: string; path?: string; behavior?: string }
    let cardRequestId: string | undefined;
    const gotRequest = new Promise<void>((resolve) => {
      proxy.on("event", (event: { type: string }) => {
        const e = event as PermEvent;
        if (e.type === "agent_permission_request") {
          cardRequestId = e.requestId;
          resolve();
        }
      });
    });

    const openRes = await fetch(`${workerUrl}/agent-ops/permission/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolName: "Write", input: { file_path: ".npmrc" }, toolUseId: "tu-1" }),
    });
    expect(openRes.status).toBe(200);
    const opened = (await openRes.json()) as { requestId?: string };
    expect(opened.requestId).toBeTruthy();

    await gotRequest;
    expect(cardRequestId).toBe(opened.requestId);

    const awaitPromise = fetch(`${workerUrl}/agent-ops/permission/await`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: opened.requestId, timeoutMs: 5000 }),
    });

    // Allow the poll to register before resolving it.
    await new Promise((r) => setTimeout(r, 50));
    const resolveRes = await fetch(`${workerUrl}/agent/permission/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: opened.requestId, behavior: "allow", remember: true }),
    });
    expect(resolveRes.status).toBe(200);
    expect(await resolveRes.json()).toEqual({ resolved: true });

    const reply = await awaitPromise;
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ behavior: "allow" });

    runner.dispose();
  });

  it("a duplicated permission open re-attaches to one card (idempotent on toolUseId, Thread B)", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-perm-idem",
      sessionDir: "/tmp/test",
      defaultAgentId: "codex",
      workerUrl,
    });
    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxy = await runner.startAgentOnWorker("codex", { prompt: "edit .npmrc", cwd: "/workspace" });

    let cards = 0;
    proxy.on("event", (event: { type: string }) => {
      if (event.type === "agent_permission_request") cards += 1;
    });

    const open = async (): Promise<{ requestId?: string }> => {
      const r = await fetch(`${workerUrl}/agent-ops/permission/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolName: "Write", input: { file_path: ".npmrc" }, toolUseId: "same-tu" }),
      });
      return (await r.json()) as { requestId?: string };
    };

    const first = await open();
    const second = await open();

    expect(first.requestId).toBeTruthy();
    expect(second.requestId).toBe(first.requestId);
    await new Promise((r) => setTimeout(r, 50));
    expect(cards).toBe(1);

    runner.dispose();
  });

  it("resolving an unknown permission requestId reports not-found (stale card)", async () => {
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/permission/resolve",
      payload: { requestId: "perm_missing", behavior: "allow" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resolved: false });
  });

  it("rejects a malformed AskUserQuestion submit with 400 (so the bridge errors instead of hanging)", async () => {
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent-ops/ask/submit",
      payload: { questions: [{ question: "Q", header: "H", options: [] }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("non-empty array");
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

    const donePromise = new Promise<number>((resolve) => {
      proxy.on("done", (exitCode: number) => resolve(exitCode));
    });

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

  it("implements SessionRunnerInterface state management", () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-state",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

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

    expect(runner.queueLength).toBe(0);
    runner.enqueue({ text: "msg1", execution: "interactive" });
    expect(runner.queueLength).toBe(1);
    expect(runner.getQueueSnapshot()).toEqual([{ text: "msg1", position: 1 }]);

    const dequeued = runner.dequeue();
    expect(dequeued?.text).toBe("msg1");
    expect(runner.queueLength).toBe(0);

    expect(runner.getTurnEventBuffer()).toEqual([]);
    runner.emitMessage({ type: "error", message: "test" });
    expect(runner.getTurnEventBuffer().length).toBe(1);
    runner.clearTurnEventBuffer();
    expect(runner.getTurnEventBuffer()).toEqual([]);

    expect(runner.detectedPorts).toEqual([]);
    runner.detectedPorts = [3000, 8080];
    expect(runner.detectedPorts).toEqual([3000, 8080]);

    expect(runner.viewerCount).toBe(0);

    // This test left running=true, which prevents normal disposal.
    expect(runner.disposed).toBe(false);
    runner.dispose({ force: true });
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

    const before = await worker.getApp().inject({ method: "GET", url: "/agent/status" });
    expect(before.json().running).toBe(true);

    lastAgent.emit("event", {
      type: "agent_result",
      status: "success",
      sessionId: "s1",
    });
    lastAgent.emit("done", 0);

    await waitFor(() => {
      void worker.getApp().inject({ method: "GET", url: "/agent/status" });
      return true;
    }, 1000, "agent cleared");

    const after = await worker.getApp().inject({ method: "GET", url: "/agent/status" });
    expect(after.json().running).toBe(false);

    runner.dispose();
  });

  it("PUT /secrets injects values into process.env and returns count", async () => {
    const res = await worker.getApp().inject({
      method: "PUT",
      url: "/secrets",
      payload: { secrets: { TEST_DB_URL: "postgres://x", TEST_REDIS: "redis://y" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ applied: 2 });
    expect(process.env.TEST_DB_URL).toBe("postgres://x");
    expect(process.env.TEST_REDIS).toBe("redis://y");

    delete process.env.TEST_DB_URL;
    delete process.env.TEST_REDIS;
  });

  it("PUT /secrets unsets keys that disappear from a subsequent push", async () => {
    await worker.getApp().inject({
      method: "PUT",
      url: "/secrets",
      payload: { secrets: { TEST_OLD_KEY: "v1", TEST_KEEP: "v2" } },
    });
    expect(process.env.TEST_OLD_KEY).toBe("v1");

    const res = await worker.getApp().inject({
      method: "PUT",
      url: "/secrets",
      payload: { secrets: { TEST_KEEP: "v2-new" } },
    });
    expect(res.statusCode).toBe(200);
    expect(process.env.TEST_OLD_KEY).toBeUndefined();
    expect(process.env.TEST_KEEP).toBe("v2-new");

    await worker.getApp().inject({ method: "PUT", url: "/secrets", payload: { secrets: {} } });
    expect(process.env.TEST_KEEP).toBeUndefined();
  });

  it("PUT /secrets rejects invalid env var names", async () => {
    const res = await worker.getApp().inject({
      method: "PUT",
      url: "/secrets",
      payload: { secrets: { "1bad": "v" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("not a valid env var");
  });

  it("PUT /secrets rejects non-string values", async () => {
    const res = await worker.getApp().inject({
      method: "PUT",
      url: "/secrets",
      payload: { secrets: { GOOD_NAME: 42 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("must be a string");
  });

  it("PUT /secrets rejects non-object body", async () => {
    const res = await worker.getApp().inject({
      method: "PUT",
      url: "/secrets",
      payload: { secrets: ["not", "an", "object"] },
    });
    expect(res.statusCode).toBe(400);
  });

});

describe("Integration: Session Worker permission-mode mapping", () => {
  let worker: SessionWorker;
  let lastAgent: FakeSteeringWorkerAgent;

  async function startAgent(): Promise<void> {
    await worker.getApp().inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "Work" } },
    });
  }

  beforeEach(async () => {
    lastAgent = null as unknown as FakeSteeringWorkerAgent;
    worker = new SessionWorker({
      agentFactory: () => {
        lastAgent = new FakeSteeringWorkerAgent();
        return lastAgent;
      },
      port: 0,
      host: "127.0.0.1",
    });
    await worker.start();
  });

  afterEach(async () => {
    await worker.stop();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("returns 400 for a mode outside the allowed set", async () => {
    await startAgent();
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/permission-mode",
      payload: { mode: "bogus" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Invalid mode");
    expect(lastAgent.permissionModeCalls).toEqual([]);
  });

  it("returns 400 for a non-string, non-null mode", async () => {
    await startAgent();
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/permission-mode",
      payload: { mode: 7 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Invalid mode");
    expect(lastAgent.permissionModeCalls).toEqual([]);
  });

  it.each(["plan", "guarded", "auto"] as const)(
    "maps the %s mode through to setPermissionMode",
    async (mode) => {
      await startAgent();
      const res = await worker.getApp().inject({
        method: "POST",
        url: "/agent/permission-mode",
        payload: { mode },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(lastAgent.permissionModeCalls).toEqual([mode]);
    },
  );

  it("maps a null mode to setPermissionMode(undefined) — the ShipIt 'auto' wire encoding", async () => {
    await startAgent();
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/permission-mode",
      payload: { mode: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(lastAgent.permissionModeCalls).toEqual([undefined]);
  });
});

// Supply a writable stateDir: these in-process workers have no /session-state mount.
describe("Integration: Session Worker install endpoint", () => {
  let installWorker: SessionWorker;
  let installWorkerPort: number;
  let installWorkerUrl: string;
  let installWorkspaceDir: string;
  let installStateDir: string;

  beforeEach(async () => {
    installWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-install-test-"));
    installStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-install-state-"));
    installWorker = new SessionWorker({
      agentFactory: () => new FakeWorkerAgent(),
      port: 0,
      host: "127.0.0.1",
      workspaceDir: installWorkspaceDir,
      stateDir: installStateDir,
    });

    const address = await installWorker.start();
    const match = /:(\d+)$/.exec(address);
    installWorkerPort = match ? Number(match[1]) : 0;
    installWorkerUrl = `http://127.0.0.1:${installWorkerPort}`;
  });

  afterEach(async () => {
    await installWorker.stop();
    fs.rmSync(installWorkspaceDir, { recursive: true, force: true });
    fs.rmSync(installStateDir, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 50));
  });

  it("GET /install/status returns idle/no-result before any install runs", async () => {
    const res = await installWorker.getApp().inject({ method: "GET", url: "/install/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ running: false, lastResult: null });
  });

  it("POST /install records a successful result that /install/status surfaces", async () => {
    const res = await installWorker.getApp().inject({
      method: "POST",
      url: "/install",
      payload: { commands: ["true"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ started: true });

    await waitFor(async () => {
      const s = await installWorker.getApp().inject({ method: "GET", url: "/install/status" });
      const body = s.json() as { running: boolean; lastResult: { ok: boolean } | null };
      return !body.running && body.lastResult?.ok === true;
    }, 3_000, "install completed");
  });

  it("POST /install records a failure result with the failing command", async () => {
    const res = await installWorker.getApp().inject({
      method: "POST",
      url: "/install",
      payload: { commands: ["sh -c 'exit 7'"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ started: true });

    await waitFor(async () => {
      const s = await installWorker.getApp().inject({ method: "GET", url: "/install/status" });
      const body = s.json() as { running: boolean; lastResult: { ok: boolean; command?: string } | null };
      return !body.running && body.lastResult?.ok === false;
    }, 3_000, "install failed");

    const final = await installWorker.getApp().inject({ method: "GET", url: "/install/status" });
    const body = final.json() as { lastResult: { command?: string } };
    expect(body.lastResult.command).toBe("sh -c 'exit 7'");
  });

  it("joins an in-flight install instead of failing the second caller", async () => {
    // Keep the first install running until the second POST.
    await installWorker.getApp().inject({
      method: "POST",
      url: "/install",
      payload: { commands: ["sleep 1"] },
    });
    const second = await installWorker.getApp().inject({
      method: "POST",
      url: "/install",
      payload: { commands: ["sleep 1"] },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ started: true, joined: true });
  });

  it("ContainerSessionRunner.runInstall is idempotent under concurrent callers", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "test-install-idempotent",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl: installWorkerUrl,
    });
    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const statusEvents: string[] = [];
    runner.on("message", (msg) => {
      if (msg.type === "install_status") statusEvents.push(msg.status);
    });

    const a = runner.runInstall(["true"]);
    const b = runner.runInstall(["true"]);

    await Promise.all([a, b]);

    expect(statusEvents.filter((s) => s === "running").length).toBe(1);
    const status = await installWorker.getApp().inject({ method: "GET", url: "/install/status" });
    const body = status.json() as { running: boolean; lastResult: { ok: boolean } | null };
    expect(body.running).toBe(false);
    expect(body.lastResult?.ok).toBe(true);

    runner.dispose();
  });

  it("plain install: a successful command writes the marker so a re-run skips", async () => {
    const res = await installWorker.getApp().inject({
      method: "POST",
      url: "/install",
      payload: { commands: ["true"] },
    });
    expect(res.statusCode).toBe(200);

    await waitFor(async () => {
      const s = await installWorker.getApp().inject({ method: "GET", url: "/install/status" });
      const body = s.json() as { running: boolean; lastResult: { ok: boolean } | null };
      return !body.running && body.lastResult?.ok === true;
    }, 5_000, "plain install completed");

    expect(fs.existsSync(path.join(installStateDir, ".install-done"))).toBe(true);

    const second = await installWorker.getApp().inject({
      method: "POST",
      url: "/install",
      payload: { commands: ["true"] },
    });
    expect(second.json()).toEqual({ skipped: true, reason: "marker" });
  });

  it("stamped marker: a changed install command re-runs instead of skipping", async () => {
    await installWorker.getApp().inject({
      method: "POST",
      url: "/install",
      payload: { commands: ["true"] },
    });
    await waitFor(async () => {
      const s = await installWorker.getApp().inject({ method: "GET", url: "/install/status" });
      const body = s.json() as { running: boolean; lastResult: { ok: boolean } | null };
      return !body.running && body.lastResult?.ok === true;
    }, 5_000, "first install completed");

    const second = await installWorker.getApp().inject({
      method: "POST",
      url: "/install",
      payload: { commands: ["sh -c 'true'"] },
    });
    expect(second.json()).toEqual({ started: true });

    await waitFor(async () => {
      const s = await installWorker.getApp().inject({ method: "GET", url: "/install/status" });
      const body = s.json() as { running: boolean; lastResult: { ok: boolean } | null };
      return !body.running && body.lastResult?.ok === true;
    }, 5_000, "second install completed");
  });

  const awaitInstallOk = () =>
    waitFor(async () => {
      const s = await installWorker.getApp().inject({ method: "GET", url: "/install/status" });
      const body = s.json() as { running: boolean; lastResult: { ok: boolean } | null };
      return !body.running && body.lastResult?.ok === true;
    }, 5_000, "install completed");

  it("distrusts a matching marker when a present-but-empty (non-overlay) dep dir contradicts it", async () => {
    const reinstall = "mkdir -p node_modules && : > node_modules/dep.js";

    await installWorker.getApp().inject({ method: "POST", url: "/install", payload: { commands: ["true"] } });
    await awaitInstallOk();
    expect(fs.existsSync(path.join(installStateDir, ".install-done"))).toBe(true);

    fs.mkdirSync(path.join(installWorkspaceDir, "node_modules"));

    const second = await installWorker.getApp().inject({
      method: "POST",
      url: "/install",
      payload: { commands: [reinstall] },
    });
    expect(second.json()).toEqual({ started: true });
    await awaitInstallOk();
    expect(fs.existsSync(path.join(installWorkspaceDir, "node_modules", "dep.js"))).toBe(true);
  });

  it("fails the reinstall when it leaves the contradicting dep dir empty", async () => {
    await installWorker.getApp().inject({ method: "POST", url: "/install", payload: { commands: ["true"] } });
    await awaitInstallOk();
    fs.mkdirSync(path.join(installWorkspaceDir, "node_modules"));

    const second = await installWorker.getApp().inject({
      method: "POST",
      url: "/install",
      payload: { commands: ["true || true"] },
    });
    expect(second.json()).toEqual({ started: true });

    await waitFor(async () => {
      const s = await installWorker.getApp().inject({ method: "GET", url: "/install/status" });
      const body = s.json() as { running: boolean; lastResult: { ok: boolean } | null };
      return !body.running && body.lastResult?.ok === false;
    }, 5_000, "install reported failure");

    const status = await installWorker.getApp().inject({ method: "GET", url: "/install/status" });
    const { lastResult } = status.json() as { lastResult: { ok: boolean; message?: string } };
    expect(lastResult.message).toContain("node_modules");
    expect(fs.existsSync(path.join(installStateDir, ".install-done"))).toBe(false);
  });

  it("preserves the marker-skip when the dep dir is populated", async () => {
    await installWorker.getApp().inject({ method: "POST", url: "/install", payload: { commands: ["true"] } });
    await awaitInstallOk();

    fs.mkdirSync(path.join(installWorkspaceDir, "node_modules"));
    fs.writeFileSync(path.join(installWorkspaceDir, "node_modules", "dep.js"), "//");

    const second = await installWorker.getApp().inject({
      method: "POST",
      url: "/install",
      payload: { commands: ["true"] },
    });
    expect(second.json()).toEqual({ skipped: true, reason: "marker" });
  });

  it("preserves the marker-skip when the dep dir is absent (legit dep-less repo)", async () => {
    await installWorker.getApp().inject({ method: "POST", url: "/install", payload: { commands: ["true"] } });
    await awaitInstallOk();

    const second = await installWorker.getApp().inject({
      method: "POST",
      url: "/install",
      payload: { commands: ["true"] },
    });
    expect(second.json()).toEqual({ skipped: true, reason: "marker" });
  });

  it("preserves the marker-skip over an empty dep dir when the repo opts out with dep-dirs: []", async () => {
    fs.writeFileSync(path.join(installWorkspaceDir, "shipit.yaml"), "agent:\n  dep-dirs: []\n");
    await installWorker.getApp().inject({ method: "POST", url: "/install", payload: { commands: ["true"] } });
    await awaitInstallOk();

    fs.mkdirSync(path.join(installWorkspaceDir, "node_modules"));

    const second = await installWorker.getApp().inject({
      method: "POST",
      url: "/install",
      payload: { commands: ["true"] },
    });
    expect(second.json()).toEqual({ skipped: true, reason: "marker" });
  });

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: installWorkspaceDir, stdio: "ignore" });

  const initGitRepo = () => {
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
  };

  const commitAll = (message: string): string => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: installWorkspaceDir }).toString().trim();
  };

  it("content key: skips a DIFFERENT commit when the dep input files are identical", async () => {
    initGitRepo();
    // Explicit inputs enable content hashing for the otherwise unsupported command.
    fs.writeFileSync(path.join(installWorkspaceDir, "shipit.yaml"), "agent:\n  install-inputs:\n    - deps.lock\n");
    fs.writeFileSync(path.join(installWorkspaceDir, "deps.lock"), "left-pad@1.0.0\n");
    const first = commitAll("init");

    await installWorker.getApp().inject({ method: "POST", url: "/install", payload: { commands: ["true"] } });
    await awaitInstallOk();

    fs.writeFileSync(path.join(installWorkspaceDir, "README.md"), "docs\n");
    const second = commitAll("docs only");
    expect(second).not.toBe(first);

    const res = await installWorker.getApp().inject({
      method: "POST",
      url: "/install",
      payload: { commands: ["true"] },
    });
    expect(res.json()).toEqual({ skipped: true, reason: "marker" });
  });

  it("content key: a dep-file edit busts the skip (reinstall on a new commit)", async () => {
    initGitRepo();
    fs.writeFileSync(path.join(installWorkspaceDir, "shipit.yaml"), "agent:\n  install-inputs:\n    - deps.lock\n");
    fs.writeFileSync(path.join(installWorkspaceDir, "deps.lock"), "left-pad@1.0.0\n");
    commitAll("init");

    await installWorker.getApp().inject({ method: "POST", url: "/install", payload: { commands: ["true"] } });
    await awaitInstallOk();

    fs.writeFileSync(path.join(installWorkspaceDir, "deps.lock"), "left-pad@2.0.0\n");
    commitAll("bump dep");

    const res = await installWorker.getApp().inject({
      method: "POST",
      url: "/install",
      payload: { commands: ["true"] },
    });
    expect(res.json()).toEqual({ started: true });
    await awaitInstallOk();
  });

  it("content key: a non-allowlisted install command stays commit-only (reinstalls)", async () => {
    initGitRepo();
    fs.writeFileSync(path.join(installWorkspaceDir, "deps.lock"), "left-pad@1.0.0\n");
    commitAll("init");

    await installWorker.getApp().inject({ method: "POST", url: "/install", payload: { commands: ["true"] } });
    await awaitInstallOk();

    fs.writeFileSync(path.join(installWorkspaceDir, "README.md"), "docs\n");
    commitAll("docs only");

    const res = await installWorker.getApp().inject({
      method: "POST",
      url: "/install",
      payload: { commands: ["true"] },
    });
    expect(res.json()).toEqual({ started: true });
    await awaitInstallOk();
  });

  it("SSE replays last install_done to a late-connecting client", async () => {
    await installWorker.getApp().inject({
      method: "POST",
      url: "/install",
      payload: { commands: ["true"] },
    });
    await waitFor(async () => {
      const s = await installWorker.getApp().inject({ method: "GET", url: "/install/status" });
      return !(s.json() as { running: boolean }).running;
    }, 3_000, "install completed");

    const runner = new ContainerSessionRunner({
      sessionId: "test-install-replay",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl: installWorkerUrl,
    });

    const completes: string[] = [];
    runner.on("message", (msg) => {
      if (msg.type === "install_status") completes.push(msg.status);
    });

    runner.attachViewer();
    await waitFor(() => completes.includes("complete"), 3_000, "replayed install_done");
    expect(completes).toContain("complete");

    runner.dispose();
  });
});
