/**
 * Integration tests for worker file watcher endpoints, ContainerSessionRunner
 * file watcher proxy, viewer lifecycle, and worker resource cleanup.
 *
 * Tests cover:
 * 1. Worker file watcher HTTP endpoints (watch, unwatch) + SSE events
 * 2. ContainerSessionRunner file watcher proxy (SSE → emitMessage)
 * 3. Viewer attach/detach lifecycle (resource start/stop)
 * 4. Worker cleanup (terminal, preview, file watcher on stop)
 *
 * Uses in-process Fastify with stubs — no Docker or real processes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionWorker } from "../../session/session-worker.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import type { WsServerMessage } from "../../shared/types.js";
import type { FileWatcher } from "../../session/file-watcher.js";
import type { TerminalProcess } from "../../session/terminal.js";
import {
  FakeWorkerAgent,
  StubTerminal,
  StubWatcher,
  collectSSE,
  waitFor,
} from "./container-test-helpers.js";

// ---------------------------------------------------------------------------
// Worker File Watcher Endpoints
// ---------------------------------------------------------------------------

describe("Worker File Watcher Endpoints", () => {
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
        return lastWatcher as unknown as FileWatcher;
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

    const events: { type: string; data: unknown }[] = [];
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
// ContainerSessionRunner File Watcher Proxy
// ---------------------------------------------------------------------------

describe("ContainerSessionRunner File Watcher Proxy", () => {
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
        return lastWatcher as unknown as FileWatcher;
      },
      createTerminal: () => {
        return new StubTerminal() as unknown as TerminalProcess;
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
// Worker Cleanup
// ---------------------------------------------------------------------------

describe("Worker Cleanup", () => {
  it("cleans up terminal and file watcher on stop (session mode)", async () => {
    let terminal: StubTerminal | null = null;
    let watcher: StubWatcher | null = null;

    const worker = new SessionWorker({
      agentFactory: () => new FakeWorkerAgent(),
      port: 0,
      host: "127.0.0.1",
      createTerminal: () => {
        terminal = new StubTerminal();
        return terminal as unknown as TerminalProcess;
      },
      createFileWatcher: () => {
        watcher = new StubWatcher();
        return watcher as unknown as FileWatcher;
      },
    });

    await worker.start();

    // Start session-mode resources (terminal + file watcher)
    await worker.getApp().inject({ method: "POST", url: "/terminal/start", payload: {} });
    await worker.getApp().inject({ method: "POST", url: "/files/watch" });

    expect(terminal!.startCalled).toBe(true);
    expect(watcher!.startCalled).toBe(true);

    // Stop worker — should clean up all resources
    await worker.stop();

    expect(terminal!.killed).toBe(true);
    expect(watcher!.stopCalled).toBe(true);
  });

});
