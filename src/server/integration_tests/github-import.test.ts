import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildApp } from "../index.js";
import {
  TestClient,
  StubViteManager,
  StubAuthManager,
  StubGitHubAuthManager,
  StubFileWatcher,
  StubDeploymentManager,
  StubDeploymentStore,
  FakeClaudeProcess,
} from "./test-helpers.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { UsageManager } from "../usage.js";
import { ThreadManager } from "../threads.js";
import { FeatureManager } from "../features.js";

let tmpDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let client: TestClient;
let githubAuth: StubGitHubAuthManager;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync("/tmp/shipit-import-test-");

  githubAuth = new StubGitHubAuthManager();

  app = await buildApp({
    workspaceDir: tmpDir,
    claudeFactory: () => new FakeClaudeProcess() as any,
    viteManager: new StubViteManager() as any,
    authManager: new StubAuthManager() as any,
    githubAuthManager: githubAuth as any,
    sessionManager: new SessionManager(path.join(tmpDir, "sessions.json")),
    chatHistoryManager: new ChatHistoryManager(path.join(tmpDir, "chat")),
    usageManager: new UsageManager(path.join(tmpDir, "usage.json")),
    threadManager: new ThreadManager(path.join(tmpDir, "threads")),
    fileWatcher: new StubFileWatcher() as any,
    serveStatic: false,
    startVite: false,
    detectPorts: async () => [],
    deploymentManager: new StubDeploymentManager() as any,
    deploymentStore: new StubDeploymentStore() as any,
    featureManager: new FeatureManager(tmpDir),
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  client = await TestClient.connect(port);
  // consume initial preview_status
  await client.receive();
});

afterEach(async () => {
  client.close();
  await app.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("github_search_repos", () => {
  it("returns empty array for short queries", async () => {
    client.send({ type: "github_search_repos", query: "a" });
    const msg = await client.receiveSkipLogs();
    expect(msg).toMatchObject({ type: "github_search_results", repos: [] });
  });

  it("returns results when authenticated", async () => {
    await githubAuth.setToken("test-token");
    client.send({ type: "github_search_repos", query: "test-repo" });
    const msg = await client.receiveSkipLogs();
    expect(msg).toMatchObject({ type: "github_search_results" });
    if (msg.type === "github_search_results") {
      expect(msg.repos.length).toBeGreaterThan(0);
      expect(msg.repos[0]).toMatchObject({
        fullName: "test-user/test-repo",
        cloneUrl: "https://github.com/test-user/test-repo.git",
      });
    }
  });
});
