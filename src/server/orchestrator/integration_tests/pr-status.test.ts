import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
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
let dbManager: DatabaseManager;

beforeEach(async () => {
  dbManager = createTestDatabaseManager();
  tmpDir = fs.mkdtempSync("/tmp/shipit-pr-status-test-");

  githubAuth = new StubGitHubAuthManager();

  // Create a session with a git repo
  sessionId = crypto.randomUUID();
  sessionDir = path.join(tmpDir, "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const credentialStore = createTestCredentialStore(tmpDir);
  const git = new GitManager(sessionDir);
  await git.init();

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
  });
});

afterEach(async () => {
  await app.close();
  dbManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("PR status via HTTP", () => {
  it("returns null when not authenticated", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/pr/status` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pr: null });
  });

  it("returns null when no origin remote is configured", async () => {
    await githubAuth.setToken("test-token");
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/pr/status` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pr: null });
  });

  it("returns null when no PR exists for current branch", async () => {
    await githubAuth.setToken("test-token");

    // Add a remote to the session's git repo
    const git = new GitManager(sessionDir);
    await git.addRemote("origin", "https://github.com/test-user/test-repo.git");

    githubAuth.setPrData(null);
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/pr/status` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pr: null });
  });

  it("returns PR data when a PR exists", async () => {
    await githubAuth.setToken("test-token");

    // Add a remote to the session's git repo
    const git = new GitManager(sessionDir);
    await git.addRemote("origin", "https://github.com/test-user/test-repo.git");

    githubAuth.setPrData({
      url: "https://github.com/test-user/test-repo/pull/42",
      number: 42,
      base: "main",
      title: "Test PR",
    });

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/pr/status` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      pr: {
        url: "https://github.com/test-user/test-repo/pull/42",
        number: 42,
        title: "Test PR",
        baseBranch: "main",
        state: "open",
        merged: false,
      },
    });
  });

  it("surfaces a merged/closed PR when no open PR exists (rebase-stable, state-aware)", async () => {
    await githubAuth.setToken("test-token");
    const git = new GitManager(sessionDir);
    await git.addRemote("origin", "https://github.com/test-user/test-repo.git");

    // No OPEN PR for the branch, but a prior PR already merged. Resolution is
    // by branch name (rebase-stable), and the any-state fallback surfaces it
    // instead of reporting "No PR for the current branch".
    githubAuth.setPrData(null);
    githubAuth.setFindPrAnyStateResult({
      url: "https://github.com/test-user/test-repo/pull/7",
      number: 7,
      base: "main",
      title: "Merged PR",
      body: "",
      state: "closed",
      merged_at: "2026-01-01T00:00:00Z",
      additions: 5,
      deletions: 2,
    });

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/pr/status` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      pr: { number: 7, title: "Merged PR", baseBranch: "main", state: "closed", merged: true },
    });
  });

  it("pr/view resolves a merged PR for the current branch", async () => {
    await githubAuth.setToken("test-token");
    const git = new GitManager(sessionDir);
    await git.addRemote("origin", "https://github.com/test-user/test-repo.git");

    githubAuth.setPrData(null);
    githubAuth.setFindPrAnyStateResult({
      url: "https://github.com/test-user/test-repo/pull/7",
      number: 7,
      base: "main",
      title: "Merged PR",
      body: "merged body",
      state: "closed",
      merged_at: "2026-01-01T00:00:00Z",
      additions: 5,
      deletions: 2,
    });
    githubAuth.setViewPrResult({
      url: "https://github.com/test-user/test-repo/pull/7",
      number: 7,
      base: "main",
      head: "shipit/feature",
      title: "Merged PR",
      body: "merged body",
      state: "closed",
      isDraft: false,
      merged: true,
      additions: 5,
      deletions: 2,
    });

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/pr/view` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      pr: { number: 7, state: "closed", merged: true },
    });
  });
});
