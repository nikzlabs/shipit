import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { RepoGit } from "../repo-git.js";
import { SessionManager } from "../sessions.js";
import type { AuthManager } from "../auth.js";
import type { GitHubAuthManager } from "../github-auth.js";

import type { FastifyInstance } from "fastify";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

// ---------------------------------------------------------------------------
// home_create_repo_with_template
// ---------------------------------------------------------------------------

describe("Integration: home_create_repo_with_template (HTTP)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-home-create-"));

    const sessionManager = new SessionManager(dbManager);

    const githubAuthManager = new StubGitHubAuthManager();

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => {
        const gm = new GitManager(dir);
        // Stub push so it doesn't attempt a real remote push
        gm.push = async () => "pushed (stub)";
        return gm;
      },
      createRepoGit: (dir: string) => {
        const rg = new RepoGit(dir);
        // Stub fetchCache to avoid network calls to fake GitHub URLs
        rg.fetchCache = async () => {};
        return rg;
      },
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
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

  it("creates a GitHub repo, applies template, and returns success", async () => {
    // Authenticate with GitHub first via HTTP
    await app.inject({ method: "POST", url: "/api/github/token", payload: { token: "ghp_test" } });

    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: {
        repoName: "my-new-app",
        templateId: "static-html",
        description: "Test project",
        isPrivate: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.repoUrl).toBe("https://github.com/test-user/my-new-app.git");
    expect(body.sessionId).toBeTruthy();
  });

  it("returns 400 for empty repoName", async () => {
    await app.inject({ method: "POST", url: "/api/github/token", payload: { token: "ghp_test" } });

    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: { repoName: "", templateId: "static-html" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for empty templateId", async () => {
    await app.inject({ method: "POST", url: "/api/github/token", payload: { token: "ghp_test" } });

    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: { repoName: "my-app", templateId: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns error for unknown templateId", async () => {
    await app.inject({ method: "POST", url: "/api/github/token", payload: { token: "ghp_test" } });

    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: { repoName: "my-app", templateId: "nonexistent-template-xyz" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("returns 400 for invalid repoName characters", async () => {
    await app.inject({ method: "POST", url: "/api/github/token", payload: { token: "ghp_test" } });

    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: { repoName: "my app!", templateId: "static-html" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 401 when not authenticated with GitHub", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: { repoName: "my-app", templateId: "static-html" },
    });
    expect(res.statusCode).toBe(401);
  });
});

// home_send_with_repo handler was removed — replaced by claim-session + send_message flow.
// See warm-sessions.test.ts for the equivalent lifecycle tests.
