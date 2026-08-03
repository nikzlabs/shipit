import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import type { GitHubAuthManager } from "../github-auth.js";

import type { FastifyInstance } from "fastify";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
  createTemplateRepoGitFactories,
  pinGitToLocalTransports,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

// ---------------------------------------------------------------------------
// home_create_repo_with_template
// ---------------------------------------------------------------------------

describe("Integration: home_create_repo_with_template (HTTP)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let githubAuthManager: StubGitHubAuthManager;
  let restoreGitTransports: () => void;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-home-create-"));

    // `POST /api/repos` warms a session, and the warm pool fetches the
    // workspace clone's origin for real against the fake github.com URL.
    restoreGitTransports = pinGitToLocalTransports();

    const sessionManager = new SessionManager(dbManager);

    githubAuthManager = new StubGitHubAuthManager();

    const { createGitManager, createRepoGit } = createTemplateRepoGitFactories();
    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager,
      createRepoGit,
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      workspaceDir: tmpDir,
      serveStatic: false,
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

    // docs/178 — a ShipIt-scaffolded repo has no attacker-authored config, so
    // it is trusted by construction and never shows the trust gate.
    const list = await app.inject({ method: "GET", url: "/api/repos" });
    const created = (list.json().repos as { url: string; trusted?: boolean }[])
      .find((r) => r.url === body.repoUrl);
    expect(created?.trusted).toBe(true);
  });

  it("creates the repo under an organization when owner is supplied", async () => {
    await app.inject({ method: "POST", url: "/api/github/token", payload: { token: "ghp_test" } });

    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: {
        repoName: "team-app",
        templateId: "static-html",
        isPrivate: true,
        owner: "acme",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    // The clone URL is namespaced under the org, not the personal account.
    expect(body.repoUrl).toBe("https://github.com/acme/team-app.git");
    // And the org login was threaded all the way to createRepo's options.
    expect(githubAuthManager.createRepoCalls).toHaveLength(1);
    expect(githubAuthManager.createRepoCalls[0].options.owner).toBe("acme");
  });

  it("omits owner from createRepo when none is supplied (personal account)", async () => {
    await app.inject({ method: "POST", url: "/api/github/token", payload: { token: "ghp_test" } });

    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: { repoName: "solo-app", templateId: "static-html" },
    });
    expect(res.statusCode).toBe(200);
    expect(githubAuthManager.createRepoCalls[0].options.owner).toBeUndefined();
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
