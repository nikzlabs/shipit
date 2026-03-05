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
import { ContainerSessionRunner, truncateTerminalBuffer } from "../container-session-runner.js";
import type { WsServerMessage } from "../../shared/types.js";
import type { TerminalProcess } from "../../session/terminal.js";
import type { PreviewManager } from "../../session/preview-manager.js";
import type { FileWatcher } from "../../session/file-watcher.js";
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
        return lastTerminal as unknown as TerminalProcess;
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

    const events: { type: string; data: unknown }[] = [];
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

    const events: { type: string; data: unknown }[] = [];
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
        return lastTerminal as unknown as TerminalProcess;
      },
      createPreviewManager: () => {
        return new StubPreview() as unknown as PreviewManager;
      },
      createFileWatcher: () => {
        return new StubWatcher() as unknown as FileWatcher;
      },
    });

    const address = await worker.start();
    const match = /:(\d+)$/.exec(address);
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
        return lastTerminal as unknown as TerminalProcess;
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

// ---------------------------------------------------------------------------
// Terminal Buffer Truncation
// ---------------------------------------------------------------------------

describe("truncateTerminalBuffer", () => {
  it("returns buffer unchanged if within limit", () => {
    expect(truncateTerminalBuffer("hello\nworld\n", 100)).toBe("hello\nworld\n");
  });

  it("truncates at newline boundary", () => {
    const buf = "line1\nline2\nline3\nline4\n";
    // Request max 12 bytes — should cut at a newline boundary from the end
    const result = truncateTerminalBuffer(buf, 12);
    // The tail 12 chars of the buffer is "line3\nline4\n" (12 chars), but
    // truncation searches forward from the cut point for a newline
    expect(result).not.toContain("line1");
    // Result should start at a line boundary
    expect(result).toMatch(/^line/);
    expect(result).toContain("line4\n");
  });

  it("truncates at ANSI reset sequence when no newline found", () => {
    // No newlines, but has ANSI reset sequences
    const buf = "\x1b[31mredtext\x1b[0m\x1b[32mgreentext\x1b[0mnormaltext";
    // Request small enough to force truncation
    const result = truncateTerminalBuffer(buf, 20);
    // Should cut at an \x1b[0m boundary, not mid-escape
    expect(result).not.toContain("\x1b[31m");
  });

  it("falls back to raw cut when no boundary found", () => {
    // No newlines, no ANSI resets — just a long string of chars
    const buf = "a".repeat(200);
    const result = truncateTerminalBuffer(buf, 100);
    expect(result.length).toBe(100);
    expect(result).toBe("a".repeat(100));
  });

  it("handles empty buffer", () => {
    expect(truncateTerminalBuffer("", 100)).toBe("");
  });

  it("prefers newline over ANSI reset when both present", () => {
    // Newline appears before ANSI reset in the search window
    const head = "x".repeat(100);
    const tail = "after-newline\x1b[0mafter-reset-end";
    const buf = `${head  }\n${  tail}`;
    const result = truncateTerminalBuffer(buf, tail.length + 5);
    // Should cut at the newline, not the ANSI reset
    expect(result).toBe(tail);
  });
});

// ---------------------------------------------------------------------------
// SSE Disconnect → Terminal Reconnect
// ---------------------------------------------------------------------------

describe("ContainerSessionRunner SSE Disconnect Handling", () => {
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
        return lastTerminal as unknown as TerminalProcess;
      },
      createPreviewManager: () => {
        return new StubPreview() as unknown as PreviewManager;
      },
      createFileWatcher: () => {
        return new StubWatcher() as unknown as FileWatcher;
      },
    });

    const address = await worker.start();
    const match = /:(\d+)$/.exec(address);
    workerUrl = `http://127.0.0.1:${match ? match[1] : 0}`;
  });

  afterEach(async () => {
    await worker.stop();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("emits terminal_reconnecting when SSE drops while terminal is running", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "reconnect-test",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    const messages: WsServerMessage[] = [];
    runner.on("message", (msg) => messages.push(msg));

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    // Start terminal and produce output
    await runner.startTerminalOnWorker(80, 24);
    lastTerminal.emit("data", "$ hello\n");

    await waitFor(
      () => messages.some((m) => m.type === "terminal_output"),
      2000,
      "terminal_output message",
    );

    // Now stop the worker to simulate SSE disconnection
    await worker.stop();

    // Should receive terminal_reconnecting
    await waitFor(
      () => messages.some((m) => m.type === "terminal_reconnecting"),
      5000,
      "terminal_reconnecting message",
    );

    const reconnectMsg = messages.find((m) => m.type === "terminal_reconnecting");
    expect(reconnectMsg).toMatchObject({
      type: "terminal_reconnecting",
      attempt: 1,
      maxAttempts: 3,
    });

    runner.dispose();
  });

  it("replays terminal buffer with reset prefix on SSE reconnect", { timeout: 20_000 }, async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "replay-test",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    const messages: WsServerMessage[] = [];
    runner.on("message", (msg) => messages.push(msg));

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    // Start terminal and produce output
    await runner.startTerminalOnWorker(80, 24);
    lastTerminal.emit("data", "buffered output\n");

    await waitFor(
      () => messages.some((m) => m.type === "terminal_output"),
      2000,
      "terminal_output",
    );

    // Stop then restart worker to trigger SSE disconnect + reconnect
    await worker.stop();
    await waitFor(
      () => messages.some((m) => m.type === "terminal_reconnecting"),
      5000,
      "terminal_reconnecting",
    );

    // Restart the worker on the same port
    const newWorker = new SessionWorker({
      agentFactory: () => new FakeWorkerAgent(),
      port: Number(new URL(workerUrl).port),
      host: "127.0.0.1",
      createTerminal: () => {
        lastTerminal = new StubTerminal();
        return lastTerminal as unknown as TerminalProcess;
      },
      createPreviewManager: () => {
        return new StubPreview() as unknown as PreviewManager;
      },
      createFileWatcher: () => {
        return new StubWatcher() as unknown as FileWatcher;
      },
    });
    await newWorker.start();

    // Wait for reconnect — should replay buffer with \x1bc prefix
    await waitFor(
      () => messages.some((m) =>
        m.type === "terminal_output" &&
        (m as { data: string }).data.startsWith("\x1bc"),
      ),
      10000,
      "terminal_output with reset prefix",
    );

    const replayMsg = messages.find(
      (m) => m.type === "terminal_output" && (m as { data: string }).data.startsWith("\x1bc"),
    );
    expect(replayMsg).toBeDefined();
    expect((replayMsg as { data: string }).data).toContain("buffered output\n");

    runner.dispose();
    await newWorker.stop();
  });

  it("emits terminal_exit after exhausting reconnection attempts", { timeout: 30_000 }, async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "exhaust-test",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    const messages: WsServerMessage[] = [];
    runner.on("message", (msg) => messages.push(msg));

    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    // Start terminal
    await runner.startTerminalOnWorker(80, 24);

    // Stop the worker — no restart, so all reconnect attempts will fail
    await worker.stop();

    // Should eventually get terminal_exit after all reconnect attempts fail.
    // Backoff delays: 1s + 2s + 4s = 7s minimum, plus connection timeout,
    // so allow generous wait time.
    await waitFor(
      () => messages.some((m) => m.type === "terminal_exit"),
      25_000,
      "terminal_exit after exhausted reconnects",
    );

    expect(runner.remoteTerminalRunning).toBe(false);

    // Should have received multiple terminal_reconnecting messages
    const reconnectMsgs = messages.filter((m) => m.type === "terminal_reconnecting");
    expect(reconnectMsgs.length).toBeGreaterThanOrEqual(3);

    runner.dispose();
  });

  it("increases terminal output buffer to ~80KB", () => {
    const runner = new ContainerSessionRunner({
      sessionId: "buffer-size-test",
      sessionDir: "/tmp/test",
      defaultAgentId: "claude",
      workerUrl,
    });

    // Write more than 10KB but less than 80KB — old limit would truncate
    const data = "x".repeat(50_000);
    runner.appendTerminalOutput(data);
    expect(runner.getTerminalOutputBuffer().length).toBe(50_000);

    // Write enough to exceed 80KB
    runner.appendTerminalOutput("y".repeat(50_000));
    // Buffer should be truncated to approximately 80KB
    expect(runner.getTerminalOutputBuffer().length).toBeLessThanOrEqual(80_000);
    expect(runner.getTerminalOutputBuffer().length).toBeGreaterThan(0);

    runner.dispose();
  });
});
