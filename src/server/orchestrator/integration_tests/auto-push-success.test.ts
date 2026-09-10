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
import type { WsServerMessage } from "../../shared/types.js";

let tmpDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let client: TestClient;
let githubAuth: StubGitHubAuthManager;
let latestClaude: FakeClaudeProcess | null = null;
let dbManager: DatabaseManager;
let chatHistory: ChatHistoryManager;

beforeEach(async () => {
  dbManager = createTestDatabaseManager();
  chatHistory = new ChatHistoryManager(dbManager);
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
    chatHistoryManager: chatHistory,
    usageManager: new UsageManager(dbManager),
    serveStatic: false,
    autoPushDebounceMs: 100,
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  client = await TestClient.connect(port);
  await client.receive();
});

afterEach(async () => {
  dbManager.close();
  client.close();
  await app.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createSession(): Promise<{ sessionId: string; sessionDir: string }> {
  client.send({ type: "send_message", text: "hello" });
  const claude = await waitForClaude(() => latestClaude);

  claude.emit("event", { type: "system", subtype: "init", session_id: "test-session-1" });
  claude.finish("test-session-1");

  await client.drain({ quietMs: 150 });

  const sessionsDir = path.join(tmpDir, "sessions");
  const entries = fs.readdirSync(sessionsDir);
  const sessionId = entries[0];
  const sessionDir = path.join(sessionsDir, sessionId, "workspace");

  return { sessionId, sessionDir };
}

function createBareRemote(sessionDir: string): string {
  const bareDir = path.join(tmpDir, "bare-remote.git");
  fs.mkdirSync(bareDir, { recursive: true });
  execSync("git init --bare -b main", { cwd: bareDir, env: { ...process.env, HOME: tmpDir } });

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

  return bareDir;
}

describe("auto-push: success and failure", () => {
  it("pushes after auto-commit when authenticated with a remote", { timeout: 15_000 }, async () => {
    await githubAuth.setToken("test-token");
    const { sessionId, sessionDir } = await createSession();
    createBareRemote(sessionDir);

    fs.writeFileSync(path.join(sessionDir, "new-file.txt"), "auto-push test");

    client.send({ type: "send_message", text: "second turn", sessionId });
    const prevClaude = latestClaude;
    const claude2 = await waitForClaude(() => latestClaude, prevClaude);
    claude2.finish("test-session-1");

    // Collect the log first; waiting for github_push_result would consume it.
    const isCompleted = (m: WsServerMessage) =>
      m.type === "log_append" && m.channel === "agent"
      && m.records.some((r) => r.text.startsWith("Auto-push completed"));
    const messages = await client.collectUntil(isCompleted, { quietMs: 250 });

    const completed = messages
      .flatMap((m) => (m.type === "log_append" ? m.records : []))
      .map((r) => r.text)
      .find((t) => t.startsWith("Auto-push completed"));
    expect(completed).toMatch(
      /^Auto-push completed in \d+ms: 1 commit\(s\) was ahead of the last known remote tip\.$/,
    );

    expect(messages.some((m) => m.type === "github_push_result" && m.success)).toBe(true);
  });

  it("pushes even when the runner is disposed before the debounce fires", { timeout: 15_000 }, async () => {
    await githubAuth.setToken("test-token");
    const { sessionId, sessionDir } = await createSession();
    const bareDir = createBareRemote(sessionDir);

    fs.writeFileSync(path.join(sessionDir, "survives-disposal.txt"), "post-turn commit");

    client.send({ type: "send_message", text: "second turn", sessionId });
    const prevClaude = latestClaude;
    const claude2 = await waitForClaude(() => latestClaude, prevClaude);
    claude2.finish("test-session-1");

    app.runnerRegistry.dispose(sessionId, { force: true });

    const remoteHas = async (): Promise<boolean> => {
      const files = execSync("git ls-tree -r --name-only --full-tree HEAD || true", {
        cwd: bareDir,
        env: { ...process.env, HOME: tmpDir },
      }).toString();
      return files.includes("survives-disposal.txt");
    };
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !(await remoteHas())) {
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(await remoteHas()).toBe(true);
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

  it("persists a transcript notice when the push is rejected as non-fast-forward", { timeout: 15_000 }, async () => {
    await githubAuth.setToken("test-token");
    const { sessionId, sessionDir } = await createSession();
    createBareRemote(sessionDir);

    // Preserve a common base. Change the amended message to ensure a new SHA.
    execSync("git commit --allow-empty -m 'work on top of the pushed base'", {
      cwd: sessionDir,
      env: { ...process.env, HOME: tmpDir },
    });
    execSync("git push origin HEAD", { cwd: sessionDir, env: { ...process.env, HOME: tmpDir } });
    execSync('git commit --amend --allow-empty -m "rewritten by a rebase onto a fresh base"', {
      cwd: sessionDir,
      env: { ...process.env, HOME: tmpDir },
    });

    fs.writeFileSync(path.join(sessionDir, "stranded.txt"), "this commit must not vanish quietly");

    client.send({ type: "send_message", text: "turn on a diverged branch", sessionId });
    const prevClaude = latestClaude;
    const claude2 = await waitForClaude(() => latestClaude, prevClaude);
    claude2.finish("test-session-1");

    const isNotice = (m: WsServerMessage) => m.type === "system_notice" && m.message.includes("diverged");
    const messages = await client.collectUntil(isNotice, { quietMs: 250 });

    const notice = messages.find(isNotice);
    expect(notice).toMatchObject({ type: "system_notice", level: "warn", sessionId });
    const message = (notice as { message: string }).message;
    expect(message).toContain("--force-with-lease");
    expect(message).toContain("2 commits only in this session");
    expect(message).toContain("1 commit only on the remote");
    expect(message).toContain("work on top of the pushed base");

    const persisted = chatHistory.load(sessionId).filter((m) => m.notice && m.text?.includes("diverged"));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.noticeLevel).toBe("warn");

    expect(messages.find((m) => m.type === "github_push_result" && m.success)).toBeUndefined();

    // A following turn would erase a notice incorrectly saved as in-progress.
    fs.writeFileSync(path.join(sessionDir, "second.txt"), "another turn");
    client.send({ type: "send_message", text: "a following turn", sessionId });
    const claude3 = await waitForClaude(() => latestClaude, claude2);
    claude3.finish("test-session-1");
    await client.drain({ quietMs: 300 });

    const afterNextTurn = chatHistory.load(sessionId).filter((m) => m.notice && m.text?.includes("diverged"));
    expect(afterNextTurn).toHaveLength(1);
  });

  it("push failure is non-fatal and emits a log entry", { timeout: 15_000 }, async () => {
    await githubAuth.setToken("test-token");
    const { sessionId, sessionDir } = await createSession();

    execSync("git remote add origin /nonexistent/path.git", {
      cwd: sessionDir,
      env: { ...process.env, HOME: tmpDir },
    });

    fs.writeFileSync(path.join(sessionDir, "file.txt"), "push-fail test");

    client.send({ type: "send_message", text: "turn two", sessionId });
    const prevClaude = latestClaude;
    const claude2 = await waitForClaude(() => latestClaude, prevClaude);
    claude2.finish("test-session-1");

    // Wait for the failure; a quiet period can end before the push starts.
    const isFailLog = (m: WsServerMessage) =>
      m.type === "log_append" &&
      m.channel === "agent" &&
      m.records.some((r) => r.text.includes("Auto-push failed"));
    const messages = await client.collectUntil(isFailLog, { quietMs: 250 });

    const failLog = messages.find(isFailLog);
    expect(failLog).toBeDefined();

    const pushResult = messages.find((m) => m.type === "github_push_result");
    expect(pushResult).toBeUndefined();
  });
});
