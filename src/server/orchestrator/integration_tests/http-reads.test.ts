import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../auth.js";


import type { FastifyInstance } from "fastify";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import { GitHubAuthManager } from "../github-auth.js";
import { CredentialStore } from "../credential-store.js";

describe("Integration: Phase 1 GET endpoints", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let githubAuthManager: StubGitHubAuthManager;
  let credentialStore: CredentialStore;
  let chatHistoryManager: ChatHistoryManager;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-http-reads-"));

    sessionManager = new SessionManager(dbManager);
    githubAuthManager = new StubGitHubAuthManager();
    credentialStore = createTestCredentialStore(tmpDir);
    chatHistoryManager = new ChatHistoryManager(dbManager);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      credentialStore,
      chatHistoryManager,
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

  /** Helper: create a session with a git repo and some files. */
  async function createSession(id: string, title: string): Promise<string> {
    const sessionDir = path.join(tmpDir, "sessions", id);
    fs.mkdirSync(sessionDir, { recursive: true });
    sessionManager.track(id, title, sessionDir);

    // Initialize git repo
    const git = new GitManager(sessionDir);
    await git.init();
    return sessionDir;
  }

  // ---- File tree ----

  it("GET /api/sessions/:id/files returns file tree", async () => {
    const dir = await createSession("s1", "Session 1");
    fs.writeFileSync(path.join(dir, "hello.txt"), "world");

    const res = await app.inject({ method: "GET", url: "/api/sessions/s1/files" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("tree");
    expect(Array.isArray(body.tree)).toBe(true);
    const names = body.tree.map((n: any) => n.name);
    expect(names).toContain("hello.txt");
  });

  it("GET /api/sessions/:id/files returns 404 for missing session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/nonexistent/files" });
    expect(res.statusCode).toBe(404);
  });

  // ---- File content ----

  it("GET /api/sessions/:id/files/* returns file content", async () => {
    const dir = await createSession("s1", "Session 1");
    fs.writeFileSync(path.join(dir, "readme.md"), "# Hello");

    const res = await app.inject({ method: "GET", url: "/api/sessions/s1/files/readme.md" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe("readme.md");
    expect(body.content).toBe("# Hello");
    expect(body.isBinary).toBeFalsy();
  });

  it("GET /api/sessions/:id/files/* with ?tree=true includes file tree", async () => {
    const dir = await createSession("s1", "Session 1");
    fs.writeFileSync(path.join(dir, "a.txt"), "content");

    const res = await app.inject({ method: "GET", url: "/api/sessions/s1/files/a.txt?tree=true" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content).toBe("content");
    expect(body).toHaveProperty("tree");
    expect(Array.isArray(body.tree)).toBe(true);
  });

  it("GET /api/sessions/:id/files/* returns 404 for missing file", async () => {
    await createSession("s1", "Session 1");

    const res = await app.inject({ method: "GET", url: "/api/sessions/s1/files/nonexistent.txt" });
    expect(res.statusCode).toBe(404);
  });

  // ---- Docs ----

  it("GET /api/sessions/:id/docs returns doc list", async () => {
    const dir = await createSession("s1", "Session 1");
    fs.writeFileSync(path.join(dir, "notes.md"), "# Notes");

    const res = await app.inject({ method: "GET", url: "/api/sessions/s1/docs" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("docs");
    expect(Array.isArray(body.docs)).toBe(true);
  });

  it("GET /api/sessions/:id/docs/* returns doc content", async () => {
    const dir = await createSession("s1", "Session 1");
    fs.writeFileSync(path.join(dir, "notes.md"), "# Notes\n\nSome content.");

    const res = await app.inject({ method: "GET", url: "/api/sessions/s1/docs/notes.md" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe("notes.md");
    expect(body.content).toContain("# Notes");
  });

  // ---- Git log ----

  it("GET /api/sessions/:id/git/log returns commits", async () => {
    const dir = await createSession("s1", "Session 1");
    const git = new GitManager(dir);
    fs.writeFileSync(path.join(dir, "file.txt"), "data");
    await git.autoCommit("Initial commit");

    const res = await app.inject({ method: "GET", url: "/api/sessions/s1/git/log" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("commits");
    expect(body.commits.length).toBeGreaterThan(0);
    expect(body.commits[0]).toHaveProperty("hash");
    expect(body.commits[0]).toHaveProperty("message");
  });

  // ---- Git remotes ----

  it("GET /api/sessions/:id/git/remotes returns remotes", async () => {
    await createSession("s1", "Session 1");

    const res = await app.inject({ method: "GET", url: "/api/sessions/s1/git/remotes" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("remotes");
    expect(Array.isArray(body.remotes)).toBe(true);
  });

  // ---- Git branches ----

  it("GET /api/sessions/:id/git/branches returns current branch", async () => {
    const dir = await createSession("s1", "Session 1");
    const git = new GitManager(dir);
    fs.writeFileSync(path.join(dir, "file.txt"), "data");
    await git.autoCommit("Initial commit");

    const res = await app.inject({ method: "GET", url: "/api/sessions/s1/git/branches" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("current");
    expect(body).toHaveProperty("remote");
    expect(typeof body.current).toBe("string");
    expect(Array.isArray(body.remote)).toBe(true);
  });

  // ---- Git diff ----

  it("GET /api/sessions/:id/git/diff returns diff between commits", async () => {
    const dir = await createSession("s1", "Session 1");
    const git = new GitManager(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "hello");
    const hash1 = await git.autoCommit("First");
    fs.writeFileSync(path.join(dir, "b.txt"), "world");
    const hash2 = await git.autoCommit("Second");

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/s1/git/diff?from=${hash1}&to=${hash2}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fromCommit).toBe(hash1);
    expect(body.toCommit).toBe(hash2);
    expect(body).toHaveProperty("files");
    expect(body).toHaveProperty("stats");
    expect(body.files.length).toBeGreaterThan(0);
  });

  it("GET /api/sessions/:id/git/diff returns 400 without query params", async () => {
    await createSession("s1", "Session 1");

    const res = await app.inject({ method: "GET", url: "/api/sessions/s1/git/diff" });
    expect(res.statusCode).toBe(400);
  });

  // ---- Session status ----

  it("GET /api/sessions/:id/status returns runtime status", async () => {
    await createSession("s1", "Session 1");

    const res = await app.inject({ method: "GET", url: "/api/sessions/s1/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      sessionId: "s1",
      running: false,
      queueLength: 0,
    });
  });

  // ---- Usage stats ----

  it("GET /api/sessions/:id/usage returns usage stats", async () => {
    await createSession("s1", "Session 1");

    const res = await app.inject({ method: "GET", url: "/api/sessions/s1/usage" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("stats");
  });

  // ---- PR status ----

  it("GET /api/sessions/:id/pr/status returns null when not authenticated", async () => {
    await createSession("s1", "Session 1");

    const res = await app.inject({ method: "GET", url: "/api/sessions/s1/pr/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("pr");
    expect(body.pr).toBeNull();
  });

  // ---- Sibling sessions ----

  it("GET /api/sessions/:id/worktrees returns sibling session list", async () => {
    await createSession("s1", "Session 1");

    const res = await app.inject({ method: "GET", url: "/api/sessions/s1/worktrees" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("worktrees");
    expect(Array.isArray(body.worktrees)).toBe(true);
  });

  // ---- Docs with status ----

  it("GET /api/sessions/:id/docs includes status from frontmatter", async () => {
    const dir = await createSession("s-feat2", "Doc Session");
    const featureDir = path.join(dir, "docs", "001-test-feature");
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(path.join(featureDir, "plan.md"), "---\nstatus: in-progress\n---\n# Test Feature");

    const res = await app.inject({ method: "GET", url: "/api/sessions/s-feat2/docs" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const tracked = body.docs.find((d: any) => d.status !== undefined);
    expect(tracked).toBeDefined();
    expect(tracked.path).toBe("docs/001-test-feature/plan.md");
    expect(tracked.status).toBe("in-progress");
  });

  // ---- GitHub repos search ----

  it("GET /api/github/repos returns empty array for short query", async () => {
    const res = await app.inject({ method: "GET", url: "/api/github/repos?q=a" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("repos");
    expect(body.repos).toEqual([]);
  });

  it("GET /api/github/repos returns repos when authenticated", async () => {
    await githubAuthManager.setToken("ghp_testtoken");

    const res = await app.inject({ method: "GET", url: "/api/github/repos?q=test" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("repos");
    expect(body.repos.length).toBeGreaterThan(0);
  });

  // ---- Workspace state (combined git log + file tree) ----

  it("GET /api/sessions/:id/workspace-state returns gitLog and fileTree", async () => {
    const dir = await createSession("s1", "Session 1");
    const git = new GitManager(dir);
    fs.writeFileSync(path.join(dir, "file.txt"), "data");
    await git.autoCommit("Initial commit");

    const res = await app.inject({ method: "GET", url: "/api/sessions/s1/workspace-state" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("gitLog");
    expect(body).toHaveProperty("fileTree");
    expect(Array.isArray(body.gitLog)).toBe(true);
    expect(body.gitLog.length).toBeGreaterThan(0);
    expect(Array.isArray(body.fileTree)).toBe(true);
    const names = body.fileTree.map((n: any) => n.name);
    expect(names).toContain("file.txt");
  });

  it("GET /api/sessions/:id/workspace-state returns 404 for missing session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/nonexistent/workspace-state" });
    expect(res.statusCode).toBe(404);
  });

  // ---- Chat history (read-only) ----

  it("GET /api/sessions/:id/history returns empty messages for new session", async () => {
    await createSession("s1", "Session 1");

    const res = await app.inject({ method: "GET", url: "/api/sessions/s1/history" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("messages");
    expect(body.messages).toEqual([]);
  });

  it("GET /api/sessions/:id/history returns persisted messages", async () => {
    await createSession("s1", "Session 1");
    chatHistoryManager.append("s1", { role: "user", text: "Hello" });
    chatHistoryManager.append("s1", { role: "assistant", text: "Hi there!" });

    const res = await app.inject({ method: "GET", url: "/api/sessions/s1/history" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toMatchObject({ role: "user", text: "Hello" });
    expect(body.messages[1]).toMatchObject({ role: "assistant", text: "Hi there!" });
  });

  it("GET /api/sessions/:id/history returns 404 for missing session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/nonexistent/history" });
    expect(res.statusCode).toBe(404);
  });
});
