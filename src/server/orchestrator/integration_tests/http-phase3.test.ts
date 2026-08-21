import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";


import type { FastifyInstance } from "fastify";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestDatabaseManager,
  createTemplateRepoGitFactories,
  pinGitToLocalTransports,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
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
  let dbManager: DatabaseManager;
  let restoreGitTransports: () => void;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-http-phase3-"));
    generateTextResult = "## Summary\nTest PR description";

    // `POST /api/repos` warms a session, and the warm pool fetches the
    // workspace clone's origin for real against the fake github.com URL.
    restoreGitTransports = pinGitToLocalTransports();

    sessionManager = new SessionManager(dbManager);
    githubAuthManager = new StubGitHubAuthManager();
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test User", "test@test.com");
    credentialStore = new CredentialStore(tmpDir);
    chatHistoryManager = new ChatHistoryManager(dbManager);
    stubAuthManager = new StubAuthManager();

    const { createGitManager, createRepoGit } = createTemplateRepoGitFactories();
    app = await buildApp({
      createGitManager,
      createRepoGit,
      sessionManager,
      authManager: stubAuthManager as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      credentialStore,
      chatHistoryManager,
      workspaceDir: tmpDir,
      serveStatic: false,
      generateText: async () => generateTextResult,
    });
  });

  afterEach(async () => {
    restoreGitTransports();
    await app.close();
    dbManager.close();
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

  describe("GET /api/sessions/:id/history", () => {
    it("returns messages and commits, but not the file tree", async () => {
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
      // planning#375 — the workspace file tree was 325 KB of this payload on a
      // real repo and changes on a different cadence from the transcript, so it
      // moved to `GET /api/sessions/:id/files`.
      expect(body.fileTree).toBeUndefined();
      const filesRes = await app.inject({ method: "GET", url: "/api/sessions/s1/files" });
      expect(filesRes.json().tree.length).toBeGreaterThan(0);
    });

    /**
     * planning#375 — a session switch used to re-download the whole
     * conversation (2.67 MB on the traced session). The response now carries an
     * ETag so the client can revalidate.
     */
    it("answers 304 when the client already holds the current transcript", async () => {
      await createSession("etag-s", "ETag session");
      chatHistoryManager.append("etag-s", { role: "user", text: "Hello" });

      const first = await app.inject({ method: "GET", url: "/api/sessions/etag-s/history" });
      expect(first.statusCode).toBe(200);
      const etag = first.headers.etag!;
      expect(etag).toBeTruthy();
      // Never served blind from the browser cache — a stale transcript is worse
      // than a round trip.
      expect(first.headers["cache-control"]).toBe("no-cache");

      const revalidated = await app.inject({
        method: "GET",
        url: "/api/sessions/etag-s/history",
        headers: { "if-none-match": etag },
      });
      expect(revalidated.statusCode).toBe(304);
      expect(revalidated.body).toBe("");

      // The form that actually arrives in production. Cloudflare re-compresses
      // (zstd) and hands the browser `W/"…"`, which is what the browser echoes
      // back — so an exact-match comparison meant the 304 never once fired
      // through the CDN, and every attach re-downloaded the transcript.
      const viaCdn = await app.inject({
        method: "GET",
        url: "/api/sessions/etag-s/history",
        headers: { "if-none-match": `W/${etag}` },
      });
      expect(viaCdn.statusCode).toBe(304);
    });

    it("issues a fresh tag once the transcript changes", async () => {
      await createSession("etag-s2", "ETag session 2");
      chatHistoryManager.append("etag-s2", { role: "user", text: "One" });
      const first = await app.inject({ method: "GET", url: "/api/sessions/etag-s2/history" });
      const etag = first.headers.etag!;

      chatHistoryManager.append("etag-s2", { role: "assistant", text: "Two" });
      const second = await app.inject({
        method: "GET",
        url: "/api/sessions/etag-s2/history",
        headers: { "if-none-match": etag },
      });
      expect(second.statusCode).toBe(200);
      expect(second.headers.etag).not.toBe(etag);
      expect(second.json().messages).toHaveLength(2);
    });

    /** planning#375 — the tree left `/history`, so it needs its own validator. */
    it("answers 304 for an unchanged file tree", async () => {
      await createSession("tree-s", "Tree session");
      const first = await app.inject({ method: "GET", url: "/api/sessions/tree-s/files" });
      expect(first.statusCode).toBe(200);
      const etag = first.headers.etag!;
      expect(etag).toBeTruthy();

      const again = await app.inject({
        method: "GET",
        url: "/api/sessions/tree-s/files",
        headers: { "if-none-match": etag },
      });
      expect(again.statusCode).toBe(304);

      const viaCdn = await app.inject({
        method: "GET",
        url: "/api/sessions/tree-s/files",
        headers: { "if-none-match": `W/${etag}` },
      });
      expect(viaCdn.statusCode).toBe(304);
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
    it("forks a session into a new branch", async () => {
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
    it("merges a session branch", async () => {
      await createSession("s1", "Session 1");

      // Fork first to create a session with a branch
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
    // The only test in this file that drives the whole template-creation path,
    // and the only one that needs a raised timeout. Network is out of the
    // picture — `push` and `fetchCache` are stubbed in `beforeEach` (5809d53d)
    // and `GIT_ALLOW_PROTOCOL=file` in `server-test-setup.ts` fails the origin
    // fetch this path also makes, instantly. What remains is ~8 real git
    // subprocesses (init, addRemote, autoCommit, cloneBare, setRemoteUrl) plus
    // scaffolding and a session clone: ~700ms on an idle box, against a 5s
    // default, on a CI runner sharing cores with 600+ other test files that
    // also shell out to git. A raised limit is the fix rather than a mask —
    // the work is genuinely serial process spawns, and a real hang still fails.
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
    }, 20000);

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

  // ---- Retired singleton subscription sign-in (docs/150-multiple-provider-subscriptions reqs 16, 19) ----
  //
  // These were the "connect your first account" endpoints. They took no
  // account id, so whatever they authenticated could not afterwards be
  // renamed, reordered, or failed over — a second way for provider auth to
  // work, which req 19 says must not survive the migration. The account-scoped
  // replacements are covered in http-mutations.test.ts.
  describe("singleton subscription auth endpoints are gone", () => {
    it.each([
      ["POST", "/api/auth/start"],
      ["POST", "/api/auth/code"],
      ["POST", "/api/codex-auth/start"],
      ["POST", "/api/codex-auth/cancel"],
    ])("%s %s is not registered", async (method, url) => {
      const res = await app.inject({ method: method as "POST", url, payload: {} });
      expect(res.statusCode).toBe(404);
    });
  });
});
