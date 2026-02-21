import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import {
  StubPreviewManager,
  StubAuthManager,
  StubGitHubAuthManager,
  StubFileWatcher,
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

beforeEach(async () => {
  tmpDir = fs.mkdtempSync("/tmp/shipit-pr-status-test-");

  githubAuth = new StubGitHubAuthManager();

  // Create a session with a git repo
  sessionId = crypto.randomUUID();
  sessionDir = path.join(tmpDir, "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const credentialStore = createTestCredentialStore(tmpDir);
  const git = new GitManager(sessionDir);
  await git.init();

  sessionManager = new SessionManager(path.join(tmpDir, "sessions.json"));
  sessionManager.track(sessionId, "Test session", sessionDir);

  app = await buildApp({
    credentialStore,
    workspaceDir: tmpDir,
    createGitManager: (dir: string) => new GitManager(dir),
    claudeFactory: () => new FakeClaudeProcess() as any,
    previewManager: new StubPreviewManager() as any,
    authManager: new StubAuthManager() as any,
    githubAuthManager: githubAuth as any,
    sessionManager,
    chatHistoryManager: new ChatHistoryManager(path.join(tmpDir, "chat")),
    usageManager: new UsageManager(path.join(tmpDir, "usage.json")),
    threadManager: new ThreadManager(path.join(tmpDir, "threads")),
    fileWatcher: new StubFileWatcher() as any,
    serveStatic: false,
    startPreview: false,
    detectPorts: async () => [],
    deploymentManager: new StubDeploymentManager() as any,
    deploymentStore: new StubDeploymentStore() as any,
    featureManager: new FeatureManager(tmpDir),
  });
});

afterEach(async () => {
  await app.close();
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
      },
    });
  });
});
