/**
 * Integration tests for worker preview endpoints, ContainerSessionRunner
 * preview proxy, and the preview reverse proxy.
 *
 * Tests cover:
 * 1. Worker preview HTTP endpoints (start, stop, status) + SSE events
 * 2. ContainerSessionRunner preview proxy (SSE → emitMessage, buildPreviewStatus)
 * 3. Preview reverse proxy routing (/preview/:sessionId/:port/*)
 *
 * Uses in-process Fastify with stubs — no Docker or real processes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import Fastify from "fastify";
import { SessionWorker } from "../../session/session-worker.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import { registerPreviewProxy } from "../preview-proxy.js";
import type { WsServerMessage } from "../../shared/types.js";
import type { PreviewManager } from "../../session/preview-manager.js";
import type { TerminalProcess } from "../../session/terminal.js";
import type { FileWatcher } from "../../session/file-watcher.js";
import type { SessionContainerManager } from "../session-container.js";
import {
  FakeWorkerAgent,
  StubTerminal,
  StubPreview,
  StubWatcher,
  collectSSE,
  waitFor,
} from "./container-test-helpers.js";

// ---------------------------------------------------------------------------
// Worker Preview Endpoints
// ---------------------------------------------------------------------------

describe("Worker Preview Endpoints", () => {
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
        return lastPreview as unknown as PreviewManager;
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

    const events: { type: string; data: unknown }[] = [];
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

    const events: { type: string; data: unknown }[] = [];
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

    const events: { type: string; data: unknown }[] = [];
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
// ContainerSessionRunner Preview Proxy
// ---------------------------------------------------------------------------

describe("ContainerSessionRunner Preview Proxy", () => {
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
        return lastPreview as unknown as PreviewManager;
      },
      createTerminal: () => {
        return new StubTerminal() as unknown as TerminalProcess;
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
      () => messages.some((m) => m.type === "preview_status" && (m as { running: boolean }).running),
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

// ---------------------------------------------------------------------------
// Preview Reverse Proxy
// ---------------------------------------------------------------------------

describe("Preview Reverse Proxy", () => {
  it("returns 404 for unknown session", async () => {
    const fakeContainerManager = {
      get: (_sessionId: string) => undefined,
    };

    const app = Fastify({ logger: false });
    registerPreviewProxy(app, {
      containerManager: fakeContainerManager as unknown as SessionContainerManager,
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
      containerManager: fakeContainerManager as unknown as SessionContainerManager,
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
      containerManager: fakeContainerManager as unknown as SessionContainerManager,
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
      containerManager: fakeContainerManager as unknown as SessionContainerManager,
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
          res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
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
