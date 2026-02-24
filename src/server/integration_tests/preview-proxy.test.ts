import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { PreviewManager } from "../preview-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import type { FastifyInstance } from "fastify";
import {
  StubPreviewManager,
  StubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
  createTestCredentialStore,
} from "./test-helpers.js";

/** Create a simple upstream HTTP server that echoes request info. */
function createUpstreamServer(): http.Server {
  return http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, method: req.method }));
  });
}

/** Create an upstream server that handles WebSocket upgrades. */
function createUpstreamWsServer(): { server: http.Server; wss: WebSocketServer } {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (data: WebSocket.Data) => {
      // Echo back with a prefix
      ws.send(`echo: ${data.toString()}`);
    });
  });
  return { server, wss };
}

async function listenOnEphemeral(server: http.Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}

describe("Integration: Preview proxy", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let stubPreview: StubPreviewManager;
  let upstream: http.Server;
  let upstreamPort: number;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-proxy-"));
    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);
    stubPreview = new StubPreviewManager();

    // Start an upstream server to proxy to
    upstream = createUpstreamServer();
    upstreamPort = await listenOnEphemeral(upstream);

    // Set up the stub preview manager to report the upstream port as managed
    stubPreview.setRunning(upstreamPort);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      previewManager: stubPreview as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startPreview: false,
      portScanIntervalMs: 0,
    });

    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterEach(async () => {
    await app.close();
    upstream.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("proxies HTTP GET to allowed port and strips prefix", async () => {
    const res = await app.inject({ method: "GET", url: `/preview/${upstreamPort}/api/users` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe("/api/users");
    expect(body.method).toBe("GET");
  });

  it("proxies HTTP POST to allowed port", async () => {
    const res = await app.inject({ method: "POST", url: `/preview/${upstreamPort}/submit` });
    expect(res.statusCode).toBe(200);
    expect(res.json().method).toBe("POST");
  });

  it("returns 403 for unregistered ports", async () => {
    const res = await app.inject({ method: "GET", url: "/preview/19876/" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("Port not allowed");
  });

  it("returns 502 when upstream is unreachable", async () => {
    // Stop the upstream server so the port is closed
    upstream.close();
    await new Promise((r) => setTimeout(r, 100));

    const res = await app.inject({ method: "GET", url: `/preview/${upstreamPort}/` });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("Upstream unreachable");
  });

  it("preserves path and query string", async () => {
    const res = await app.inject({ method: "GET", url: `/preview/${upstreamPort}/a/b?c=d&e=f` });
    expect(res.statusCode).toBe(200);
    expect(res.json().path).toBe("/a/b?c=d&e=f");
  });

  it("redirects bare /preview/:port to /preview/:port/", async () => {
    const res = await app.inject({ method: "GET", url: `/preview/${upstreamPort}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/preview/${upstreamPort}/`);
  });
});

describe("Integration: Preview WebSocket proxy", () => {
  let app: FastifyInstance;
  let appPort: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let stubPreview: StubPreviewManager;
  let upstreamHttpServer: http.Server;
  let upstreamWss: WebSocketServer;
  let upstreamPort: number;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-wsproxy-"));
    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);
    stubPreview = new StubPreviewManager();

    // Start an upstream WebSocket server
    const { server, wss } = createUpstreamWsServer();
    upstreamHttpServer = server;
    upstreamWss = wss;
    upstreamPort = await listenOnEphemeral(upstreamHttpServer);

    stubPreview.setRunning(upstreamPort);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      previewManager: stubPreview as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startPreview: false,
      portScanIntervalMs: 0,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    appPort = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    upstreamWss.close();
    upstreamHttpServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("proxies WebSocket connections and relays messages bidirectionally", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${appPort}/preview/${upstreamPort}/`);
    await once(ws, "open");

    // Send a message from client → upstream
    ws.send("hello");

    // Receive the echoed response from upstream → client
    const [data] = await once(ws, "message");
    expect(data.toString()).toBe("echo: hello");

    ws.close();
    await once(ws, "close");
  });

  it("destroys socket for disallowed WebSocket port", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${appPort}/preview/19876/`);

    // The connection should be destroyed (error or close event)
    const result = await Promise.race([
      once(ws, "error").then(() => "error"),
      once(ws, "close").then(() => "close"),
    ]);

    expect(["error", "close"]).toContain(result);
  });
});
