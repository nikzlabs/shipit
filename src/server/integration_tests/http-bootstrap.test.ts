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
  StubPreviewManager,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
} from "./test-helpers.js";
import { GitHubAuthManager } from "../github-auth.js";
import { CredentialStore } from "../credential-store.js";
import { initGlobalGitConfig, setGitIdentity as setGlobalGitIdentity } from "../git-config.js";

describe("Integration: GET /api/bootstrap", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let githubAuthManager: StubGitHubAuthManager;
  let credentialStore: CredentialStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-bootstrap-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);
    githubAuthManager = new StubGitHubAuthManager();
    initGlobalGitConfig(tmpDir);
    credentialStore = new CredentialStore(tmpDir);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      credentialStore,
      workspaceDir: tmpDir,
      serveStatic: false,
      startPreview: false,
      portScanIntervalMs: 0,
    });
  });

  afterEach(async () => {
    await app.close();
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
    expect(body).toHaveProperty("defaultAgentId");
    expect(body).toHaveProperty("templates");
    expect(body).toHaveProperty("githubStatus");
    expect(body).toHaveProperty("githubRepos");
    expect(body).toHaveProperty("settings");

    expect(body.sessions).toEqual([]);
    expect(body.githubStatus.authenticated).toBe(false);
    expect(body.githubRepos).toEqual([]);
    expect(Array.isArray(body.templates)).toBe(true);
    expect(body.templates.length).toBeGreaterThan(0);
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
    expect(body.githubRepos.length).toBeGreaterThan(0);
    expect(body.githubRepos[0]).toHaveProperty("fullName");
    expect(body.githubRepos[0]).toHaveProperty("cloneUrl");
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

  it("returns agents list with default agent ID", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.defaultAgentId).toBe("claude");
    expect(Array.isArray(body.agents)).toBe(true);
    // At minimum, claude should be listed
    const claude = body.agents.find((a: any) => a.id === "claude");
    expect(claude).toBeDefined();
    expect(claude).toHaveProperty("name");
    expect(claude).toHaveProperty("installed");
    expect(claude).toHaveProperty("authConfigured");
  });
});
