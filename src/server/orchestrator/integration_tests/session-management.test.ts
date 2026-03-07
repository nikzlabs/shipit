import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";


import type { FastifyInstance } from "fastify";
import {
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

describe("Integration: Session management", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-session-mgmt-"));

    sessionManager = new SessionManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    await app.listen({ port: 0, host: "127.0.0.1" });
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

  it("bootstrap returns empty session list initially", async () => {
    const res = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions).toEqual([]);
  });

  it("POST /api/sessions is removed (standalone sessions no longer supported)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions", payload: { title: "Test" } });
    expect(res.statusCode).toBe(404);
  });

});

describe("Integration: bootstrap sessions remoteUrl caching", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-session-remote-"));

    sessionManager = new SessionManager(dbManager);

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
      // Ignore cleanup errors
    }
  });

  it("bootstrap returns cached remoteUrl from session metadata", async () => {
    sessionManager.track("sess-remote", "My repo", path.join(tmpDir, "sess-remote"));
    sessionManager.setRemoteUrl("sess-remote", "https://github.com/owner/repo.git");

    const res = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(res.statusCode).toBe(200);
    const sessions = res.json().sessions as { id: string; remoteUrl: string }[];
    const session = sessions.find((s) => s.id === "sess-remote");
    expect(session?.remoteUrl).toBe("https://github.com/owner/repo.git");
  });

  it("bootstrap lazy-populates remoteUrl from git config", async () => {
    // Create a real git repo with an origin remote
    const sessionDir = path.join(tmpDir, "sess-git");
    fs.mkdirSync(sessionDir, { recursive: true });
    const git = new GitManager(sessionDir);
    await git.init();
    await git.addRemote("origin", "https://github.com/lazy/populated.git");

    sessionManager.track("sess-git", "Lazy session", sessionDir);
    // No remoteUrl cached yet

    const res = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(res.statusCode).toBe(200);
    const sessions = res.json().sessions as { id: string; remoteUrl: string }[];
    const session = sessions.find((s) => s.id === "sess-git");
    expect(session?.remoteUrl).toBe("https://github.com/lazy/populated.git");

    // Should also be persisted in the manager
    expect(sessionManager.get("sess-git")?.remoteUrl).toBe("https://github.com/lazy/populated.git");
  });

  it("bootstrap handles sessions with missing workspace dirs gracefully", async () => {
    sessionManager.track("sess-missing", "Gone session", path.join(tmpDir, "does-not-exist"));

    const res = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(res.statusCode).toBe(200);
    const sessions = res.json().sessions as { id: string; remoteUrl: string }[];
    const session = sessions.find((s) => s.id === "sess-missing");
    // Should not crash and remoteUrl stays empty
    expect(session?.remoteUrl).toBe("");
  });

});
