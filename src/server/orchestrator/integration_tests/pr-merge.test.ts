/**
 * Integration tests for merge + auto-merge flow (Phase 3):
 * - POST /api/sessions/:id/pr/auto-merge
 * - POST /api/sessions/:id/pr/merge-method
 * - PrStatusPoller auto-merge state management
 * - Post-merge archive via onMergeDetected callback
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
} from "./test-helpers.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { UsageManager } from "../usage.js";
import { ThreadManager } from "../threads.js";
import { FeatureManager } from "../features.js";
import type { FastifyInstance } from "fastify";

let tmpDir: string;
let app: FastifyInstance;
let githubAuth: StubGitHubAuthManager;
let sessionId: string;
let sessionDir: string;
let sessionManager: SessionManager;
let prStatusPoller: PrStatusPoller;
const sseBroadcast = vi.fn();

beforeEach(async () => {
  tmpDir = fs.mkdtempSync("/tmp/shipit-pr-merge-test-");

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

  sessionManager = new SessionManager(path.join(tmpDir, "sessions.json"));
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
    chatHistoryManager: new ChatHistoryManager(path.join(tmpDir, "chat")),
    usageManager: new UsageManager(path.join(tmpDir, "usage.json")),
    threadManager: new ThreadManager(path.join(tmpDir, "threads")),
    serveStatic: false,
    deploymentManager: new StubDeploymentManager() as any,
    deploymentStore: new StubDeploymentStore() as any,
    featureManager: new FeatureManager(tmpDir),
    generateText: async () => "Test",
    prStatusPoller,
  });
});

afterEach(async () => {
  prStatusPoller.destroy();
  await app.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---- POST /api/sessions/:id/pr/auto-merge ----

describe("POST /api/sessions/:id/pr/auto-merge", () => {
  it("returns 400 when body missing 'enabled' field", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/auto-merge`,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "\"enabled\" field is required (boolean)" });
  });

  it("returns 401 when not authenticated", async () => {
    // Seed poller with a fake PR status so the service proceeds past the 404 check
    prStatusPoller.trackSession(sessionId, "https://github.com/test-user/test-repo.git");

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/auto-merge`,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ enabled: true }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 when no PR status found", async () => {
    await githubAuth.setToken("test-token");

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/auto-merge`,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ enabled: true }),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---- POST /api/sessions/:id/pr/merge-method ----

describe("POST /api/sessions/:id/pr/merge-method", () => {
  it("returns 400 for invalid method", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/merge-method`,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ method: "invalid" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "\"method\" must be \"squash\", \"merge\", or \"rebase\"" });
  });

  it("returns 400 when method is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/merge-method`,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---- PrStatusPoller auto-merge state ----

describe("PrStatusPoller auto-merge state", () => {
  it("getAutoMergeState returns undefined when not set", () => {
    expect(prStatusPoller.getAutoMergeState(sessionId)).toBeUndefined();
  });

  it("setAutoMergeEnabled creates and returns state", () => {
    const state = prStatusPoller.setAutoMergeEnabled(sessionId, true);
    expect(state).toMatchObject({ enabled: true, mergeMethod: "squash" });
  });

  it("setAutoMergeEnabled preserves existing mergeMethod", () => {
    prStatusPoller.setMergeMethod(sessionId, "rebase");
    const state = prStatusPoller.setAutoMergeEnabled(sessionId, true);
    expect(state).toMatchObject({ enabled: true, mergeMethod: "rebase" });
  });

  it("setAutoMergeEnabled clears error when re-enabling", () => {
    prStatusPoller.setAutoMergeEnabled(sessionId, false);
    prStatusPoller.setAutoMergeError(sessionId, {
      code: "auto_merge_not_enabled",
      message: "test",
      settingsUrl: "https://example.com",
    });

    const state = prStatusPoller.setAutoMergeEnabled(sessionId, true);
    expect(state.error).toBeUndefined();
  });

  it("setMergeMethod updates method", () => {
    prStatusPoller.setMergeMethod(sessionId, "merge");
    const state = prStatusPoller.getAutoMergeState(sessionId);
    expect(state).toMatchObject({ mergeMethod: "merge" });
  });

  it("setMergeMethod creates state when none exists", () => {
    prStatusPoller.setMergeMethod(sessionId, "rebase");
    const state = prStatusPoller.getAutoMergeState(sessionId);
    expect(state).toMatchObject({ enabled: false, mergeMethod: "rebase" });
  });

  it("setAutoMergeError sets error on state", () => {
    prStatusPoller.setAutoMergeEnabled(sessionId, false);
    prStatusPoller.setAutoMergeError(sessionId, {
      code: "no_branch_protection",
      message: "test error",
      settingsUrl: "https://example.com/settings",
    });

    const state = prStatusPoller.getAutoMergeState(sessionId);
    expect(state?.error).toMatchObject({ code: "no_branch_protection" });
  });

  it("untrackSession clears auto-merge state", () => {
    prStatusPoller.setAutoMergeEnabled(sessionId, true);
    prStatusPoller.untrackSession(sessionId);

    expect(prStatusPoller.getAutoMergeState(sessionId)).toBeUndefined();
  });
});

// ---- Post-merge archive callback ----

describe("PrStatusPoller onMergeDetected callback", () => {
  it("calls callback when PR disappears from OPEN results", async () => {
    const onMergeDetected = vi.fn().mockResolvedValue(undefined);

    const poller = new PrStatusPoller({
      githubAuth: githubAuth as any,
      sessionManager,
      sseBroadcast,
      onMergeDetectedCb: onMergeDetected,
    });

    // Seed the session in the poller + authenticate
    await githubAuth.setToken("test-token");
    sessionManager.track(sessionId, "Test session", sessionDir);
    sessionManager.setWorktreeInfo(sessionId, { branch: "shipit/test-feature", sessionType: "worktree" });
    sessionManager.setRemoteUrl(sessionId, "https://github.com/test-user/test-repo.git");

    // Set GraphQL result BEFORE tracking so the initial poll picks it up
    githubAuth.setGraphqlResult({
      data: {
        repository: {
          pullRequests: {
            nodes: [{
              number: 42,
              title: "Test PR",
              url: "https://github.com/test-user/test-repo/pull/42",
              state: "OPEN",
              mergeable: "MERGEABLE",
              autoMergeRequest: null,
              headRefName: "shipit/test-feature",
              baseRefName: "main",
              additions: 10,
              deletions: 5,
              commits: {
                nodes: [{
                  commit: {
                    oid: "abc123",
                    statusCheckRollup: null,
                  },
                }],
              },
            }],
          },
        },
      },
    });

    poller.trackSession(sessionId, "https://github.com/test-user/test-repo.git");

    // Wait for initial poll (fires immediately on trackSession)
    await new Promise((r) => setTimeout(r, 100));

    // Verify PR was picked up
    expect(poller.getStatus(sessionId)).toBeDefined();

    // Second poll: PR gone (merged)
    githubAuth.setGraphqlResult({
      data: {
        repository: {
          pullRequests: {
            nodes: [],
          },
        },
      },
    });

    // Wait for next poll cycle
    await new Promise((r) => setTimeout(r, 3_500));

    expect(onMergeDetected).toHaveBeenCalledWith(sessionId);

    poller.destroy();
  });
});
