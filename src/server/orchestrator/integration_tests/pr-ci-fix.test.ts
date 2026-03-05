/**
 * Integration tests for CI fix flow (Phase 2):
 * - POST /api/sessions/:id/pr/fix-ci
 * - POST /api/sessions/:id/pr/auto-fix
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { PrStatusPoller } from "../pr-status-poller.js";
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
let prStatusPoller: PrStatusPoller;
let dbManager: DatabaseManager;
const sseBroadcast = vi.fn();

beforeEach(async () => {
  dbManager = createTestDatabaseManager();
  tmpDir = fs.mkdtempSync("/tmp/shipit-pr-ci-fix-test-");

  githubAuth = new StubGitHubAuthManager();

  // Create a session with a git repo + initial commit
  sessionId = crypto.randomUUID();
  sessionDir = path.join(tmpDir, "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const credentialStore = createTestCredentialStore(tmpDir);
  const git = new GitManager(sessionDir);
  await git.init();

  fs.writeFileSync(path.join(sessionDir, "README.md"), "# Test\n");
  execSync("git add README.md && git commit -m 'initial'", {
    cwd: sessionDir,
    env: { ...process.env, HOME: tmpDir },
  });

  // Set origin + feature branch
  await git.addRemote("origin", "https://github.com/test-user/test-repo.git");
  execSync("git checkout -b shipit/test-feature", {
    cwd: sessionDir,
    env: { ...process.env, HOME: tmpDir },
  });

  sessionManager = new SessionManager(dbManager);
  sessionManager.track(sessionId, "Test session", sessionDir);

  // Create poller with sseBroadcast spy
  prStatusPoller = new PrStatusPoller({
    githubAuth: githubAuth as any,
    sessionManager,
    sseBroadcast,
  });

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
    generateText: async () => "Fix applied",
    prStatusPoller,
  });
});

afterEach(async () => {
  dbManager.close();
  prStatusPoller.destroy();
  await app.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("POST /api/sessions/:id/pr/auto-fix", () => {
  it("returns 500 when body missing 'enabled' field", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/auto-fix`,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "\"enabled\" field is required (boolean)" });
  });

  it("toggles auto-fix on and returns state", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/auto-fix`,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ enabled: true }),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data).toMatchObject({
      enabled: true,
      attemptCount: 0,
      status: "idle",
    });
  });

  it("toggles auto-fix off", async () => {
    // Enable first
    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/auto-fix`,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ enabled: true }),
    });

    // Disable
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/auto-fix`,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ enabled: false }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: false });
  });
});

describe("POST /api/sessions/:id/pr/fix-ci", () => {
  it("returns 401 when not authenticated with GitHub", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/fix-ci`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "Not authenticated with GitHub" });
  });

  it("returns 404 when no PR status found for session", async () => {
    await githubAuth.setToken("test-token");

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/fix-ci`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("PrStatusPoller auto-fix state", () => {
  it("setAutoFixEnabled creates and returns state", () => {
    const state = prStatusPoller.setAutoFixEnabled(sessionId, true);
    expect(state).toMatchObject({ enabled: true, attemptCount: 0, status: "idle" });
  });

  it("getAutoFixState returns undefined when not set", () => {
    expect(prStatusPoller.getAutoFixState(sessionId)).toBeUndefined();
  });

  it("markAutoFixRunning increments attempt count", () => {
    prStatusPoller.setAutoFixEnabled(sessionId, true);
    prStatusPoller.markAutoFixRunning(sessionId);

    const state = prStatusPoller.getAutoFixState(sessionId);
    expect(state).toMatchObject({ attemptCount: 1, status: "running" });
  });

  it("untrackSession clears auto-fix state", () => {
    prStatusPoller.setAutoFixEnabled(sessionId, true);
    prStatusPoller.untrackSession(sessionId);

    expect(prStatusPoller.getAutoFixState(sessionId)).toBeUndefined();
  });
});
