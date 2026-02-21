import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
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
  StubDeploymentManager,
  StubDeploymentStore,
} from "./test-helpers.js";
import { GitHubAuthManager } from "../github-auth.js";
import { CredentialStore } from "../credential-store.js";
import { initGlobalGitConfig, getGitIdentity, setGitIdentity } from "../git-config.js";
import { DeploymentManager } from "../deployment-manager.js";
import { DeploymentStore } from "../deployment-store.js";
import { AgentRegistry } from "../agents/agent-registry.js";

describe("Integration: Phase 2 HTTP mutation endpoints", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let githubAuthManager: StubGitHubAuthManager;
  let credentialStore: CredentialStore;
  let chatHistoryManager: ChatHistoryManager;
  let savedOpenAIKey: string | undefined;

  beforeEach(async () => {
    // Save and clear OPENAI_API_KEY so codex agent starts with authConfigured=false
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-http-mutations-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);
    githubAuthManager = new StubGitHubAuthManager();
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test User", "test@test.com");
    credentialStore = new CredentialStore(tmpDir);
    chatHistoryManager = new ChatHistoryManager(path.join(tmpDir, ".chat-history"));

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      credentialStore,
      chatHistoryManager,
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
    // Restore OPENAI_API_KEY
    if (savedOpenAIKey !== undefined) {
      process.env.OPENAI_API_KEY = savedOpenAIKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  /** Helper: create a session with a git repo. */
  async function createSession(id: string, title: string): Promise<string> {
    const sessionDir = path.join(tmpDir, "sessions", id);
    fs.mkdirSync(sessionDir, { recursive: true });
    sessionManager.track(id, title, sessionDir);
    const git = new GitManager(sessionDir);
    await git.init();
    // Create an initial commit so git log works
    fs.writeFileSync(path.join(sessionDir, "init.txt"), "init");
    await git.autoCommit("initial commit");
    return sessionDir;
  }

  // ---- Session mutations ----

  describe("PATCH /api/sessions/:id (rename)", () => {
    it("renames a session", async () => {
      await createSession("s1", "Old Title");
      const res = await app.inject({
        method: "PATCH",
        url: "/api/sessions/s1",
        payload: { title: "New Title" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.session.id).toBe("s1");
      expect(body.session.title).toBe("New Title");
    });

    it("returns 400 for empty title", async () => {
      await createSession("s1", "Title");
      const res = await app.inject({
        method: "PATCH",
        url: "/api/sessions/s1",
        payload: { title: "   " },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 for non-existent session", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/sessions/nonexistent",
        payload: { title: "Title" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("DELETE /api/sessions/:id (archive)", () => {
    it("archives a session and returns updated list", async () => {
      await createSession("s1", "Session 1");
      await createSession("s2", "Session 2");
      const res = await app.inject({
        method: "DELETE",
        url: "/api/sessions/s1",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const ids = body.sessions.map((s: any) => s.id);
      expect(ids).not.toContain("s1");
      expect(ids).toContain("s2");
    });
  });

  // ---- Git mutations ----

  describe("POST /api/sessions/:id/git/rollback", () => {
    it("rolls back to a previous commit", async () => {
      const dir = await createSession("s1", "Session 1");
      // Make a second commit
      fs.writeFileSync(path.join(dir, "file2.txt"), "content");
      const git = new GitManager(dir);
      await git.autoCommit("second commit");

      // Get the commits
      const logRes = await app.inject({ method: "GET", url: "/api/sessions/s1/git/log" });
      const commits = logRes.json().commits;
      const firstHash = commits[commits.length - 1].hash;

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/git/rollback",
        payload: { commitHash: firstHash },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().commitHash).toBe(firstHash);
    });

    it("returns 404 for non-existent session", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/nonexistent/git/rollback",
        payload: { commitHash: "abc" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/sessions/:id/git/reject", () => {
    it("rejects specific files", async () => {
      const dir = await createSession("s1", "Session 1");
      const git = new GitManager(dir);

      // Create a file and commit (this is the "before" state)
      fs.writeFileSync(path.join(dir, "revert.txt"), "original content");
      await git.autoCommit("add revert.txt");
      const beforeLog = await git.log(1);
      const fromCommit = beforeLog[0].hash;

      // Modify the file and commit (this is the "after" state we want to revert)
      fs.writeFileSync(path.join(dir, "revert.txt"), "modified content");
      await git.autoCommit("modify revert.txt");

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/git/reject",
        payload: { fromCommit, files: ["revert.txt"] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.revertedFiles).toEqual(["revert.txt"]);
      // Verify the file was reverted
      const content = fs.readFileSync(path.join(dir, "revert.txt"), "utf-8");
      expect(content).toBe("original content");
    });

    it("with empty files array reverts all (rollback)", async () => {
      const dir = await createSession("s1", "Session 1");
      const git = new GitManager(dir);
      const beforeLog = await git.log(1);
      const fromCommit = beforeLog[0].hash;

      // Make a change
      fs.writeFileSync(path.join(dir, "extra.txt"), "extra");
      await git.autoCommit("add extra");

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/git/reject",
        payload: { fromCommit, files: [] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().commitHash).toBe(fromCommit);
    });

    it("returns 400 for missing fromCommit", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/git/reject",
        payload: { fromCommit: "", files: [] },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---- Settings mutations ----

  describe("POST /api/settings/git-identity", () => {
    it("sets git identity", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/settings/git-identity",
        payload: { name: "Test User", email: "test@example.com" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.name).toBe("Test User");
      expect(body.email).toBe("test@example.com");
    });

    it("persists identity to global git config", async () => {
      await app.inject({
        method: "POST",
        url: "/api/settings/git-identity",
        payload: { name: "Global User", email: "global@example.com" },
      });
      expect(getGitIdentity()).toEqual({ name: "Global User", email: "global@example.com" });
    });

    it("returns 400 for empty name", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/settings/git-identity",
        payload: { name: "", email: "test@example.com" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for empty email", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/settings/git-identity",
        payload: { name: "Test", email: "" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for whitespace-only name", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/settings/git-identity",
        payload: { name: "   ", email: "test@example.com" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("PUT /api/settings", () => {
    it("saves system prompt", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { systemPrompt: "Be helpful" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.systemPrompt).toBe("Be helpful");
    });

    it("persists system prompt to disk", async () => {
      await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { systemPrompt: "Always use TypeScript." },
      });
      const filePath = path.join(tmpDir, ".shipit", "system-prompt.md");
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, "utf-8")).toBe("Always use TypeScript.\n");
    });

    it("round-trips system prompt (save then read)", async () => {
      await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { systemPrompt: "Use Tailwind CSS." },
      });
      const res = await app.inject({ method: "GET", url: "/api/bootstrap" });
      expect(res.json().settings.systemPrompt).toBe("Use Tailwind CSS.");
    });

    it("empty system prompt deletes the file", async () => {
      // Create a prompt first
      await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { systemPrompt: "Something" },
      });
      // Now clear it
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { systemPrompt: "" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().systemPrompt).toBe("");
      expect(fs.existsSync(path.join(tmpDir, ".shipit", "system-prompt.md"))).toBe(false);
    });

    it("trims whitespace from system prompt", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { systemPrompt: "  Use strict mode.  \n" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().systemPrompt).toBe("Use strict mode.");
    });

    it("saves git identity via settings", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { gitIdentity: { name: "New Name", email: "new@test.com" } },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.gitIdentity.name).toBe("New Name");
      expect(body.gitIdentity.email).toBe("new@test.com");
    });

    it("persists git identity to global git config via settings", async () => {
      await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { gitIdentity: { name: "Global User", email: "global@test.com" } },
      });
      expect(getGitIdentity()).toEqual({ name: "Global User", email: "global@test.com" });
    });

    it("returns 400 for empty git name in settings", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { gitIdentity: { name: "", email: "a@b.com" } },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for too-long system prompt", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { systemPrompt: "x".repeat(50_001) },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/settings/agent", () => {
    it("returns 400 for unknown agent", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/settings/agent",
        payload: { agentId: "nonexistent" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---- Auth mutations ----

  describe("POST /api/auth/api-key", () => {
    it("sets a valid API key", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/api-key",
        payload: { key: "sk-ant-test123" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it("returns 400 for invalid key format", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/api-key",
        payload: { key: "not-a-valid-key" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for empty key", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/api-key",
        payload: { key: "" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("DELETE /api/auth/api-key", () => {
    it("clears API key", async () => {
      // Set a key first
      await app.inject({
        method: "POST",
        url: "/api/auth/api-key",
        payload: { key: "sk-ant-test123" },
      });
      const res = await app.inject({
        method: "DELETE",
        url: "/api/auth/api-key",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  // ---- GitHub mutations ----

  describe("POST /api/github/token", () => {
    it("returns 400 for empty token", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/github/token",
        payload: { token: "" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("accepts valid token and returns status + repos", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/github/token",
        payload: { token: "ghp_valid_token" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status.authenticated).toBe(true);
      expect(body.repos.length).toBeGreaterThan(0);
    });
  });

  describe("POST /api/github/logout", () => {
    it("clears GitHub credentials", async () => {
      // Authenticate first, then logout
      await githubAuthManager.setToken("ghp_some_token");
      expect(githubAuthManager.authenticated).toBe(true);
      const res = await app.inject({
        method: "POST",
        url: "/api/github/logout",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status.authenticated).toBe(false);
    });
  });

  // ---- PR mutations ----

  describe("POST /api/sessions/:id/pr", () => {
    it("returns 401 when not authenticated", async () => {
      await createSession("s1", "Session 1");
      // githubAuthManager starts unauthenticated by default
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/pr",
        payload: { title: "My PR", body: "", base: "main" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 400 for empty title", async () => {
      await createSession("s1", "Session 1");
      await githubAuthManager.setToken("ghp_test");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/pr",
        payload: { title: "", body: "", base: "main" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/sessions/:id/pr/merge", () => {
    it("returns 401 when not authenticated", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/pr/merge",
        payload: { method: "squash" },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ---- Git remote mutations ----

  describe("POST /api/sessions/:id/git/remotes", () => {
    it("adds a remote and returns remotes list", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/git/remotes",
        payload: { name: "origin", url: "https://github.com/user/repo.git" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.remotes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "origin", url: "https://github.com/user/repo.git" }),
        ]),
      );
    });

    it("caches remoteUrl in session metadata when setting origin", async () => {
      await createSession("s1", "Session 1");
      await app.inject({
        method: "POST",
        url: "/api/sessions/s1/git/remotes",
        payload: { name: "origin", url: "https://github.com/cached/url.git" },
      });
      expect(sessionManager.get("s1")?.remoteUrl).toBe("https://github.com/cached/url.git");
    });

    it("returns 400 for empty remote name", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/git/remotes",
        payload: { name: "", url: "https://github.com/user/repo.git" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for empty url", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/git/remotes",
        payload: { name: "origin", url: "" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---- Git push/pull ----

  describe("POST /api/sessions/:id/git/push", () => {
    it("returns 401 when not authenticated", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/git/push",
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /api/sessions/:id/git/pull", () => {
    it("returns 401 when not authenticated", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/git/pull",
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ---- Deploy mutations ----

  describe("POST /api/sessions/:id/deploy/config", () => {
    it("returns 400 for unknown deploy target", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/deploy/config",
        payload: { targetId: "nonexistent", credentials: {} },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---- Thread mutations ----

  describe("POST /api/sessions/:id/threads/checkpoint", () => {
    it("creates a checkpoint on active thread", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/threads/checkpoint",
        payload: { label: "before refactor" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.checkpoint).toBeDefined();
      expect(body.threadId).toBeTruthy();
    });

    it("returns 400 for label over 200 characters", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/threads/checkpoint",
        payload: { label: "x".repeat(201) },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 for non-existent session", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/nonexistent/threads/checkpoint",
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ---- Preview error ----

  describe("POST /api/sessions/:id/preview-errors", () => {
    it("returns 400 for empty message", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/preview-errors",
        payload: { message: "" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("accepts valid error message", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/preview-errors",
        payload: { message: "TypeError: foo is not a function" },
      });
      expect(res.statusCode).toBe(204);
    });
  });

  // ---- Template mutations ----

  describe("POST /api/sessions/:id/template", () => {
    it("scaffolds files for react-vite-ts template", async () => {
      const dir = await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/template",
        payload: { templateId: "react-vite-ts" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.templateId).toBe("react-vite-ts");
      expect(body.name).toBe("React + Vite");
      // Verify files were written
      expect(fs.existsSync(path.join(dir, "package.json"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "src/App.tsx"))).toBe(true);
    });

    it("returns 400 for unknown template ID", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/template",
        payload: { templateId: "does-not-exist" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for empty template ID", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/template",
        payload: { templateId: "" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---- Full reset ----

  describe("POST /api/reset", () => {
    it("resets and returns success", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/reset",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it("deletes all persistent data from workspace", async () => {
      // Create some persistent state
      const sessionsDir = path.join(tmpDir, "sessions", "test-session");
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, "file.txt"), "hello");

      const shipitDir = path.join(tmpDir, ".shipit");
      fs.mkdirSync(shipitDir, { recursive: true });
      fs.writeFileSync(path.join(shipitDir, "system-prompt.md"), "Be concise.");

      const res = await app.inject({ method: "POST", url: "/api/reset" });
      expect(res.statusCode).toBe(200);

      // Verify workspace is empty
      const remaining = fs.readdirSync(tmpDir);
      expect(remaining).toEqual([]);
    });

    it("succeeds on already-clean workspace (idempotent)", async () => {
      const res = await app.inject({ method: "POST", url: "/api/reset" });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });
});

// ---- Separate describe for agent env tests (needs custom registry) ----

describe("Integration: Phase 2 HTTP agent mutations", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let savedOpenAIKey: string | undefined;

  beforeEach(async () => {
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-http-agents-"));
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test User", "test@test.com");

    const registry = new AgentRegistry({
      checkBinary: async (binary) => binary === "claude" || binary === "codex",
      checkClaudeAuth: () => true,
    });
    await registry.detect();

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(path.join(tmpDir, "sessions.json")),
      chatHistoryManager: new ChatHistoryManager(path.join(tmpDir, ".chat-history")),
      credentialStore: new CredentialStore(path.join(tmpDir, "credentials")),
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentRegistry: registry,
      credentialStore: new CredentialStore(tmpDir),
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startPreview: false,
      portScanIntervalMs: 0,
    });
  });

  afterEach(async () => {
    await app.close();
    await new Promise((r) => setTimeout(r, 50));
    if (savedOpenAIKey !== undefined) process.env.OPENAI_API_KEY = savedOpenAIKey;
    else delete process.env.OPENAI_API_KEY;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("POST /api/settings/agent", () => {
    it("accepts installed and auth-configured agent", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/settings/agent",
        payload: { agentId: "claude" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().agentId).toBe("claude");
    });
  });

  describe("POST /api/agents/:id/env", () => {
    it("sets env var and updates auth status", async () => {
      // Initially Codex auth is not configured
      const beforeRes = await app.inject({ method: "GET", url: "/api/bootstrap" });
      const codexBefore = beforeRes.json().agents.find((a: any) => a.id === "codex");
      expect(codexBefore.authConfigured).toBe(false);

      const res = await app.inject({
        method: "POST",
        url: "/api/agents/codex/env",
        payload: { key: "OPENAI_API_KEY", value: "sk-test-key-123" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().key).toBe("OPENAI_API_KEY");

      // Verify auth status updated
      const afterRes = await app.inject({ method: "GET", url: "/api/bootstrap" });
      const codexAfter = afterRes.json().agents.find((a: any) => a.id === "codex");
      expect(codexAfter.authConfigured).toBe(true);
    });

    it("returns 400 for disallowed env key", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/agents/codex/env",
        payload: { key: "PATH", value: "/usr/bin" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("not in the allowlist");
    });

    it("returns 400 for empty value", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/agents/codex/env",
        payload: { key: "OPENAI_API_KEY", value: "   " },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});

// ---- Separate describe for deploy config tests (needs deployment manager) ----

describe("Integration: Phase 2 HTTP deploy config mutations", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let stubDeployMgr: StubDeploymentManager;
  let stubDeployStore: StubDeploymentStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-http-deploy-"));
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test User", "test@test.com");

    sessionManager = new SessionManager(path.join(tmpDir, "sessions.json"));
    stubDeployMgr = new StubDeploymentManager();
    stubDeployMgr.register({
      info: {
        id: "test-target",
        name: "Test Deploy",
        description: "Test target",
        configFields: [{ key: "token", label: "Token", required: true, sensitive: true }],
        supportsPreview: true,
      },
    });
    stubDeployStore = new StubDeploymentStore();

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      deploymentManager: stubDeployMgr as unknown as DeploymentManager,
      deploymentStore: stubDeployStore as unknown as DeploymentStore,
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

  async function createSession(id: string, title: string): Promise<string> {
    const sessionDir = path.join(tmpDir, "sessions", id);
    fs.mkdirSync(sessionDir, { recursive: true });
    sessionManager.track(id, title, sessionDir);
    const git = new GitManager(sessionDir);
    await git.init();
    fs.writeFileSync(path.join(sessionDir, "init.txt"), "init");
    await git.autoCommit("initial commit");
    return sessionDir;
  }

  describe("POST /api/sessions/:id/deploy/config", () => {
    it("saves deploy config", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/deploy/config",
        payload: { targetId: "test-target", credentials: { token: "my-token" }, projectName: "test-proj" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().targetId).toBe("test-target");
    });

    it("returns 400 for empty required field", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/deploy/config",
        payload: { targetId: "test-target", credentials: { token: "" } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("Token is required");
    });
  });

  describe("DELETE /api/sessions/:id/deploy/config/:targetId", () => {
    it("deletes deploy config", async () => {
      await createSession("s1", "Session 1");
      // Save config first
      await app.inject({
        method: "POST",
        url: "/api/sessions/s1/deploy/config",
        payload: { targetId: "test-target", credentials: { token: "tok" } },
      });
      const res = await app.inject({
        method: "DELETE",
        url: "/api/sessions/s1/deploy/config/test-target",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().targetId).toBe("test-target");
    });
  });
});
