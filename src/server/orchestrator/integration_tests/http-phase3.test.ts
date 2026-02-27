import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../auth.js";

import { ClaudeProcess } from "../../session/claude.js";

import type { FastifyInstance } from "fastify";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
} from "./test-helpers.js";
import { GitHubAuthManager } from "../github-auth.js";
import { CredentialStore } from "../credential-store.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";

describe("Integration: Phase 3 HTTP endpoints", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let githubAuthManager: StubGitHubAuthManager;
  let credentialStore: CredentialStore;
  let chatHistoryManager: ChatHistoryManager;
  let stubAuthManager: StubAuthManager;
  let generateTextResult: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-http-phase3-"));
    generateTextResult = "## Summary\nTest PR description";

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);
    githubAuthManager = new StubGitHubAuthManager();
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test User", "test@test.com");
    credentialStore = new CredentialStore(tmpDir);
    chatHistoryManager = new ChatHistoryManager(path.join(tmpDir, ".chat-history"));
    stubAuthManager = new StubAuthManager();

    app = await buildApp({
      createGitManager: (dir: string) => {
        const gm = new GitManager(dir);
        // Stub push so it doesn't attempt a real remote push
        gm.push = async () => "pushed (stub)";
        return gm;
      },
      sessionManager,
      authManager: stubAuthManager as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
      credentialStore,
      chatHistoryManager,
      workspaceDir: tmpDir,
      serveStatic: false,
      generateText: async () => generateTextResult,
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

  /** Helper: create a session with a git repo and initial commit. */
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

  // ---- GET /api/sessions/:id/history (enhanced with threads) ----

  describe("GET /api/sessions/:id/history", () => {
    it("returns messages, commits, fileTree, and threads", async () => {
      const dir = await createSession("s1", "Session 1");
      // Add some chat history
      chatHistoryManager.append("s1", {
        role: "user",
        text: "Hello",
      });
      chatHistoryManager.append("s1", {
        role: "assistant",
        text: "Hi there!",
      });
      // Add a file so file tree is non-empty
      fs.writeFileSync(path.join(dir, "hello.txt"), "world");

      const res = await app.inject({ method: "GET", url: "/api/sessions/s1/history" });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.messages).toHaveLength(2);
      expect(body.messages[0]).toMatchObject({ role: "user", text: "Hello" });
      expect(body.commits.length).toBeGreaterThanOrEqual(1);
      expect(body.commits.some((c: any) => c.message === "initial commit")).toBe(true);
      expect(body.fileTree.length).toBeGreaterThan(0);
      expect(body.threads).toBeDefined();
      expect(body.activeThreadId).toBeDefined();
    });

    it("returns 404 for non-existent session", async () => {
      const res = await app.inject({ method: "GET", url: "/api/sessions/nonexistent/history" });
      expect(res.statusCode).toBe(404);
    });
  });

  // ---- POST /api/sessions/:id/pr/description ----

  describe("POST /api/sessions/:id/pr/description", () => {
    it("generates a PR description", async () => {
      await createSession("s1", "Session 1");

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/pr/description",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.description).toBe("## Summary\nTest PR description");
    });

    it("returns 404 for non-existent session", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/nonexistent/pr/description",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ---- POST /api/sessions/:id/fork ----

  describe("POST /api/sessions/:id/fork", () => {
    it("forks a session into a new worktree branch", async () => {
      await createSession("s1", "Session 1");

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/fork",
        payload: { branchName: "feature-1" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.session).toBeDefined();
      expect(body.session.title).toContain("feature-1");
      expect(body.parentSessionId).toBe("s1");
      expect(body.sessions).toBeDefined();
      expect(body.sessions.length).toBeGreaterThanOrEqual(2);
    });

    it("returns 400 for empty branch name", async () => {
      await createSession("s1", "Session 1");

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/fork",
        payload: { branchName: "  " },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for invalid branch name", async () => {
      await createSession("s1", "Session 1");

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/fork",
        payload: { branchName: "has spaces" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 for non-existent session", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/nonexistent/fork",
        payload: { branchName: "feature-1" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ---- POST /api/sessions/:id/git/merge ----

  describe("POST /api/sessions/:id/git/merge", () => {
    it("merges a worktree branch", async () => {
      await createSession("s1", "Session 1");

      // Fork first to create a worktree session with a branch
      const forkRes = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/fork",
        payload: { branchName: "to-merge" },
      });
      const childId = forkRes.json().session.id;
      const childSession = sessionManager.get(childId);

      // Make a commit on the child branch
      if (childSession?.workspaceDir) {
        fs.writeFileSync(path.join(childSession.workspaceDir, "new-file.txt"), "from fork");
        const childGit = new GitManager(childSession.workspaceDir);
        await childGit.autoCommit("commit on fork");
      }

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/git/merge",
        payload: { sourceSessionId: childId },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.message).toContain("to-merge");
    });

    it("returns 400 for empty source session ID", async () => {
      await createSession("s1", "Session 1");

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/git/merge",
        payload: { sourceSessionId: "  " },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 for non-existent source session", async () => {
      await createSession("s1", "Session 1");

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/git/merge",
        payload: { sourceSessionId: "nonexistent" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ---- POST /api/repos ----

  describe("POST /api/repos", () => {
    it("creates a repo with template when authenticated", async () => {
      // Authenticate with GitHub first via HTTP
      await app.inject({ method: "POST", url: "/api/github/token", payload: { token: "ghp_test" } });

      const res = await app.inject({
        method: "POST",
        url: "/api/repos",
        payload: {
          repoName: "my-repo",
          templateId: "static-html",
          description: "Test repo",
          isPrivate: false,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.repoUrl).toBeDefined();
      expect(body.sessionId).toBeDefined();
    });

    it("returns 400 for empty repo name", async () => {
      await app.inject({ method: "POST", url: "/api/github/token", payload: { token: "ghp_test" } });
      const res = await app.inject({
        method: "POST",
        url: "/api/repos",
        payload: { repoName: "  ", templateId: "static-html" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for invalid repo name characters", async () => {
      await app.inject({ method: "POST", url: "/api/github/token", payload: { token: "ghp_test" } });
      const res = await app.inject({
        method: "POST",
        url: "/api/repos",
        payload: { repoName: "has spaces!", templateId: "static-html" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for empty template ID", async () => {
      await app.inject({ method: "POST", url: "/api/github/token", payload: { token: "ghp_test" } });
      const res = await app.inject({
        method: "POST",
        url: "/api/repos",
        payload: { repoName: "my-repo", templateId: "  " },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 401 when not authenticated with GitHub", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/repos",
        payload: { repoName: "my-repo", templateId: "static-html" },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ---- POST /api/auth/start ----

  describe("POST /api/auth/start", () => {
    it("returns 202 and starts OAuth flow", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/start",
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ success: true });
    });
  });

  // ---- POST /api/auth/code ----

  describe("POST /api/auth/code", () => {
    it("submits auth code successfully", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/code",
        payload: { code: "test-auth-code-123" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ success: true });
    });

    it("returns 400 for empty code", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/code",
        payload: { code: "  " },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
