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
  sseBroadcast.mockClear();
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

  it("stores auto-merge intent when no PR exists yet", async () => {
    await githubAuth.setToken("test-token");

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/auto-merge`,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ enabled: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, mergeMethod: "squash" });
    expect(prStatusPoller.getAutoMergeState(sessionId)).toMatchObject({
      enabled: true,
      mergeMethod: "squash",
    });
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
      error: expect.stringContaining("Agent still working"),
    });
  });

  // docs/266 — the guard covers `agentBusy`, not bare `running`. The turn's
  // commit and the debounced auto-push it arms both run once `running` is
  // false, so a merge accepted in that window still orphans work on a branch
  // whose PR just closed.
  it("returns 409 while post-turn work (commit + debounced push) is in flight", async () => {
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

    // The turn has ENDED (`running: false`) but its terminal sequence has not.
    const setBusy = await app.inject({
      method: "POST",
      url: `/api/_test/runner/${sessionId}/running`,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ running: false, postTurnWork: true }),
    });
    expect(setBusy.json()).toMatchObject({ running: false, agentBusy: true });

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/merge`,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ method: "squash" }),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining("Agent still working"),
    });

    // Release the hold so it can't leak into the next test's runner.
    await app.inject({
      method: "POST",
      url: `/api/_test/runner/${sessionId}/running`,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ postTurnWork: false }),
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

  it("forces a merged PR status update after merge succeeds", async () => {
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
    githubAuth.setPrData({
      url: "https://github.com/test-user/test-repo/pull/42",
      number: 42,
      base: "main",
      title: "Test PR",
    });
    githubAuth.setFindPrAnyStateResult({
      url: "https://github.com/test-user/test-repo/pull/42",
      number: 42,
      base: "main",
      title: "Test PR",
      body: "",
      state: "closed",
      merged_at: "2026-05-24T12:00:00Z",
      additions: 10,
      deletions: 5,
    });

    prStatusPoller.trackSession(sessionId, "https://github.com/test-user/test-repo.git");
    await new Promise((r) => setTimeout(r, 100));
    sseBroadcast.mockClear();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/merge`,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ method: "squash" }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true });
    expect(sseBroadcast).toHaveBeenCalledWith("pr_status", expect.objectContaining({
      updates: [expect.objectContaining({ sessionId, prState: "merged", prNumber: 42 })],
    }));
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
    // (The poller's workflow-loader path requires a real bare repo with `.github/workflows`
    // entries reachable via `git ls-tree`; bypass that here by asserting on the merge
    // endpoint's "pending && total === 0" branch directly.)
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

/**
 * The obsolete-merge guard. Every other gate on this route asks GitHub a
 * question about the remote branch; none of them can see that the remote branch
 * is simply OLD. ShipIt pushes on a debounce and never force-pushes, so a
 * rejected push leaves the session holding commits GitHub has never seen behind
 * a pull request that looks perfectly mergeable — which is how two pull requests
 * once merged seven and two commits behind (`services/auto-push-scheduler.ts`).
 *
 * The client disables the button off the poller's reading; this is the half that
 * holds against a stale tab, so it re-resolves the state against the real
 * remote. The remote here is a local bare repo — `sessionManager`'s remote URL
 * stays the GitHub one (it is what names owner/repo for the merge API), while
 * git's `origin` is the bare repo the push can actually reach.
 */
describe("POST /api/sessions/:id/pr/merge — obsolete-state guard", () => {
  let bareDir: string;

  const runGit = (cmd: string, cwd: string): string =>
    execSync(cmd, { cwd, env: { ...process.env, HOME: tmpDir }, stdio: ["pipe", "pipe", "pipe"] })
      .toString();

  beforeEach(async () => {
    sessionManager.setBranch(sessionId, "shipit/test-feature");
    sessionManager.setRemoteUrl(sessionId, "https://github.com/test-user/test-repo.git");
    await githubAuth.setToken("test-token");

    bareDir = path.join(tmpDir, "bare.git");
    fs.mkdirSync(bareDir);
    runGit("git init --bare -b main", bareDir);
    runGit(`git remote set-url origin ${bareDir}`, sessionDir);
    runGit("git push origin shipit/test-feature", sessionDir);

    // A green, mergeable PR — so the CI and review gates are satisfied and the
    // only thing that can hold the merge is the branch's sync state.
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
  });

  const postMerge = () => app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/pr/merge`,
    headers: { "Content-Type": "application/json" },
    payload: JSON.stringify({ method: "squash" }),
  });

  it("does not hold a branch that carries everything the session has", async () => {
    const res = await postMerge();

    // The merge itself goes on to fail in this fixture (the stub resolves no PR
    // for the branch), which is exactly the point: an in-sync branch reaches
    // the merge, rather than being turned back by this guard.
    expect(res.statusCode).toBe(200);
    expect(res.json().message).not.toMatch(/diverged|Pushed|reached GitHub/);
  });

  it("does not merge a branch the session has moved past — it pushes the missing work instead", async () => {
    const merge = vi.spyOn(githubAuth, "mergePullRequest");
    fs.writeFileSync(path.join(sessionDir, "later.md"), "work the remote has never seen\n");
    runGit("git add -A && git commit -m later", sessionDir);
    const localHead = runGit("git rev-parse HEAD", sessionDir).trim();

    const res = await postMerge();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: false });
    expect(res.json().message).toContain("Pushed 1 commit");
    // Nothing was merged…
    expect(merge).not.toHaveBeenCalled();
    // …and the click was not wasted: the work is on the remote, so the next one
    // merges what the session actually produced.
    expect(runGit("git rev-parse refs/heads/shipit/test-feature", bareDir).trim()).toBe(localHead);
  });

  it("refuses outright when the branch has diverged, and repairs nothing", async () => {
    const merge = vi.spyOn(githubAuth, "mergePullRequest");
    // The remote branch gains a commit from elsewhere…
    const otherDir = path.join(tmpDir, "other");
    fs.mkdirSync(otherDir);
    runGit(`git clone ${bareDir} .`, otherDir);
    runGit("git checkout shipit/test-feature", otherDir);
    fs.writeFileSync(path.join(otherDir, "theirs.md"), "1\n");
    runGit("git add -A && git commit -m theirs", otherDir);
    runGit("git push origin shipit/test-feature", otherDir);
    const remoteTip = runGit("git rev-parse refs/heads/shipit/test-feature", bareDir).trim();
    // …while this session commits its own work on the old tip.
    fs.writeFileSync(path.join(sessionDir, "ours.md"), "1\n");
    runGit("git add -A && git commit -m ours", sessionDir);

    const res = await postMerge();

    expect(res.json()).toMatchObject({ success: false });
    expect(res.json().message).toContain("diverged");
    expect(merge).not.toHaveBeenCalled();
    // The two remedies (pull, force-push) each destroy one side's commits, and
    // git cannot say which is right — so neither is attempted.
    expect(runGit("git rev-parse refs/heads/shipit/test-feature", bareDir).trim()).toBe(remoteTip);
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
      body: "",
      state: "closed",
      merged_at: "2026-05-19T12:00:00Z",
      additions: 10,
      deletions: 5,
    });

    // Trigger an immediate poll rather than sleeping for the production
    // interval; this exercises the same missing-PR verification path.
    poller.setPrTabActive(sessionId, true);
    await new Promise((r) => setTimeout(r, 100));

    expect(onMergeDetected).toHaveBeenCalledWith(sessionId);

    poller.destroy();
  });
});
