import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { buildApp } from "../index.js";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { UsageManager } from "../usage.js";

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

  // Drain messages from the first turn — quiet-period bounded so we don't
  // wait the full 3 s when the burst finishes in <100 ms.
  await client.drain({ quietMs: 150 });

  // Get session ID from the filesystem (directory name = session UUID)
  const sessionsDir = path.join(tmpDir, "sessions");
  const entries = fs.readdirSync(sessionsDir);
  const sessionId = entries[0];
  const sessionDir = path.join(sessionsDir, sessionId, "workspace");

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

    // Wait directly for the github_push_result — bails the moment it arrives
    // instead of paying a quiet-period tail.
    const pushResult = await client.receiveType("github_push_result", 5000);
    expect(pushResult).toMatchObject({
      type: "github_push_result",
      success: true,
    });
  });

  it("pushes when HEAD moves during a clean turn", { timeout: 15_000 }, async () => {
    await githubAuth.setToken("test-token");
    const { sessionId, sessionDir } = await createSession();
    createBareRemote(sessionDir);

    client.send({ type: "send_message", text: "rebase cleanly", sessionId });
    const prevClaude = latestClaude;
    const claude2 = await waitForClaude(() => latestClaude, prevClaude);

    execSync("git commit --allow-empty -m 'manual clean head move'", {
      cwd: sessionDir,
      env: { ...process.env, HOME: tmpDir },
    });

    claude2.finish("test-session-1");

    const pushResult = await client.receiveType("github_push_result", 5000);
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

    // Wait for the debounce period — push will fail but should emit a log entry.
    // Drain with a short quiet period so the "no success message" assertion
    // doesn't sit on a 3 s timeout.
    const messages = await client.drain({ quietMs: 250 });

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
