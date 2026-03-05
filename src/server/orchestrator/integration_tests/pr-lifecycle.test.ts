/**
 * Integration tests for the PR lifecycle flow:
 * - POST /api/sessions/:id/pr/quick (one-click PR creation)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  StubDeploymentManager,
  StubDeploymentStore,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { UsageManager } from "../usage.js";
import { FeatureManager } from "../features.js";
import type { FastifyInstance } from "fastify";

let tmpDir: string;
let app: FastifyInstance;
let githubAuth: StubGitHubAuthManager;
let sessionId: string;
let sessionDir: string;
let sessionManager: SessionManager;
let dbManager: DatabaseManager;

beforeEach(async () => {
  dbManager = createTestDatabaseManager();
  tmpDir = fs.mkdtempSync("/tmp/shipit-pr-lifecycle-test-");

  githubAuth = new StubGitHubAuthManager();

  // Create a session with a git repo + initial commit
  sessionId = crypto.randomUUID();
  sessionDir = path.join(tmpDir, "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const credentialStore = createTestCredentialStore(tmpDir);
  const git = new GitManager(sessionDir);
  await git.init();

  // Create an initial commit so the repo has a branch
  fs.writeFileSync(path.join(sessionDir, "README.md"), "# Test\n");
  execSync("git add README.md && git commit -m 'initial'", {
    cwd: sessionDir,
    env: { ...process.env, HOME: tmpDir },
  });

  sessionManager = new SessionManager(dbManager);
  sessionManager.track(sessionId, "Test session", sessionDir);

  app = await buildApp({
    credentialStore,
    workspaceDir: tmpDir,
    createGitManager: (dir: string) => new GitManager(dir),
    agentFactory: () => new FakeClaudeProcess() as any,
    authManager: new StubAuthManager() as any,
    githubAuthManager: githubAuth as any,
    sessionManager,
    chatHistoryManager: new ChatHistoryManager(dbManager),
    usageManager: new UsageManager(dbManager),
    serveStatic: false,
    deploymentManager: new StubDeploymentManager() as any,
    deploymentStore: new StubDeploymentStore() as any,
    featureManager: new FeatureManager(tmpDir),
    generateText: async () => "## Summary\nTest changes.\n\n## Changes\n- Added feature",
  });
});

afterEach(async () => {
  await app.close();
  dbManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /api/sessions/:id/pr/quick", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/quick`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "Not authenticated with GitHub" });
  });

  it("returns 404 for non-existent session", async () => {
    await githubAuth.setToken("test-token");
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${crypto.randomUUID()}/pr/quick`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when no origin remote is configured", async () => {
    await githubAuth.setToken("test-token");
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/quick`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "No 'origin' remote configured" });
  });

  it("returns existing PR when one already exists", async () => {
    await githubAuth.setToken("test-token");

    const git = new GitManager(sessionDir);
    await git.addRemote("origin", "https://github.com/test-user/test-repo.git");

    githubAuth.setPrData({
      url: "https://github.com/test-user/test-repo/pull/42",
      number: 42,
      base: "main",
      title: "Existing PR",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/quick`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      number: 42,
      url: "https://github.com/test-user/test-repo/pull/42",
      title: "Existing PR",
    });
  });

  it("creates a new PR when none exists", async () => {
    await githubAuth.setToken("test-token");

    // Set origin to a GitHub URL and create a feature branch
    const git = new GitManager(sessionDir);
    await git.addRemote("origin", "https://github.com/test-user/test-repo.git");

    execSync("git checkout -b shipit/test-feature", {
      cwd: sessionDir,
      env: { ...process.env, HOME: tmpDir },
    });
    fs.writeFileSync(path.join(sessionDir, "feature.ts"), "export const x = 1;\n");
    execSync("git add feature.ts && git commit -m 'add feature'", {
      cwd: sessionDir,
      env: { ...process.env, HOME: tmpDir },
    });

    // No existing PR
    githubAuth.setPrData(null);

    // Rebuild app with a createGitManager that stubs push and listRemoteBranches
    await app.close();
    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      workspaceDir: tmpDir,
      createGitManager: (dir: string) => {
        const realGit = new GitManager(dir);
        return new Proxy(realGit, {
          get(target, prop) {
            if (prop === "push") return async () => {};
            if (prop === "listRemoteBranches") return async () => ["main"];
            return (target as never)[prop as never];
          },
        });
      },
      agentFactory: () => new FakeClaudeProcess() as any,
      authManager: new StubAuthManager() as any,
      githubAuthManager: githubAuth as any,
      sessionManager,
      chatHistoryManager: new ChatHistoryManager(dbManager),
      usageManager: new UsageManager(dbManager),
      serveStatic: false,
      deploymentManager: new StubDeploymentManager() as any,
      deploymentStore: new StubDeploymentStore() as any,
      featureManager: new FeatureManager(tmpDir),
      generateText: async () => "## Summary\nTest changes.\n\n## Changes\n- Added feature",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/quick`,
    });
    expect(res.statusCode).toBe(200);

    const data = res.json();
    expect(data).toMatchObject({
      number: 1,
      title: "Test session",
      baseBranch: "main",
      headBranch: "shipit/test-feature",
    });
    expect(data.url).toContain("github.com");
  });
});
