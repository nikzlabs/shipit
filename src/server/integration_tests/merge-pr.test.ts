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
  waitForClaude,
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
let latestClaude: FakeClaudeProcess | null = null;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync("/tmp/shipit-merge-test-");
  latestClaude = null;

  githubAuth = new StubGitHubAuthManager();

  app = await buildApp({
    workspaceDir: tmpDir,
    claudeFactory: () => {
      const c = new FakeClaudeProcess();
      latestClaude = c;
      return c as any;
    },
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

async function createSession() {
  client.send({ type: "send_message", text: "hello" });
  const claude = await waitForClaude(() => latestClaude);
  claude.finish("test-session-1");

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const msg = await client.receive(500);
      if (msg.type === "session_started") return;
    } catch {
      break;
    }
  }
}

describe("merge_pr", () => {
  it("returns error when not authenticated", async () => {
    await createSession();
    client.send({ type: "merge_pr" });
    const msg = await client.receiveSkipLogs();
    expect(msg).toMatchObject({
      type: "merge_pr_result",
      success: false,
      message: "Not authenticated with GitHub",
    });
  });

  it("returns error when no PR exists", async () => {
    await githubAuth.setToken("test-token");
    await createSession();

    client.send({ type: "github_set_remote", name: "origin", url: "https://github.com/test-user/test-repo.git" });
    await client.receiveSkipLogs(); // github_remotes

    githubAuth.setPrData(null);
    client.send({ type: "merge_pr" });
    const msg = await client.receiveSkipLogs();
    expect(msg).toMatchObject({
      type: "merge_pr_result",
      success: false,
      message: "No active PR for current branch",
    });
  });

  it("merges successfully when checks pass", async () => {
    await githubAuth.setToken("test-token");
    await createSession();

    client.send({ type: "github_set_remote", name: "origin", url: "https://github.com/test-user/test-repo.git" });
    await client.receiveSkipLogs(); // github_remotes

    githubAuth.setPrData({
      url: "https://github.com/test-user/test-repo/pull/42",
      number: 42,
      base: "main",
      title: "Test PR",
    });
    githubAuth.setMergeResult({ success: true, message: "Pull request merged" });

    client.send({ type: "merge_pr", method: "squash" });
    const msg = await client.receiveSkipLogs();
    expect(msg).toMatchObject({
      type: "merge_pr_result",
      success: true,
      message: "Pull request merged",
    });
  });

  it("enables auto-merge when checks are pending", async () => {
    await githubAuth.setToken("test-token");
    await createSession();

    client.send({ type: "github_set_remote", name: "origin", url: "https://github.com/test-user/test-repo.git" });
    await client.receiveSkipLogs(); // github_remotes

    githubAuth.setPrData({
      url: "https://github.com/test-user/test-repo/pull/42",
      number: 42,
      base: "main",
      title: "Test PR",
    });
    githubAuth.setMergeResult({ success: false, message: "PR is not mergeable" });
    githubAuth.setCheckStatus({
      state: "pending",
      total: 3,
      passed: 1,
      failed: 0,
      pending: 2,
    });

    client.send({ type: "merge_pr" });
    const msg = await client.receiveSkipLogs();
    expect(msg).toMatchObject({
      type: "merge_pr_result",
      success: true,
      autoMergeEnabled: true,
    });
  });
});
