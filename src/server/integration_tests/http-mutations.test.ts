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
} from "./test-helpers.js";
import { GitHubAuthManager } from "../github-auth.js";
import { CredentialStore } from "../credential-store.js";

describe("Integration: Phase 2 HTTP mutation endpoints", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let githubAuthManager: StubGitHubAuthManager;
  let credentialStore: CredentialStore;
  let chatHistoryManager: ChatHistoryManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-http-mutations-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);
    githubAuthManager = new StubGitHubAuthManager();
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
  });
});
