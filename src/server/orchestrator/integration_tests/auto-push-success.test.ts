import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { buildApp } from "../index.js";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  StubDeploymentManager,
  StubDeploymentStore,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { UsageManager } from "../usage.js";
import { FeatureManager } from "../features.js";
import type { WsServerMessage } from "../../shared/types.js";

let tmpDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let client: TestClient;
let githubAuth: StubGitHubAuthManager;
let latestClaude: FakeClaudeProcess | null = null;
let dbManager: DatabaseManager;

beforeEach(async () => {
  dbManager = createTestDatabaseManager();
  tmpDir = fs.mkdtempSync("/tmp/shipit-auto-push-test-");
  latestClaude = null;

  githubAuth = new StubGitHubAuthManager();

  app = await buildApp({
    credentialStore: createTestCredentialStore(tmpDir),
    workspaceDir: tmpDir,
    agentFactory: () => {
      const c = new FakeClaudeProcess();
      latestClaude = c;
      return c as any;
    },
    authManager: new StubAuthManager() as any,
    githubAuthManager: githubAuth as any,
    sessionManager: new SessionManager(dbManager),
    chatHistoryManager: new ChatHistoryManager(dbManager),
    usageManager: new UsageManager(dbManager),
    serveStatic: false,
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
  dbManager.close();
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

/** Create a bare git repo and set it as origin on the session repo. */
function createBareRemote(sessionDir: string): string {
  const bareDir = path.join(tmpDir, "bare-remote.git");
  fs.mkdirSync(bareDir, { recursive: true });
  execSync("git init --bare -b main", { cwd: bareDir, env: { ...process.env, HOME: tmpDir } });

  // Add the bare repo as origin
  execSync(`git remote add origin ${bareDir}`, {
    cwd: sessionDir,
    env: { ...process.env, HOME: tmpDir },
  });

  // Detect current branch and push initial commit
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

  return bareDir;
}

/** Drain all messages from the client until timeout. */
async function drainMessages(timeoutMs = 3000): Promise<WsServerMessage[]> {
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

describe("auto-push: success and failure", () => {
  it("pushes after auto-commit when authenticated with a remote", { timeout: 15_000 }, async () => {
    await githubAuth.setToken("test-token");
    const { sessionId, sessionDir } = await createSession();
    createBareRemote(sessionDir);

    // Write a file so the next commit has changes
    fs.writeFileSync(path.join(sessionDir, "new-file.txt"), "auto-push test");

    // Send a second message to the SAME session
    client.send({ type: "send_message", text: "second turn", sessionId });
    const prevClaude = latestClaude;
    const claude2 = await waitForClaude(() => latestClaude, prevClaude);
    claude2.finish("test-session-1");

    // Wait for the auto-push result (100ms debounce + processing)
    const messages = await drainMessages();
    const pushResult = messages.find((m) => m.type === "github_push_result");
    expect(pushResult).toBeDefined();
    expect(pushResult).toMatchObject({
      type: "github_push_result",
      success: true,
    });
  });

  it("push failure is non-fatal and emits a log entry", { timeout: 15_000 }, async () => {
    await githubAuth.setToken("test-token");
    const { sessionId, sessionDir } = await createSession();

    // Add a non-existent remote URL (will cause push to fail)
    execSync("git remote add origin /nonexistent/path.git", {
      cwd: sessionDir,
      env: { ...process.env, HOME: tmpDir },
    });

    fs.writeFileSync(path.join(sessionDir, "file.txt"), "push-fail test");

    client.send({ type: "send_message", text: "turn two", sessionId });
    const prevClaude = latestClaude;
    const claude2 = await waitForClaude(() => latestClaude, prevClaude);
    claude2.finish("test-session-1");

    // Wait for the debounce period — push will fail but should emit a log entry
    const messages = await drainMessages();

    // Should have a log_entry about auto-push failure
    const failLog = messages.find(
      (m) =>
        m.type === "log_entry" &&
        "text" in m &&
        String((m as { text?: string }).text).includes("Auto-push failed"),
    );
    expect(failLog).toBeDefined();

    // Should NOT have a successful github_push_result
    const pushResult = messages.find((m) => m.type === "github_push_result");
    expect(pushResult).toBeUndefined();
  });
});
