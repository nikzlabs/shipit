/**
 * Integration tests for Phase 3: Terminal, Preview, and File Watcher in Containers.
 *
 * Tests cover:
 * 1. Worker terminal endpoints (start, input, resize) + SSE events
 * 2. Worker preview endpoints + SSE events
 * 3. Worker file watcher endpoints + SSE events
 * 4. Worker file tree endpoint
 * 5. ContainerSessionRunner terminal proxy (SSE → emitMessage)
 * 6. ContainerSessionRunner preview proxy (SSE → emitMessage, buildPreviewStatus)
 * 7. ContainerSessionRunner file watcher proxy (SSE → emitMessage)
 * 8. Preview reverse proxy routing
 *
 * Uses in-process Fastify with stubs — no Docker or real processes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import http from "node:http";
import Fastify from "fastify";
import { SessionWorker } from "../../session/session-worker.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import { registerPreviewProxy } from "../preview-proxy.js";
import type { AgentProcess, AgentProcessEvents, AgentId, AgentRunParams } from "../../shared/types.js";
import type { WsServerMessage } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

class FakeWorkerAgent extends EventEmitter<AgentProcessEvents> implements AgentProcess {
  readonly agentId: AgentId = "claude";
  readonly capabilities = {
    supportsResume: true,
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: true,
    supportedPermissionModes: [] as import("../../shared/types.js").PermissionMode[],
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
  writeStdin(data: string): void { this.stdinData.push(data); }
  interrupt(): void { this.interrupted = true; }
  kill(): void { this.killed = true; }
}

/** Stub TerminalProcess that doesn't spawn a real PTY. */
class StubTerminal extends EventEmitter {
  startCalled = false;
  lastCwd = "";
  lastCols = 0;
  lastRows = 0;
  writtenData: string[] = [];
  resizedTo: { cols: number; rows: number }[] = [];
  killed = false;

  start(cwd: string, cols: number, rows: number): void {
    this.startCalled = true;
    this.lastCwd = cwd;
    this.lastCols = cols;
    this.lastRows = rows;
  }

  write(data: string): void { this.writtenData.push(data); }
  resize(cols: number, rows: number): void { this.resizedTo.push({ cols, rows }); }
  kill(): void { this.killed = true; }
  get running(): boolean { return this.startCalled; }
}

/** Stub PreviewManager that doesn't spawn real processes. */
class StubPreview extends EventEmitter {
  private _running = false;
  private _ports: number[] = [];
  startCalled = false;
  stopCalled = false;

  get running() { return this._running; }
  get ports() { return this._ports; }

  async start(_cwd: string) {
    this.startCalled = true;
    this._running = true;
  }

  stop() {
    this.stopCalled = true;
    this._running = false;
  }

  removeAllListeners() { super.removeAllListeners(); return this; }

  /** Test helper: simulate becoming ready with ports. */
  simulateReady(ports: number[]) {
    this._ports = ports;
    this.emit("ready", ports);
  }

  /** Test helper: simulate stopped event. */
  simulateStopped(code: number | null) {
    this._running = false;
    this.emit("stopped", code);
  }

  /** Test helper: simulate log event. */
  simulateLog(source: string, text: string) {
    this.emit("log", { source, text });
  }
}

/** Stub FileWatcher that doesn't watch the filesystem. */
class StubWatcher extends EventEmitter {
  startCalled = false;
  stopCalled = false;
  lastPath = "";

  start(path: string): void {
    this.startCalled = true;
    this.lastPath = path;
  }

  stop(): void { this.stopCalled = true; }
  removeAllListeners() { super.removeAllListeners(); return this; }

  /** Test helper: simulate file changes. */
  simulateChanges(paths: string[]) {
    this.emit("changes", paths);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect SSE events from a raw HTTP connection to the worker. */
function collectSSE(
  workerUrl: string,
  onEvent: (type: string, data: unknown) => void,
): { close: () => void } {
  const url = new URL("/events", workerUrl);
  const req = http.request(
    { hostname: url.hostname, port: url.port, path: url.pathname, method: "GET", headers: { Accept: "text/event-stream" } },
    (res) => {
      let buffer = "";
      let currentEvent = "";
      let currentData = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("event: ")) currentEvent = line.slice(7).trim();
          else if (line.startsWith("data: ")) currentData = line.slice(6);
          else if (line === "") {
            if (currentEvent && currentData) {
              try { onEvent(currentEvent, JSON.parse(currentData)); } catch { /* ignore */ }
            }
            currentEvent = "";
            currentData = "";
          }
        }
      });
    },
  );
  req.end();
  return { close: () => req.destroy() };
}

/** Wait for a condition to become true. */
async function waitFor(fn: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Worker Terminal Tests
// ---------------------------------------------------------------------------

describe("Phase 3: Worker Terminal Endpoints", () => {
  let worker: SessionWorker;
  let lastTerminal: StubTerminal;

  beforeEach(async () => {
    lastTerminal = null as unknown as StubTerminal;

    worker = new SessionWorker({
      agentFactory: () => new FakeWorkerAgent(),
      port: 0,
      host: "127.0.0.1",
      createTerminal: () => {
        lastTerminal = new StubTerminal();
        return lastTerminal as unknown as import("../../session/terminal.js").TerminalProcess;
      },
    });

    await worker.start();
  });

  afterEach(async () => {
    await worker.stop();
  });

  it("starts a terminal with default cols/rows", async () => {
    const res = await worker.getApp().inject({ method: "POST", url: "/terminal/start", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ started: true });
    expect(lastTerminal.startCalled).toBe(true);
    expect(lastTerminal.lastCols).toBe(80);
    expect(lastTerminal.lastRows).toBe(24);
  });

  it("starts a terminal with custom cols/rows", async () => {
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/terminal/start",
      payload: { cols: 120, rows: 40 },
    });
    expect(res.statusCode).toBe(200);
    expect(lastTerminal.lastCols).toBe(120);
    expect(lastTerminal.lastRows).toBe(40);
  });

  it("returns existing: true if terminal already running", async () => {
    await worker.getApp().inject({ method: "POST", url: "/terminal/start", payload: {} });
    const res = await worker.getApp().inject({ method: "POST", url: "/terminal/start", payload: {} });
    expect(res.json()).toMatchObject({ started: true, existing: true });
  });

  it("writes data to terminal", async () => {
    await worker.getApp().inject({ method: "POST", url: "/terminal/start", payload: {} });
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/terminal/input",
      payload: { data: "ls -la\r" },
    });
    expect(res.statusCode).toBe(200);
    expect(lastTerminal.writtenData).toEqual(["ls -la\r"]);
  });

  it("returns 404 for terminal input with no terminal", async () => {
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/terminal/input",
      payload: { data: "test" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("resizes the terminal", async () => {
    await worker.getApp().inject({ method: "POST", url: "/terminal/start", payload: {} });
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/terminal/resize",
      payload: { cols: 100, rows: 50 },
    });
    expect(res.statusCode).toBe(200);
    expect(lastTerminal.resizedTo).toEqual([{ cols: 100, rows: 50 }]);
  });

  it("returns 404 for terminal resize with no terminal", async () => {
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/terminal/resize",
      payload: { cols: 80, rows: 24 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("broadcasts terminal_data via SSE", async () => {
    const address = worker.getApp().server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const workerUrl = `http://127.0.0.1:${port}`;

    const events: Array<{ type: string; data: unknown }> = [];
    const sse = collectSSE(workerUrl, (type, data) => events.push({ type, data }));

    // Give SSE time to connect
    await new Promise((r) => setTimeout(r, 100));

    // Start terminal and simulate output
    await worker.getApp().inject({ method: "POST", url: "/terminal/start", payload: {} });
    lastTerminal.emit("data", "hello world");

    await waitFor(() => events.some((e) => e.type === "terminal_data"), 2000, "terminal_data SSE");
    const termEvent = events.find((e) => e.type === "terminal_data");
    expect(termEvent?.data).toEqual({ data: "hello world" });

    sse.close();
  });

  it("broadcasts terminal_exit via SSE", async () => {
    const address = worker.getApp().server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const workerUrl = `http://127.0.0.1:${port}`;

    const events: Array<{ type: string; data: unknown }> = [];
    const sse = collectSSE(workerUrl, (type, data) => events.push({ type, data }));
    await new Promise((r) => setTimeout(r, 100));

    await worker.getApp().inject({ method: "POST", url: "/terminal/start", payload: {} });
    lastTerminal.emit("exit", 0);

    await waitFor(() => events.some((e) => e.type === "terminal_exit"), 2000, "terminal_exit SSE");
    const exitEvent = events.find((e) => e.type === "terminal_exit");
    expect(exitEvent?.data).toEqual({ exitCode: 0 });

    sse.close();
  });
});

// ---------------------------------------------------------------------------
// Worker Preview Tests
// ---------------------------------------------------------------------------

describe("Phase 3: Worker Preview Endpoints", () => {
  let worker: SessionWorker;
  let lastPreview: StubPreview;

  beforeEach(async () => {
    lastPreview = null as unknown as StubPreview;

    worker = new SessionWorker({
      agentFactory: () => new FakeWorkerAgent(),
      port: 0,
      host: "127.0.0.1",
      createPreviewManager: () => {
        lastPreview = new StubPreview();
        return lastPreview as unknown as import("../../session/preview-manager.js").PreviewManager;
      },
    });

    await worker.start();
  });

  afterEach(async () => {
    await worker.stop();
  });

  it("starts preview server", async () => {
    const res = await worker.getApp().inject({ method: "POST", url: "/preview/start" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ started: true });
    expect(lastPreview.startCalled).toBe(true);
  });

  it("rejects starting preview if already running", async () => {
    await worker.getApp().inject({ method: "POST", url: "/preview/start" });
    const res = await worker.getApp().inject({ method: "POST", url: "/preview/start" });
    expect(res.statusCode).toBe(409);
  });

  it("stops preview server", async () => {
    await worker.getApp().inject({ method: "POST", url: "/preview/start" });
    const res = await worker.getApp().inject({ method: "POST", url: "/preview/stop" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stopped: true });
  });

  it("returns preview status", async () => {
    const res = await worker.getApp().inject({ method: "GET", url: "/preview/status" });
    expect(res.json()).toEqual({ running: false, ports: [] });
  });

  it("broadcasts preview_ready via SSE", async () => {
    const address = worker.getApp().server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const workerUrl = `http://127.0.0.1:${port}`;

    const events: Array<{ type: string; data: unknown }> = [];
    const sse = collectSSE(workerUrl, (type, data) => events.push({ type, data }));
    await new Promise((r) => setTimeout(r, 100));

    await worker.getApp().inject({ method: "POST", url: "/preview/start" });
    lastPreview.simulateReady([3000]);

    await waitFor(() => events.some((e) => e.type === "preview_ready"), 2000, "preview_ready SSE");
    const readyEvent = events.find((e) => e.type === "preview_ready");
    expect(readyEvent?.data).toEqual({ ports: [3000] });

    sse.close();
  });

  it("broadcasts preview_stopped via SSE", async () => {
    const address = worker.getApp().server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const workerUrl = `http://127.0.0.1:${port}`;

    const events: Array<{ type: string; data: unknown }> = [];
    const sse = collectSSE(workerUrl, (type, data) => events.push({ type, data }));
    await new Promise((r) => setTimeout(r, 100));

    await worker.getApp().inject({ method: "POST", url: "/preview/start" });
    lastPreview.simulateStopped(0);

    await waitFor(() => events.some((e) => e.type === "preview_stopped"), 2000, "preview_stopped SSE");
    const stoppedEvent = events.find((e) => e.type === "preview_stopped");
    expect(stoppedEvent?.data).toEqual({ code: 0 });

    sse.close();
  });

  it("broadcasts preview_log via SSE", async () => {
    const address = worker.getApp().server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const workerUrl = `http://127.0.0.1:${port}`;

    const events: Array<{ type: string; data: unknown }> = [];
    const sse = collectSSE(workerUrl, (type, data) => events.push({ type, data }));
    await new Promise((r) => setTimeout(r, 100));

    await worker.getApp().inject({ method: "POST", url: "/preview/start" });
    lastPreview.simulateLog("stdout", "Server running on port 3000");

    await waitFor(() => events.some((e) => e.type === "preview_log"), 2000, "preview_log SSE");
    const logEvent = events.find((e) => e.type === "preview_log");
    expect(logEvent?.data).toEqual({ source: "stdout", text: "Server running on port 3000" });

    sse.close();
  });
});

// ---------------------------------------------------------------------------
// Worker File Watcher Tests
// ---------------------------------------------------------------------------

describe("Phase 3: Worker File Watcher Endpoints", () => {
  let worker: SessionWorker;
  let lastWatcher: StubWatcher;

  beforeEach(async () => {
    lastWatcher = null as unknown as StubWatcher;

    worker = new SessionWorker({
      agentFactory: () => new FakeWorkerAgent(),
      port: 0,
      host: "127.0.0.1",
      createFileWatcher: () => {
        lastWatcher = new StubWatcher();
        return lastWatcher as unknown as import("../../session/file-watcher.js").FileWatcher;
      },
    });

    await worker.start();
  });

  afterEach(async () => {
    await worker.stop();
  });

  it("starts file watcher", async () => {
    const res = await worker.getApp().inject({ method: "POST", url: "/files/watch" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ watching: true });
    expect(lastWatcher.startCalled).toBe(true);
  });

  it("returns existing: true if watcher already running", async () => {
    await worker.getApp().inject({ method: "POST", url: "/files/watch" });
    const res = await worker.getApp().inject({ method: "POST", url: "/files/watch" });
    expect(res.json()).toMatchObject({ watching: true, existing: true });
  });

  it("stops file watcher", async () => {
    await worker.getApp().inject({ method: "POST", url: "/files/watch" });
    const res = await worker.getApp().inject({ method: "POST", url: "/files/unwatch" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stopped: true });
  });

  it("broadcasts file_changes via SSE", async () => {
    const address = worker.getApp().server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const workerUrl = `http://127.0.0.1:${port}`;

    const events: Array<{ type: string; data: unknown }> = [];
    const sse = collectSSE(workerUrl, (type, data) => events.push({ type, data }));
    await new Promise((r) => setTimeout(r, 100));

    await worker.getApp().inject({ method: "POST", url: "/files/watch" });
    lastWatcher.simulateChanges(["src/App.tsx", "src/index.ts"]);

    await waitFor(() => events.some((e) => e.type === "file_changes"), 2000, "file_changes SSE");
    const changesEvent = events.find((e) => e.type === "file_changes");
    expect(changesEvent?.data).toEqual({ paths: ["src/App.tsx", "src/index.ts"] });

    sse.close();
  });
});

// ---------------------------------------------------------------------------
// ContainerSessionRunner Phase 3 Proxy Tests
// ---------------------------------------------------------------------------

describe("Phase 3: ContainerSessionRunner Terminal Proxy", () => {
  let worker: SessionWorker;
  let lastTerminal: StubTerminal;
  let workerUrl: string;

  beforeEach(async () => {
    lastTerminal = null as unknown as StubTerminal;

    worker = new SessionWorker({
      agentFactory: () => new FakeWorkerAgent(),
      port: 0,
      host: "127.0.0.1",
      createTerminal: () => {
        lastTerminal = new StubTerminal();
        return lastTerminal as unknown as import("../../session/terminal.js").TerminalProcess;
      },
      createPreviewManager: () => {
        return new StubPreview() as unknown as import("../../session/preview-manager.js").PreviewManager;
      },
      createFileWatcher: () => {
        return new StubWatcher() as unknown as import("../../session/file-watcher.js").FileWatcher;
      },
    });

    const address = await worker.start();
    const match = address.match(/:(\d+)$/);
    workerUrl = `http://127.0.0.1:${match ? match[1] : 0}`;
  });

  afterEach(async () => {
    await worker.stop();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("starts terminal on worker and receives output via SSE → emitMessage", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "term-test",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    const messages: WsServerMessage[] = [];
    runner.on("message", (msg) => messages.push(msg));

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    await runner.startTerminalOnWorker(100, 30);
    expect(lastTerminal.startCalled).toBe(true);
    expect(lastTerminal.lastCols).toBe(100);
    expect(lastTerminal.lastRows).toBe(30);
    expect(runner.remoteTerminalRunning).toBe(true);

    // Simulate terminal output
    lastTerminal.emit("data", "$ ls\nfile.txt\n");

    await waitFor(
      () => messages.some((m) => m.type === "terminal_output"),
      2000,
      "terminal_output message",
    );

    const termMsg = messages.find((m) => m.type === "terminal_output");
    expect(termMsg).toMatchObject({ type: "terminal_output", data: "$ ls\nfile.txt\n" });

    runner.dispose();
  });

  it("writes to terminal on worker", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "term-write",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    await runner.startTerminalOnWorker();
    await runner.writeTerminalOnWorker("echo hello\r");

    expect(lastTerminal.writtenData).toEqual(["echo hello\r"]);

    runner.dispose();
  });

  it("resizes terminal on worker", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "term-resize",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    await runner.startTerminalOnWorker();
    await runner.resizeTerminalOnWorker(120, 40);

    expect(lastTerminal.resizedTo).toEqual([{ cols: 120, rows: 40 }]);

    runner.dispose();
  });

  it("receives terminal_exit via SSE and clears remote terminal state", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "term-exit",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    const messages: WsServerMessage[] = [];
    runner.on("message", (msg) => messages.push(msg));

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    await runner.startTerminalOnWorker();
    expect(runner.remoteTerminalRunning).toBe(true);

    // Simulate terminal exit
    lastTerminal.emit("exit", 0);

    await waitFor(
      () => messages.some((m) => m.type === "terminal_exit"),
      2000,
      "terminal_exit message",
    );

    expect(runner.remoteTerminalRunning).toBe(false);

    runner.dispose();
  });
});

describe("Phase 3: ContainerSessionRunner Preview Proxy", () => {
  let worker: SessionWorker;
  let lastPreview: StubPreview;
  let workerUrl: string;

  beforeEach(async () => {
    lastPreview = null as unknown as StubPreview;

    worker = new SessionWorker({
      agentFactory: () => new FakeWorkerAgent(),
      port: 0,
      host: "127.0.0.1",
      createPreviewManager: () => {
        lastPreview = new StubPreview();
        return lastPreview as unknown as import("../../session/preview-manager.js").PreviewManager;
      },
      createTerminal: () => {
        return new StubTerminal() as unknown as import("../../session/terminal.js").TerminalProcess;
      },
      createFileWatcher: () => {
        return new StubWatcher() as unknown as import("../../session/file-watcher.js").FileWatcher;
      },
    });

    const address = await worker.start();
    const match = address.match(/:(\d+)$/);
    workerUrl = `http://127.0.0.1:${match ? match[1] : 0}`;
  });

  afterEach(async () => {
    await worker.stop();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("receives preview_ready and updates buildPreviewStatus", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "preview-ready",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    const messages: WsServerMessage[] = [];
    runner.on("message", (msg) => messages.push(msg));

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    // Start preview explicitly (in addition to the one started by attachViewer)
    // We need to get the lastPreview reference
    await new Promise((r) => setTimeout(r, 100));

    // Simulate preview ready on the worker side
    lastPreview.simulateReady([3000]);

    await waitFor(
      () => messages.some((m) => m.type === "preview_status" && (m as { running: boolean }).running === true),
      2000,
      "preview_status running message",
    );

    // Check buildPreviewStatus returns proxy URL format
    const status = runner.buildPreviewStatus();
    expect(status).toMatchObject({
      type: "preview_status",
      running: true,
      port: 3000,
      url: "/preview/preview-ready/3000/",
    });

    runner.dispose();
  });

  it("clears preview ports on preview_stopped", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "preview-stop",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    const messages: WsServerMessage[] = [];
    runner.on("message", (msg) => messages.push(msg));

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 300));

    // Simulate preview ready then stopped
    lastPreview.simulateReady([3000]);
    await waitFor(
      () => messages.some((m) => m.type === "preview_status"),
      2000,
      "first preview_status",
    );

    lastPreview.simulateStopped(0);
    await waitFor(
      () => messages.filter((m) => m.type === "preview_status").length >= 2,
      2000,
      "second preview_status",
    );

    const status = runner.buildPreviewStatus();
    expect(status).toMatchObject({
      type: "preview_status",
      running: false,
    });

    runner.dispose();
  });

  it("includes exitCode and errorOutput in preview_status on crash", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "preview-crash",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    const messages: WsServerMessage[] = [];
    runner.on("message", (msg) => messages.push(msg));

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 300));

    // Emit some preview logs followed by a non-zero exit
    lastPreview.simulateLog("preview", "Starting server...\n");
    lastPreview.simulateLog("preview", "Error: Cannot find module '@rollup/rollup-linux-arm64-gnu'\n");
    lastPreview.simulateStopped(1);

    await waitFor(
      () => messages.some((m) => m.type === "preview_status" && !(m as { running: boolean }).running),
      2000,
      "crashed preview_status",
    );

    const status = runner.buildPreviewStatus() as { type: string; running: boolean; exitCode?: number; errorOutput?: string };
    expect(status).toMatchObject({
      type: "preview_status",
      running: false,
      exitCode: 1,
    });
    expect(status.errorOutput).toContain("Cannot find module");

    runner.dispose();
  });

  it("clears crash info when preview becomes ready again", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "preview-recover",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    const messages: WsServerMessage[] = [];
    runner.on("message", (msg) => messages.push(msg));

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 300));

    // Crash first
    lastPreview.simulateLog("preview", "Fatal error\n");
    lastPreview.simulateStopped(1);
    await waitFor(
      () => messages.some((m) => m.type === "preview_status"),
      2000,
      "crashed status",
    );

    // Then recover
    lastPreview.simulateReady([3000]);
    await waitFor(
      () => messages.filter((m) => m.type === "preview_status").length >= 2,
      2000,
      "recovered status",
    );

    const status = runner.buildPreviewStatus() as { type: string; running: boolean; exitCode?: number; errorOutput?: string };
    expect(status).toMatchObject({
      type: "preview_status",
      running: true,
      port: 3000,
    });
    expect(status.exitCode).toBeUndefined();
    expect(status.errorOutput).toBeUndefined();

    runner.dispose();
  });

  it("builds proxy URLs in preview status", () => {
    const runner = new ContainerSessionRunner({
      sessionId: "my-session-123",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    // Default (no ports)
    const defaultStatus = runner.buildPreviewStatus();
    expect(defaultStatus).toMatchObject({
      type: "preview_status",
      running: false,
      url: "/preview/my-session-123/5173/",
    });

    // With detected ports
    runner.detectedPorts = [8080, 3000];
    const detectedStatus = runner.buildPreviewStatus();
    expect(detectedStatus).toMatchObject({
      type: "preview_status",
      running: true,
      port: 8080,
      url: "/preview/my-session-123/8080/",
      source: "detected",
    });

    runner.dispose();
  });
});

describe("Phase 3: ContainerSessionRunner File Watcher Proxy", () => {
  let worker: SessionWorker;
  let lastWatcher: StubWatcher;
  let workerUrl: string;

  beforeEach(async () => {
    lastWatcher = null as unknown as StubWatcher;

    worker = new SessionWorker({
      agentFactory: () => new FakeWorkerAgent(),
      port: 0,
      host: "127.0.0.1",
      createFileWatcher: () => {
        lastWatcher = new StubWatcher();
        return lastWatcher as unknown as import("../../session/file-watcher.js").FileWatcher;
      },
      createPreviewManager: () => {
        return new StubPreview() as unknown as import("../../session/preview-manager.js").PreviewManager;
      },
      createTerminal: () => {
        return new StubTerminal() as unknown as import("../../session/terminal.js").TerminalProcess;
      },
    });

    const address = await worker.start();
    const match = address.match(/:(\d+)$/);
    workerUrl = `http://127.0.0.1:${match ? match[1] : 0}`;
  });

  afterEach(async () => {
    await worker.stop();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("receives file_changes via SSE and emits files_changed message", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "watcher-test",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    const messages: WsServerMessage[] = [];
    runner.on("message", (msg) => messages.push(msg));

    runner.attachViewer();
    // Wait for SSE connection + file watcher to start on worker
    await new Promise((r) => setTimeout(r, 300));

    // Simulate file changes
    lastWatcher.simulateChanges(["src/App.tsx", "src/index.ts"]);

    await waitFor(
      () => messages.some((m) => m.type === "files_changed"),
      2000,
      "files_changed message",
    );

    const changeMsg = messages.find((m) => m.type === "files_changed");
    expect(changeMsg).toMatchObject({
      type: "files_changed",
      paths: ["src/App.tsx", "src/index.ts"],
    });

    runner.dispose();
  });

  it("starts worker resources on first viewer attach and stops on last detach", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "lifecycle-test",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    // First viewer — should start file watcher + preview
    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 300));

    // Verify file watcher was started on the worker
    expect(lastWatcher.startCalled).toBe(true);

    // Second viewer — should not re-start
    runner.attachViewer();
    expect(runner.viewerCount).toBe(2);

    // First viewer leaves — resources should stay
    runner.detachViewer();
    expect(runner.viewerCount).toBe(1);

    // Last viewer leaves — resources should be stopped
    runner.detachViewer();
    expect(runner.viewerCount).toBe(0);

    runner.dispose();
  });

  it("supportsRemoteTerminal is true", () => {
    const runner = new ContainerSessionRunner({
      sessionId: "remote-terminal",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    expect(runner.supportsRemoteTerminal).toBe(true);

    runner.dispose();
  });
});

// ---------------------------------------------------------------------------
// Preview Reverse Proxy Tests
// ---------------------------------------------------------------------------

describe("Phase 3: Preview Reverse Proxy", () => {
  it("returns 404 for unknown session", async () => {
    const fakeContainerManager = {
      get: (_sessionId: string) => undefined,
    };

    const app = Fastify({ logger: false });
    registerPreviewProxy(app, {
      containerManager: fakeContainerManager as unknown as import("../session-container.js").SessionContainerManager,
    });
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/preview/unknown-session/3000/index.html",
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "Session container not found" });

    await app.close();
  });

  it("returns 400 for invalid port", async () => {
    const fakeContainerManager = {
      get: () => ({ containerIp: "172.18.0.3" }),
    };

    const app = Fastify({ logger: false });
    registerPreviewProxy(app, {
      containerManager: fakeContainerManager as unknown as import("../session-container.js").SessionContainerManager,
    });
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/preview/test-session/99999/index.html",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "Invalid port" });

    await app.close();
  });

  it("returns 400 for non-numeric port", async () => {
    const fakeContainerManager = {
      get: () => ({ containerIp: "172.18.0.3" }),
    };

    const app = Fastify({ logger: false });
    registerPreviewProxy(app, {
      containerManager: fakeContainerManager as unknown as import("../session-container.js").SessionContainerManager,
    });
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/preview/test-session/abc/index.html",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "Invalid port" });

    await app.close();
  });

  it("proxies request to container IP (end-to-end with mock server)", async () => {
    // Create a small HTTP server to act as the "container"
    const containerServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body>Hello from container! Path: ${req.url}</body></html>`);
    });

    await new Promise<void>((resolve) => {
      containerServer.listen(0, "127.0.0.1", resolve);
    });

    const containerAddr = containerServer.address();
    const containerPort = typeof containerAddr === "object" && containerAddr ? containerAddr.port : 0;

    const fakeContainerManager = {
      get: (sessionId: string) => {
        if (sessionId === "proxy-test") {
          return { containerIp: "127.0.0.1" };
        }
        return undefined;
      },
    };

    const app = Fastify({ logger: false });
    registerPreviewProxy(app, {
      containerManager: fakeContainerManager as unknown as import("../session-container.js").SessionContainerManager,
    });

    // Start the Fastify server to get a real HTTP connection (needed for hijack)
    await app.listen({ port: 0, host: "127.0.0.1" });
    const appAddr = app.server.address();
    const appPort = typeof appAddr === "object" && appAddr ? appAddr.port : 0;

    // Make a real HTTP request (inject won't work with hijack)
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: appPort,
          path: `/preview/proxy-test/${containerPort}/index.html`,
          method: "GET",
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () => resolve(data));
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(body).toContain("Hello from container!");
    expect(body).toContain("Path: /index.html");

    containerServer.close();
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Worker cleanup tests
// ---------------------------------------------------------------------------

describe("Phase 3: Worker Cleanup", () => {
  it("cleans up terminal, preview, and file watcher on stop", async () => {
    let terminal: StubTerminal | null = null;
    let preview: StubPreview | null = null;
    let watcher: StubWatcher | null = null;

    const worker = new SessionWorker({
      agentFactory: () => new FakeWorkerAgent(),
      port: 0,
      host: "127.0.0.1",
      createTerminal: () => {
        terminal = new StubTerminal();
        return terminal as unknown as import("../../session/terminal.js").TerminalProcess;
      },
      createPreviewManager: () => {
        preview = new StubPreview();
        return preview as unknown as import("../../session/preview-manager.js").PreviewManager;
      },
      createFileWatcher: () => {
        watcher = new StubWatcher();
        return watcher as unknown as import("../../session/file-watcher.js").FileWatcher;
      },
    });

    await worker.start();

    // Start all resources
    await worker.getApp().inject({ method: "POST", url: "/terminal/start", payload: {} });
    await worker.getApp().inject({ method: "POST", url: "/preview/start" });
    await worker.getApp().inject({ method: "POST", url: "/files/watch" });

    expect(terminal!.startCalled).toBe(true);
    expect(preview!.startCalled).toBe(true);
    expect(watcher!.startCalled).toBe(true);

    // Stop worker — should clean up all resources
    await worker.stop();

    expect(terminal!.killed).toBe(true);
    expect(preview!.stopCalled).toBe(true);
    expect(watcher!.stopCalled).toBe(true);
  });
});
