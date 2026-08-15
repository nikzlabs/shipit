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

  /**
   * The 2026-08-10 incident, end to end. The debounced push used to live on the
   * session's runner, so a runner reclaimed between the post-turn commit and the
   * 5s debounce took the push with it — no push, no error, no log line. Asserts
   * the observable outcome: the commit reaches the remote regardless.
   */
  it("pushes even when the runner is disposed before the debounce fires", { timeout: 15_000 }, async () => {
    await githubAuth.setToken("test-token");
    const { sessionId, sessionDir } = await createSession();
    const bareDir = createBareRemote(sessionDir);

    fs.writeFileSync(path.join(sessionDir, "survives-disposal.txt"), "post-turn commit");

    client.send({ type: "send_message", text: "second turn", sessionId });
    const prevClaude = latestClaude;
    const claude2 = await waitForClaude(() => latestClaude, prevClaude);
    claude2.finish("test-session-1");

    // The session is reclaimed the instant the turn ends — the shape the
    // quota-retry path produced, where the runner left the registry ~150ms
    // before its own post-turn commit landed.
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

  /**
   * The 2026-08-15 incident, end to end. A branch whose history was rewritten
   * (a rebase onto a fresh base after a merge — the flow ShipIt's own agent
   * instructions prescribe) no longer fast-forwards onto its remote, so every
   * unforced post-turn push is rejected. That refusal is correct; its INVISIBILITY
   * is the defect. It reached only the session log ring and a transient WS
   * message, so nine commits stayed local for ten hours and two pull requests
   * merged behind the branch head.
   *
   * The load-bearing assertion is the PERSISTED row: a notice that is merely
   * emitted survives a reconnect and then vanishes on the next reload, which is
   * the same silence wearing a different hat.
   */
  it("persists a transcript notice when the push is rejected as non-fast-forward", { timeout: 15_000 }, async () => {
    await githubAuth.setToken("test-token");
    const { sessionId, sessionDir } = await createSession();
    createBareRemote(sessionDir);

    // Rewrite the branch's history so the remote no longer fast-forwards. This
    // is what a post-merge rebase leaves behind. The message MUST change: an
    // `--amend --no-edit` seconds after the original commit reproduces the same
    // tree, parent, message and committer second, so git hands back the
    // identical SHA and there is no divergence to detect.
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

    // The live half — what an attached viewer sees immediately.
    const notice = messages.find(isNotice);
    expect(notice).toMatchObject({ type: "system_notice", level: "warn", sessionId });
    expect((notice as { message: string }).message).toContain("--force-with-lease");

    // The durable half — what survives the reload. This is the assertion that
    // fails without the fix.
    const persisted = chatHistory.load(sessionId).filter((m) => m.notice && m.text?.includes("diverged"));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.noticeLevel).toBe("warn");

    // ...and no success message was ever claimed for this push.
    expect(messages.find((m) => m.type === "github_push_result" && m.success)).toBeUndefined();
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

    // The push runs on a debounce and then fails, emitting a log entry. Wait
    // for that log rather than draining a fixed quiet period: a bare
    // `drain({ quietMs: 250 })` returns as soon as the stream goes quiet for
    // 250 ms, so on a loaded machine it hands back a buffer that predates the
    // push attempt entirely and `failLog` is undefined. The quiet tail inside
    // `collectUntil` still gives the "no success message" assertion below its
    // let-time-pass window.
    const isFailLog = (m: WsServerMessage) =>
      m.type === "log_append" &&
      m.channel === "agent" &&
      m.records.some((r) => r.text.includes("Auto-push failed"));
    const messages = await client.collectUntil(isFailLog, { quietMs: 250 });

    const failLog = messages.find(isFailLog);
    expect(failLog).toBeDefined();

    // Should NOT have a successful github_push_result
    const pushResult = messages.find((m) => m.type === "github_push_result");
    expect(pushResult).toBeUndefined();
  });
});
