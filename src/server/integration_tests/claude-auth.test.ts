import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { PreviewManager } from "../preview-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubPreviewManager,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
} from "./test-helpers.js";

describe("Integration: Claude auth (OAuth & API key)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-auth-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    const sessionManager = new SessionManager(sessionsFile);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
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
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors — temp dir will be cleaned by OS
    }
  });

  it("send_message when unauthenticated sends auth_required", async () => {
    // Override the auth manager to be unauthenticated
    const unauthStub = new StubAuthManager() as unknown as AuthManager;
    (unauthStub as any).authenticated = false;
    (unauthStub as any).checkCredentials = () => false;

    const unauthTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-unauth-"));
    const unauthSessions = new SessionManager(path.join(unauthTmpDir, "sessions.json"));

    const unauthApp = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: unauthSessions,
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: unauthStub,
      githubAuthManager: new StubGitHubAuthManager() as unknown as import("../github-auth.js").GitHubAuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: unauthTmpDir,
      serveStatic: false,
      startPreview: false,
      portScanIntervalMs: 0,
    });
    const addr = await unauthApp.listen({ port: 0, host: "127.0.0.1" });
    const unauthPort = parseInt(new URL(addr).port);

    try {
      const client = await TestClient.connect(unauthPort);
      await client.receive(); // connection_established

      client.send({ type: "send_message", text: "hello" });
      const msg = await client.receive();

      expect(msg).toMatchObject({ type: "auth_required" });
      // No URL provided yet (OAuth flow starts in background)
      expect((msg as any).url).toBeUndefined();

      client.close();
    } finally {
      await unauthApp.close();
      fs.rmSync(unauthTmpDir, { recursive: true, force: true });
    }
  });

  it("set_api_key authenticates and broadcasts auth_complete", async () => {
    const unauthStub = new StubAuthManager() as unknown as AuthManager;
    (unauthStub as any).authenticated = false;
    (unauthStub as any).checkCredentials = () => {
      // Simulate: after setting the env var, checkCredentials succeeds
      const ok = !!process.env.ANTHROPIC_API_KEY;
      (unauthStub as any).authenticated = ok;
      return ok;
    };

    const unauthTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-apikey-"));
    const unauthSessions = new SessionManager(path.join(unauthTmpDir, "sessions.json"));

    // Clear any existing API key
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const unauthApp = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: unauthSessions,
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: unauthStub,
      githubAuthManager: new StubGitHubAuthManager() as unknown as import("../github-auth.js").GitHubAuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: unauthTmpDir,
      serveStatic: false,
      startPreview: false,
      portScanIntervalMs: 0,
    });
    const addr = await unauthApp.listen({ port: 0, host: "127.0.0.1" });
    const unauthPort = parseInt(new URL(addr).port);

    try {
      const client = await TestClient.connect(unauthPort);
      await client.receive(); // connection_established

      // Use HTTP endpoint to set API key
      const res = await unauthApp.inject({
        method: "POST",
        url: "/api/auth/api-key",
        payload: { key: "sk-ant-test-key-123" },
      });
      expect(res.statusCode).toBe(200);

      // The HTTP endpoint broadcasts auth_complete to all WS clients
      const msg = await client.receive();
      expect(msg).toMatchObject({ type: "auth_complete" });
    } finally {
      // Restore env
      if (origKey) {
        process.env.ANTHROPIC_API_KEY = origKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
      await unauthApp.close();
      fs.rmSync(unauthTmpDir, { recursive: true, force: true });
    }
  });

  it("set_api_key rejects invalid format", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/api-key",
      payload: { key: "bad-key" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "Invalid API key format" });
  });

  it("set_api_key rejects empty key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/api-key",
      payload: { key: "" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "API key cannot be empty" });
  });

  it("paste_auth_code rejects empty code", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // connection_established

    client.send({ type: "paste_auth_code", code: "" } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({ type: "error", message: "Authorization code cannot be empty" });

    client.close();
  });

  it("paste_auth_code sends code to auth manager", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // connection_established

    // paste_auth_code calls authManager.sendCode() — no error expected
    client.send({ type: "paste_auth_code", code: "test-auth-code-123" } as any);

    // Give the server a moment to process (sendCode is fire-and-forget)
    await new Promise((r) => setTimeout(r, 50));

    client.close();
  });
});
