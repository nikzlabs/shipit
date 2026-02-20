import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildApp } from "../index.js";
import {
  TestClient,
  StubPreviewManager,
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
  tmpDir = fs.mkdtempSync("/tmp/shipit-pr-status-test-");
  latestClaude = null;

  githubAuth = new StubGitHubAuthManager();

  app = await buildApp({
    workspaceDir: tmpDir,
    claudeFactory: () => {
      const c = new FakeClaudeProcess();
      latestClaude = c;
      return c as any;
    },
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

/** Helper to create a session so there's an activeSessionDir. */
async function createSession() {
  client.send({ type: "send_message", text: "hello" });
  const claude = await waitForClaude(() => latestClaude);
  claude.finish("test-session-1");

  // Drain messages until done
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

describe("get_pr_status", () => {
  it("returns null when not authenticated", async () => {
    await createSession();
    client.send({ type: "get_pr_status" });
    const msg = await client.receiveSkipLogs();
    expect(msg).toMatchObject({ type: "pr_status", pr: null });
  });

  it("returns null when no origin remote is configured", async () => {
    await githubAuth.setToken("test-token");
    await createSession();
    client.send({ type: "get_pr_status" });
    const msg = await client.receiveSkipLogs();
    expect(msg).toMatchObject({ type: "pr_status", pr: null });
  });

  it("returns null when no PR exists for current branch", async () => {
    await githubAuth.setToken("test-token");
    await createSession();

    // Set up a remote — we need to find the session dir
    // Send a get_git_log to trigger session activation, then set remote
    client.send({ type: "github_set_remote", name: "origin", url: "https://github.com/test-user/test-repo.git" });
    await client.receiveSkipLogs(); // github_remotes response

    githubAuth.setPrData(null);
    client.send({ type: "get_pr_status" });
    const msg = await client.receiveSkipLogs();
    expect(msg).toMatchObject({ type: "pr_status", pr: null });
  });

  it("returns PR data when a PR exists", async () => {
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

    client.send({ type: "get_pr_status" });
    const msg = await client.receiveSkipLogs();
    expect(msg).toMatchObject({
      type: "pr_status",
      pr: {
        url: "https://github.com/test-user/test-repo/pull/42",
        number: 42,
        title: "Test PR",
        baseBranch: "main",
      },
    });
  });
});
