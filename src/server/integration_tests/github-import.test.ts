import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildApp } from "../index.js";
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

beforeEach(async () => {
  tmpDir = fs.mkdtempSync("/tmp/shipit-import-test-");

  githubAuth = new StubGitHubAuthManager();

  app = await buildApp({
    credentialStore: createTestCredentialStore(tmpDir),
    workspaceDir: tmpDir,
    claudeFactory: () => new FakeClaudeProcess() as any,
    previewManager: new StubPreviewManager() as any,
    authManager: new StubAuthManager() as any,
    githubAuthManager: githubAuth as any,
    sessionManager: new SessionManager(path.join(tmpDir, "sessions.json")),
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

describe("GitHub repo search via HTTP", () => {
  it("returns empty array for short queries", async () => {
    const res = await app.inject({ method: "GET", url: "/api/github/repos?q=a" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ repos: [] });
  });

  it("returns results when authenticated", async () => {
    await githubAuth.setToken("test-token");
    const res = await app.inject({ method: "GET", url: "/api/github/repos?q=test-repo" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.repos.length).toBeGreaterThan(0);
    expect(body.repos[0]).toMatchObject({
      fullName: "test-user/test-repo",
      cloneUrl: "https://github.com/test-user/test-repo.git",
    });
  });
});
