import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
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
import type { WsServerMessage } from "../types.js";

let tmpDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let client: TestClient;
let githubAuth: StubGitHubAuthManager;
let latestClaude: FakeClaudeProcess | null = null;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync("/tmp/shipit-auto-push-test-");
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
    autoPushDebounceMs: 100,
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

/** Create a session and return its app session ID and workspace directory. */
async function createSession(): Promise<{ sessionId: string; sessionDir: string }> {
  client.send({ type: "send_message", text: "hello" });
  const claude = await waitForClaude(() => latestClaude);

  // Emit a system/init event so the server sends session_started
  claude.emit("event", { type: "system", subtype: "init", session_id: "test-session-1" });
  claude.finish("test-session-1");

  // Drain messages from the first turn
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      await client.receive(500);
    } catch {
      break;
    }
  }

  // Get session ID from the filesystem (directory name = session UUID)
  const sessionsDir = path.join(tmpDir, "sessions");
  const entries = fs.readdirSync(sessionsDir);
  const sessionId = entries[0];
  const sessionDir = path.join(sessionsDir, sessionId);

  return { sessionId, sessionDir };
}

/** Drain all messages from the client until timeout. */
async function drainMessages(timeoutMs = 2000): Promise<WsServerMessage[]> {
  const messages: WsServerMessage[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const msg = await client.receive(Math.max(100, deadline - Date.now()));
      messages.push(msg);
    } catch {
      break;
    }
  }
  return messages;
}

describe("auto-push: skip conditions", () => {
  it("does not push when not authenticated", async () => {
    // Not authenticated — no setToken call
    const { sessionId, sessionDir } = await createSession();

    // Create bare remote so the only missing condition is auth
    const bareDir = path.join(tmpDir, "bare-remote.git");
    fs.mkdirSync(bareDir, { recursive: true });
    execSync("git init --bare", { cwd: bareDir, env: { ...process.env, HOME: tmpDir } });
    execSync(`git remote add origin ${bareDir}`, {
      cwd: sessionDir,
      env: { ...process.env, HOME: tmpDir },
    });
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: sessionDir,
      env: { ...process.env, HOME: tmpDir },
    })
      .toString()
      .trim();
    execSync(`git push -u origin ${branch}`, {
      cwd: sessionDir,
      env: { ...process.env, HOME: tmpDir },
    });

    fs.writeFileSync(path.join(sessionDir, "file.txt"), "no auth test");

    client.send({ type: "send_message", text: "turn two", sessionId });
    const prevClaude = latestClaude;
    const claude2 = await waitForClaude(() => latestClaude, prevClaude);
    claude2.finish("test-session-1");

    // Wait past the debounce (100ms) — no push_result should appear
    const messages = await drainMessages();
    const pushResult = messages.find((m) => m.type === "github_push_result");
    expect(pushResult).toBeUndefined();
  });

  it("does not push when no origin remote is configured", async () => {
    await githubAuth.setToken("test-token");
    const { sessionId, sessionDir } = await createSession();
    // No remote added

    fs.writeFileSync(path.join(sessionDir, "file.txt"), "no remote test");

    client.send({ type: "send_message", text: "turn two", sessionId });
    const prevClaude = latestClaude;
    const claude2 = await waitForClaude(() => latestClaude, prevClaude);
    claude2.finish("test-session-1");

    // Wait past the debounce (100ms) — no push_result should appear
    const messages = await drainMessages();
    const pushResult = messages.find((m) => m.type === "github_push_result");
    expect(pushResult).toBeUndefined();
  });
});
