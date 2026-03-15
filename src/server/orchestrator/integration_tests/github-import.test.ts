import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { buildApp } from "../index.js";
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
import type { FastifyInstance } from "fastify";

let tmpDir: string;
let app: FastifyInstance;
let githubAuth: StubGitHubAuthManager;
let dbManager: DatabaseManager;

beforeEach(async () => {
  dbManager = createTestDatabaseManager();
  tmpDir = fs.mkdtempSync("/tmp/shipit-import-test-");

  githubAuth = new StubGitHubAuthManager();

  app = await buildApp({
    credentialStore: createTestCredentialStore(tmpDir),
    workspaceDir: tmpDir,
    agentFactory: () => new FakeClaudeProcess() as any,
    authManager: new StubAuthManager() as any,
    githubAuthManager: githubAuth as any,
    sessionManager: new SessionManager(dbManager),
    chatHistoryManager: new ChatHistoryManager(dbManager),
    usageManager: new UsageManager(dbManager),
    serveStatic: false,
    deploymentManager: new StubDeploymentManager() as any,
    deploymentStore: new StubDeploymentStore() as any,
  });
});

afterEach(async () => {
  await app.close();
  dbManager.close();
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
