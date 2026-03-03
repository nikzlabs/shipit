/**
 * Integration tests for worker terminal endpoints and ContainerSessionRunner
 * terminal proxy.
 *
 * Tests cover:
 * 1. Worker terminal HTTP endpoints (start, input, resize) + SSE events
 * 2. ContainerSessionRunner terminal proxy (SSE → emitMessage)
 * 3. SSE backpressure → PTY pause/resume
 *
 * Uses in-process Fastify with stubs — no Docker or real processes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { SessionWorker } from "../../session/session-worker.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import type { WsServerMessage } from "../../shared/types.js";
import {
  FakeWorkerAgent,
  StubTerminal,
  StubPreview,
  StubWatcher,
  collectSSE,
  waitFor,
} from "./container-test-helpers.js";

// ---------------------------------------------------------------------------
// Worker Terminal Endpoints
// ---------------------------------------------------------------------------

describe("Worker Terminal Endpoints", () => {
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
// ContainerSessionRunner Terminal Proxy
// ---------------------------------------------------------------------------

describe("ContainerSessionRunner Terminal Proxy", () => {
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

// ---------------------------------------------------------------------------
// Terminal Backpressure
// ---------------------------------------------------------------------------

describe("Terminal SSE Backpressure", () => {
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

  it("pauses PTY when SSE client write buffer is full and resumes on drain", async () => {
    const address = worker.getApp().server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    // Connect an SSE client that pauses reading to simulate backpressure
    const connected = new Promise<http.IncomingMessage>((resolve) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path: "/events", method: "GET", headers: { Accept: "text/event-stream" } },
        (res) => resolve(res),
      );
      req.end();
    });

    const res = await connected;

    // Give SSE time to connect
    await new Promise((r) => setTimeout(r, 100));

    // Start terminal
    await worker.getApp().inject({ method: "POST", url: "/terminal/start", payload: {} });
    expect(lastTerminal.paused).toBe(false);

    // Pause the response stream to stop draining the server's write buffer.
    // This causes reply.raw.write() to eventually return false.
    res.pause();

    // Flood terminal data until the server-side write buffer fills up.
    // Node.js default highWaterMark is 16KB, so 64KB of data should trigger it.
    const chunk = "x".repeat(1024);
    for (let i = 0; i < 128; i++) {
      lastTerminal.emit("data", chunk);
    }

    // The PTY should be paused due to backpressure
    await waitFor(() => lastTerminal.paused, 2000, "terminal paused");

    // Resume reading on the client side — this drains the buffer
    res.resume();

    // The PTY should resume once the buffer drains
    await waitFor(() => !lastTerminal.paused, 2000, "terminal resumed");

    res.destroy();
  });
});
