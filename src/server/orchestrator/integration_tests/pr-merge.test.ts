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
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { UsageManager } from "../usage.js";
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
    generateText: async () => "Test",
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

// ---- POST /api/sessions/:id/pr/merge ----

describe("POST /api/sessions/:id/pr/merge — agent-running guard", () => {
  beforeEach(async () => {
    sessionManager.setBranch(sessionId, "shipit/test-feature");
    sessionManager.setRemoteUrl(sessionId, "https://github.com/test-user/test-repo.git");
    await githubAuth.setToken("test-token");
  });

  it("returns 409 when the session's runner is mid-turn", async () => {
    // Seed PR status so the request would otherwise sail past the CI-not-ready
    // guard — we want to assert that the running-runner gate fires first.
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
                    statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } },
                  },
                }],
              },
            }],
          },
        },
      },
    });
    prStatusPoller.trackSession(sessionId, "https://github.com/test-user/test-repo.git");
    await new Promise((r) => setTimeout(r, 100));

    // Flip the runner into the running state via the test-only endpoint.
    const setRunning = await app.inject({
      method: "POST",
      url: `/api/_test/runner/${sessionId}/running`,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ running: true }),
    });
    expect(setRunning.statusCode).toBe(200);
    expect(setRunning.json()).toMatchObject({ ok: true, running: true });

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/merge`,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ method: "squash" }),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining("Agent turn in progress"),
    });
  });

  it("allows merge after the runner finishes the turn", async () => {
    // Seed a successful-CI PR like above.
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
                    statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } },
                  },
                }],
              },
            }],
          },
        },
      },
    });
    prStatusPoller.trackSession(sessionId, "https://github.com/test-user/test-repo.git");
    await new Promise((r) => setTimeout(r, 100));

    // Briefly running, then idle — the gate should release.
    await app.inject({
      method: "POST",
      url: `/api/_test/runner/${sessionId}/running`,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ running: true }),
    });
    await app.inject({
      method: "POST",
      url: `/api/_test/runner/${sessionId}/running`,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ running: false }),
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/merge`,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ method: "squash" }),
    });

    // Should NOT be 409 — the running-flag guard is clear. The actual merge
    // call may still fail in the stub (no real GitHub), but the status code
    // proves the running-runner gate didn't fire.
    expect(res.statusCode).not.toBe(409);
  });
});

describe("POST /api/sessions/:id/pr/merge — CI-not-ready guard", () => {
  beforeEach(async () => {
    sessionManager.setBranch(sessionId, "shipit/test-feature");
    sessionManager.setRemoteUrl(sessionId, "https://github.com/test-user/test-repo.git");
    await githubAuth.setToken("test-token");
  });

  it("blocks merge when poller is tracking the session but has no status yet", async () => {
    // Tracking starts the poller. Default _graphqlResult is null, so pollRepo
    // exits early before populating any status — exactly the race window
    // where a user clicks Merge after creating a PR but before the first
    // successful poll.
    prStatusPoller.trackSession(sessionId, "https://github.com/test-user/test-repo.git");

    expect(prStatusPoller.getStatus(sessionId)).toBeUndefined();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/merge`,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ method: "squash" }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: false,
      message: "Waiting for CI checks to start",
    });
  });

  it("blocks merge when checks are pending with zero total", async () => {
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
                    statusCheckRollup: { state: "PENDING", contexts: { nodes: [] } },
                  },
                }],
              },
            }],
          },
        },
      },
    });

    prStatusPoller.trackSession(sessionId, "https://github.com/test-user/test-repo.git");

    // Wait for the immediate poll to populate state
    await new Promise((r) => setTimeout(r, 100));

    // Force-mutate the cached status to simulate "workflows exist but no checks reported".
    // (The poller's checkRepoHasWorkflows path requires getSharedRepoDir; bypass that
    // here by asserting on the merge endpoint's "pending && total === 0" branch directly.)
    const status = prStatusPoller.getStatus(sessionId);
    if (status) {
      status.checks.state = "pending";
      status.checks.total = 0;
    }

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/merge`,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ method: "squash" }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: false,
      message: "Waiting for CI checks to start",
    });
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
  it("calls callback when PR disappears from OPEN results", { timeout: 15_000 }, async () => {
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
    sessionManager.setBranch(sessionId, "shipit/test-feature");
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

    // Second poll: PR gone from the bulk view, REST verify confirms merged.
    // Promotion is now async (REST verify before mergedSessions is set) so
    // the test waits past one poll interval + REST round-trip.
    githubAuth.setGraphqlResult({
      data: {
        repository: {
          pullRequests: {
            nodes: [],
          },
        },
      },
    });
    githubAuth.setFindPrAnyStateResult({
      url: "https://github.com/test-user/test-repo/pull/42",
      number: 42,
      base: "main",
      title: "Test PR",
      state: "closed",
      merged_at: "2026-05-19T12:00:00Z",
      additions: 10,
      deletions: 5,
    });

    // Wait for next poll cycle (5s interval + a REST hop's worth of slop).
    await new Promise((r) => setTimeout(r, 5_500));

    expect(onMergeDetected).toHaveBeenCalledWith(sessionId);

    poller.destroy();
  });
});
