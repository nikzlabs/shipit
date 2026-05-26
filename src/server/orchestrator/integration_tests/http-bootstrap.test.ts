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
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import { GitHubAuthManager } from "../github-auth.js";
import { CredentialStore } from "../credential-store.js";
import { initGlobalGitConfig, setGitIdentity as setGlobalGitIdentity } from "../git-config.js";

describe("Integration: GET /api/bootstrap", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let githubAuthManager: StubGitHubAuthManager;
  let credentialStore: CredentialStore;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-bootstrap-"));

    sessionManager = new SessionManager(dbManager);
    githubAuthManager = new StubGitHubAuthManager();
    initGlobalGitConfig(tmpDir);
    credentialStore = new CredentialStore(tmpDir);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      credentialStore,
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

  it("returns bootstrap data with empty sessions", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body).toHaveProperty("sessions");
    expect(body).toHaveProperty("agents");
    expect(body).toHaveProperty("templates");
    expect(body).toHaveProperty("githubStatus");
    expect(body).toHaveProperty("settings");

    expect(body.sessions).toEqual([]);
    expect(body.githubStatus.authenticated).toBe(false);
    expect(Array.isArray(body.templates)).toBe(true);
    expect(body.templates.length).toBeGreaterThan(0);
    // Feature 118: runtimeMode defaults to "containerized" when neither
    // the RUNTIME_MODE env var nor a deps override is set.
    expect(body.runtimeMode).toBe("containerized");
  });

  it("returns sessions when they exist", async () => {
    // Create a session
    const sessionDir = path.join(tmpDir, "sessions", "test-id");
    fs.mkdirSync(sessionDir, { recursive: true });
    sessionManager.track("test-id", "Test Session", sessionDir);

    const res = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({
      id: "test-id",
      title: "Test Session",
    });
  });

  it("returns GitHub status when authenticated", async () => {
    await githubAuthManager.setToken("ghp_testtoken");

    const res = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.githubStatus.authenticated).toBe(true);
    expect(body.githubStatus.username).toBe("test-user");
  });

  it("returns global settings with git identity", async () => {
    setGlobalGitIdentity("Test User", "test@example.com");

    const res = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.settings.gitIdentity).toEqual({
      name: "Test User",
      email: "test@example.com",
    });
  });

  it("returns global settings with system prompt", async () => {
    const shipitDir = path.join(tmpDir, ".shipit");
    fs.mkdirSync(shipitDir, { recursive: true });
    fs.writeFileSync(path.join(shipitDir, "system-prompt.md"), "You are a helpful assistant.");

    const res = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.settings.systemPrompt).toBe("You are a helpful assistant.");
  });

  it("returns templates list", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Templates should have id, name, description, category, icon — but NOT files
    for (const template of body.templates) {
      expect(template).toHaveProperty("id");
      expect(template).toHaveProperty("name");
      expect(template).toHaveProperty("description");
      expect(template).toHaveProperty("category");
      expect(template).not.toHaveProperty("files");
    }
  });

  it("returns agents list", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(Array.isArray(body.agents)).toBe(true);
    // At minimum, claude should be listed
    const claude = body.agents.find((a: any) => a.id === "claude");
    expect(claude).toBeDefined();
    expect(claude).toHaveProperty("name");
    expect(claude).toHaveProperty("installed");
    expect(claude).toHaveProperty("authConfigured");
  });
});
