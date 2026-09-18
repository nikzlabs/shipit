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

  await git.addRemote("origin", "https://github.com/test-user/test-repo.git");
  execSync("git checkout -b shipit/test-feature", {
    cwd: sessionDir,
    env: { ...process.env, HOME: tmpDir },
  });

  sessionManager = new SessionManager(dbManager);
  sessionManager.track(sessionId, "Test session", sessionDir);

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

describe("POST /api/sessions/:id/pr/merge — agent-running guard", () => {
  beforeEach(async () => {
    sessionManager.setBranch(sessionId, "shipit/test-feature");
    sessionManager.setRemoteUrl(sessionId, "https://github.com/test-user/test-repo.git");
    await githubAuth.setToken("test-token");
  });

  it("returns 409 when the session's runner is mid-turn", async () => {
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

    await app.inject({
      method: "POST",
      url: `/api/_test/runner/${sessionId}/running`,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ postTurnWork: false }),
    });
  });

  it("allows merge after the runner finishes the turn", async () => {
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

    await new Promise((r) => setTimeout(r, 100));

    // Inject pending state without building the workflow-loader's bare repo fixture.
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

// Keep the session's GitHub identity while routing git operations to a local bare repo.
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
    expect(merge).not.toHaveBeenCalled();
    expect(runGit("git rev-parse refs/heads/shipit/test-feature", bareDir).trim()).toBe(localHead);
  });

  it("refuses outright when the branch has diverged, and repairs nothing", async () => {
    const merge = vi.spyOn(githubAuth, "mergePullRequest");
    const otherDir = path.join(tmpDir, "other");
    fs.mkdirSync(otherDir);
    runGit(`git clone ${bareDir} .`, otherDir);
    runGit("git checkout shipit/test-feature", otherDir);
    fs.writeFileSync(path.join(otherDir, "theirs.md"), "1\n");
    runGit("git add -A && git commit -m theirs", otherDir);
    runGit("git push origin shipit/test-feature", otherDir);
    const remoteTip = runGit("git rev-parse refs/heads/shipit/test-feature", bareDir).trim();
    fs.writeFileSync(path.join(sessionDir, "ours.md"), "1\n");
    runGit("git add -A && git commit -m ours", sessionDir);

    const res = await postMerge();

    expect(res.json()).toMatchObject({ success: false });
    expect(res.json().message).toContain("diverged");
    expect(merge).not.toHaveBeenCalled();
    expect(runGit("git rev-parse refs/heads/shipit/test-feature", bareDir).trim()).toBe(remoteTip);
  });
});

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

describe("PrStatusPoller onMergeDetected callback", () => {
  it("calls callback when PR disappears from OPEN results", { timeout: 15_000 }, async () => {
    const onMergeDetected = vi.fn().mockResolvedValue(undefined);

    const poller = new PrStatusPoller({
      githubAuth: githubAuth as any,
      sessionManager,
      sseBroadcast,
      onMergeDetectedCb: onMergeDetected,
    });

    await githubAuth.setToken("test-token");
    sessionManager.track(sessionId, "Test session", sessionDir);
    sessionManager.setBranch(sessionId, "shipit/test-feature");
    sessionManager.setRemoteUrl(sessionId, "https://github.com/test-user/test-repo.git");

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

    await new Promise((r) => setTimeout(r, 100));

    expect(poller.getStatus(sessionId)).toBeDefined();

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

    // Trigger a poll without waiting for the production interval.
    poller.setPrTabActive(sessionId, true);
    await new Promise((r) => setTimeout(r, 100));

    expect(onMergeDetected).toHaveBeenCalledWith(sessionId);

    poller.destroy();
  });
});
