import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";


import type { FastifyInstance } from "fastify";
import type { GitHubAuthManager } from "../github-auth.js";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

describe("Integration: Claude auth (OAuth & API key)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-auth-"));

    const sessionManager = new SessionManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
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
    const unauthSessions = new SessionManager(dbManager);

    const unauthApp = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: unauthSessions,
      authManager: unauthStub,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      workspaceDir: unauthTmpDir,
      serveStatic: false,
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

  it("set_api_key authenticates and broadcasts agent_auth_complete", async () => {
    const unauthStub = new StubAuthManager() as unknown as AuthManager;
    (unauthStub as any).authenticated = false;
    (unauthStub as any).checkCredentials = () => {
      // Simulate: after setting the env var, checkCredentials succeeds
      const ok = !!process.env.ANTHROPIC_API_KEY;
      (unauthStub as any).authenticated = ok;
      return ok;
    };

    const unauthTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-apikey-"));
    const unauthSessions = new SessionManager(dbManager);

    // Clear any existing API key
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const unauthApp = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: unauthSessions,
      authManager: unauthStub,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      workspaceDir: unauthTmpDir,
      serveStatic: false,
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

      // agent_auth_complete is broadcast via SSE (docs/155 Phase 2b), not WS
      // — verify the stub auth state changed.
      expect(unauthStub.authenticated).toBe(true);
      client.close();
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

  it("paste_auth_code rejects empty code via HTTP", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/code",
      payload: { code: "  " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("paste_auth_code sends code to auth manager via HTTP", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/code",
      payload: { code: "test-auth-code-123" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true });
  });
});
