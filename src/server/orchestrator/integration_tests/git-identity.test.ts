import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { GitHubAuthManager } from "../github-auth.js";


import { setGitIdentity } from "../git-config.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

describe("Integration: git identity flow", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionDir: string;
  let sessionId: string;
  let sessionManager: SessionManager;
  let origGitConfigGlobal: string | undefined;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-gitid-"));
    sessionId = crypto.randomUUID();
    sessionDir = path.join(tmpDir, "sessions", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    // Force buildApp to initialize the test's empty config instead of using a real identity.
    delete process.env.GIT_CONFIG_GLOBAL;
  });

  afterEach(async () => {
    dbManager.close();
    if (origGitConfigGlobal !== undefined) {
      process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    } else {
      delete process.env.GIT_CONFIG_GLOBAL;
    }

    if (app) await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  async function initSessionRepo(): Promise<void> {
    const git = new GitManager(sessionDir);
    await git.init();
  }

  async function startApp(): Promise<number> {
    sessionManager = new SessionManager(dbManager);
    sessionManager.track(sessionId, "Test session", sessionDir);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      workspaceDir: tmpDir,
      credentialsDir: path.join(tmpDir, "credentials"),
      serveStatic: false,
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = /:(\d+)$/.exec(address);
    return match ? Number(match[1]) : 0;
  }

  it("sends git_identity_required when no global identity is set", async () => {
    port = await startApp();

    fs.mkdirSync(sessionDir, { recursive: true });
    sessionManager.track(sessionId, "Test session", sessionDir);

    const client = await TestClient.connect(port, sessionId);

    const identityMsg = await client.receiveType("git_identity_required");
    expect(identityMsg.type).toBe("git_identity_required");

    client.close();
  });

  it("does not send git_identity_required when global identity is set", async () => {
    port = await startApp();

    setGitIdentity("Test User", "test@example.com");

    await initSessionRepo();
    sessionManager.track(sessionId, "Test session", sessionDir);

    const client = await TestClient.connect(port, sessionId);

    try {
      while (true) {
        const msg = await client.receive(500);
        expect(msg.type).not.toBe("git_identity_required");
      }
    } catch {
      // Timeout — no more messages, which is the expected outcome
    }

    client.close();
  });

  it("session repos inherit identity from global git config", async () => {
    port = await startApp();

    setGitIdentity("Global User", "global@example.com");

    await initSessionRepo();

    const git = new GitManager(sessionDir);
    const log = await git.log(1);
    expect(log).toHaveLength(1);
    expect(log[0].author).toBe("Global User");

    sessionManager.track(sessionId, "Test session", sessionDir);
    const client = await TestClient.connect(port, sessionId);

    try {
      while (true) {
        const msg = await client.receive(500);
        expect(msg.type).not.toBe("git_identity_required");
      }
    } catch {
      // Timeout — expected
    }

    client.close();
  });

});
