import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { CredentialStore } from "../credential-store.js";
import { ProviderAccountManager } from "../provider-account-manager.js";

let tmpDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let client: TestClient;
let githubAuth: StubGitHubAuthManager;
let latestClaude: FakeClaudeProcess | null = null;
let allClaudes: FakeClaudeProcess[] = [];
let dbManager: DatabaseManager;
let port: number;
let credentialStore: CredentialStore;
let credentialsDir: string;

beforeEach(async () => {
  dbManager = createTestDatabaseManager();
  tmpDir = fs.mkdtempSync("/tmp/shipit-rebase-flow-test-");
  latestClaude = null;
  allClaudes = [];
  credentialsDir = path.join(tmpDir, "credentials");
  credentialStore = createTestCredentialStore(tmpDir);
  process.env.GIT_EDITOR = "true";

  githubAuth = new StubGitHubAuthManager();

  app = await buildApp({
    credentialStore,
    credentialsDir,
    workspaceDir: tmpDir,
    agentFactory: () => {
      const c = new FakeClaudeProcess();
      latestClaude = c;
      allClaudes.push(c);
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
  port = typeof addr === "object" && addr ? addr.port : 0;
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

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      await client.receive(500);
    } catch {
      break;
    }
  }

  const sessionsDir = path.join(tmpDir, "sessions");
  const entries = fs.readdirSync(sessionsDir);
  const sessionId = entries[0];
  const sessionDir = path.join(sessionsDir, sessionId, "workspace");

  return { sessionId, sessionDir };
}

function setupDivergence(
  sessionDir: string,
  opts: { conflicting: boolean },
): string {
  const env = { ...process.env, HOME: tmpDir };
  const bareDir = path.join(tmpDir, "bare-remote.git");
  fs.mkdirSync(bareDir, { recursive: true });
  execSync("git init --bare -b main", { cwd: bareDir, env });
  execSync(`git remote add origin ${bareDir}`, { cwd: sessionDir, env });

  fs.writeFileSync(path.join(sessionDir, "shared.txt"), "v1\n");
  execSync("git add -A && git commit -m 'Add shared'", { cwd: sessionDir, env });
  execSync("git push -u origin main", { cwd: sessionDir, env });

  execSync("git checkout -b feature", { cwd: sessionDir, env });
  if (opts.conflicting) {
    fs.writeFileSync(path.join(sessionDir, "shared.txt"), "feature edit\n");
  } else {
    fs.writeFileSync(path.join(sessionDir, "feature.txt"), "feature\n");
  }
  execSync("git add -A && git commit -m 'Feature commit'", { cwd: sessionDir, env });
  execSync("git push -u origin feature", { cwd: sessionDir, env });

  const tempClone = path.join(tmpDir, "temp-clone");
  fs.mkdirSync(tempClone, { recursive: true });
  execSync(`git clone ${bareDir} .`, { cwd: tempClone, env });
  execSync("git checkout main", { cwd: tempClone, env });
  if (opts.conflicting) {
    fs.writeFileSync(path.join(tempClone, "shared.txt"), "upstream edit\n");
  } else {
    fs.writeFileSync(path.join(tempClone, "main-only.txt"), "main\n");
  }
  execSync("git add -A && git commit -m 'Upstream commit'", { cwd: tempClone, env });
  execSync("git push", { cwd: tempClone, env });
  fs.rmSync(tempClone, { recursive: true, force: true });

  return bareDir;
}

async function postRebase(sessionId: string, baseBranch = "main"): Promise<{ status: number; body: { status?: string; error?: string } }> {
  const http = await import("node:http");
  const body = JSON.stringify({ baseBranch });
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/git/rebase`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: buf ? JSON.parse(buf) : {},
            });
          } catch (err) { reject(err instanceof Error ? err : new Error(String(err))); }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function collectMessages(timeoutMs = 3000): Promise<WsServerMessage[]> {
  const messages: WsServerMessage[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      messages.push(await client.receive(Math.max(50, deadline - Date.now())));
    } catch {
      break;
    }
  }
  return messages;
}

// A reused process needs a prompt check to distinguish successive turns.
async function waitForPrompt(needle: string, timeoutMs = 5000): Promise<FakeClaudeProcess> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const c = latestClaude;
    if (c?.runCalled && c.lastPrompt.includes(needle)) return c;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for a prompt containing "${needle}"`);
}

async function waitForMessage(type: string, timeoutMs = 5000): Promise<WsServerMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = await client.receive(Math.max(100, deadline - Date.now()));
    if (msg.type === type) return msg;
  }
  throw new Error(`Timed out waiting for "${type}" message`);
}

describe("rebase flow: API + WS events", () => {
  it("returns 404 when no runner exists for the session", async () => {
    const { sessionId } = await createSession();
    const res = await postRebase(`${sessionId  }-bogus`);
    expect(res.status).toBe(404);
  });

  it("clean rebase — emits rebase_started + rebase_complete", { timeout: 20_000 }, async () => {
    await githubAuth.setToken("test-token");
    const { sessionId, sessionDir } = await createSession();
    setupDivergence(sessionDir, { conflicting: false });

    const res = await postRebase(sessionId, "main");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("started");

    await waitForMessage("rebase_started");
    const completeMsg = await waitForMessage("rebase_complete", 8_000);
    expect(completeMsg).toMatchObject({ type: "rebase_complete" });
  });

  it("clean rebase — the next user turn's prompt carries the sync notice, once", { timeout: 25_000 }, async () => {
    await githubAuth.setToken("test-token");
    const { sessionId, sessionDir } = await createSession();
    setupDivergence(sessionDir, { conflicting: false });

    expect((await postRebase(sessionId, "main")).status).toBe(200);
    await waitForMessage("rebase_complete", 8_000);

    client.send({ type: "send_message", text: "carry on" });
    const first = await waitForPrompt("carry on");
    expect(first.lastPrompt).toContain("[System]");
    expect(first.lastPrompt).toContain("origin/main");
    first.finish("test-session-1");

    await collectMessages(500);
    client.send({ type: "send_message", text: "and again" });
    const second = await waitForPrompt("and again");
    expect(second.lastPrompt).not.toContain("[System]");
    second.finish("test-session-1");
  });

  it("clean rebase — the route makes the poller re-read the PR it just un-conflicted", { timeout: 20_000 }, async () => {
    await githubAuth.setToken("test-token");
    const { sessionId, sessionDir } = await createSession();
    setupDivergence(sessionDir, { conflicting: false });

    const poller = app.prStatusPoller;
    if (!poller) throw new Error("buildApp did not decorate a PR status poller");
    const notifyAutoPush = vi.spyOn(poller, "notifyAutoPush");
    const forceRefresh = vi.spyOn(poller, "forceRefreshSession").mockImplementation(async () => {});

    expect((await postRebase(sessionId, "main")).status).toBe(200);
    await waitForMessage("rebase_complete", 8_000);

    expect(notifyAutoPush).toHaveBeenCalledWith(sessionId);
    expect(forceRefresh).toHaveBeenCalledWith(sessionId);
  });

  it("up-to-date branch — emits rebase_complete without rebase_started", { timeout: 20_000 }, async () => {
    const { sessionId, sessionDir } = await createSession();

    const env = { ...process.env, HOME: tmpDir };
    const bareDir = path.join(tmpDir, "bare-remote.git");
    fs.mkdirSync(bareDir, { recursive: true });
    execSync("git init --bare -b main", { cwd: bareDir, env });
    execSync(`git remote add origin ${bareDir}`, { cwd: sessionDir, env });
    execSync("git push -u origin main", { cwd: sessionDir, env });

    const res = await postRebase(sessionId, "main");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("started");

    const messages = await collectMessages(2000);
    const types = messages.map((m) => m.type);
    expect(types).toContain("rebase_complete");
    expect(types).not.toContain("rebase_started");
  });

  it("conflict path — emits rebase_started, rebase_conflicts, then drives agent resolution", { timeout: 20_000 }, async () => {
    await githubAuth.setToken("test-token");
    const { sessionId, sessionDir } = await createSession();
    setupDivergence(sessionDir, { conflicting: true });

    const claudeBeforeRebase = latestClaude;

    const res = await postRebase(sessionId, "main");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("started");

    await waitForMessage("rebase_started");
    const conflictsMsg = await waitForMessage("rebase_conflicts");
    expect(conflictsMsg).toMatchObject({
      type: "rebase_conflicts",
      conflicts: expect.arrayContaining([expect.objectContaining({ path: "shared.txt" })]),
    });

    const conflictAgent = await waitForClaude(() => latestClaude, claudeBeforeRebase);

    fs.writeFileSync(path.join(sessionDir, "shared.txt"), "merged\n");
    conflictAgent.finish("test-session-1");

    const completeMsg = await waitForMessage("rebase_complete", 8_000);
    expect(completeMsg).toMatchObject({ type: "rebase_complete" });

    const finalContent = fs.readFileSync(path.join(sessionDir, "shared.txt"), "utf-8");
    expect(finalContent).not.toContain("<<<<<<<");
    expect(finalContent).toContain("merged");
  });

  it("still tries refusal-benched accounts for the conflict-resolution turn, aborting only after every account refuses (docs/260-turn-level-account-routing reqs 6, 9, 12)", { timeout: 20_000 }, async () => {
    await githubAuth.setToken("test-token");
    const { sessionId, sessionDir } = await createSession();
    setupDivergence(sessionDir, { conflicting: true });

    const accounts = new ProviderAccountManager({ credentialsDir, credentialStore });
    const resetAt = Date.now() + 45 * 60 * 1000;
    for (const label of ["Work", "Personal"]) {
      const acct = accounts.create("anthropic", label);
      accounts.setAccountStatus("anthropic", acct.id, "ready");
      accounts.markAccountExhausted("anthropic", acct.id, resetAt);
    }
    const spawnedBefore = allClaudes.length;
    const claudeBeforeRebase = latestClaude;

    const res = await postRebase(sessionId, "main");
    expect(res.status).toBe(200);

    await waitForMessage("rebase_started");
    await waitForMessage("rebase_conflicts");

    const attempt1 = await waitForClaude(() => latestClaude, claudeBeforeRebase);
    expect(attempt1.lastPrompt.length).toBeGreaterThan(0);

    const quotaError = "You've hit Claude's 5h usage limit. It resets at 2099-01-01T00:00:00.000Z.";
    attempt1.emit("event", { type: "agent_result", error: quotaError, sessionId: "test-session-1" });
    const attempt2 = await waitForClaude(() => latestClaude, attempt1);
    expect(attempt2.lastPrompt).toBe(attempt1.lastPrompt);

    attempt2.emit("event", { type: "agent_result", error: quotaError, sessionId: "test-session-1" });
    const err = await waitForMessage("error", 8_000) as unknown as { message: string };
    expect(err.message).toContain("Every connected account refused this turn for quota");
    expect(err.message).toContain("usage limit");
    await waitForMessage("rebase_aborted", 8_000);
    expect(allClaudes.slice(spawnedBefore).filter((c) => c.runCalled)).toHaveLength(2);
  });

  it("rebase abort endpoint — kills agent, restores tree, emits rebase_aborted", { timeout: 15_000 }, async () => {
    const { sessionId, sessionDir } = await createSession();
    setupDivergence(sessionDir, { conflicting: true });

    const claudeBeforeRebase = latestClaude;
    await postRebase(sessionId, "main");

    await waitForMessage("rebase_started");
    await waitForMessage("rebase_conflicts");
    await waitForClaude(() => latestClaude, claudeBeforeRebase);

    const http = await import("node:http");
    const abortRes = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${port}/api/sessions/${sessionId}/git/rebase/abort`,
        { method: "POST", headers: { "Content-Length": "0" } },
        (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(abortRes.status).toBe(200);

    await waitForMessage("rebase_aborted");

    const env = { ...process.env, HOME: tmpDir };
    const isRebasing = fs.existsSync(path.join(sessionDir, ".git", "rebase-merge")) ||
                       fs.existsSync(path.join(sessionDir, ".git", "rebase-apply"));
    expect(isRebasing).toBe(false);
    const log = execSync("git log --oneline", { cwd: sessionDir, env, encoding: "utf-8" });
    expect(log).toContain("Feature commit");

    // The fake's kill emits no completion; abort must release the turn itself.
    const claudeAtAbort = latestClaude;
    client.send({ type: "send_message", text: "after abort" });
    const postAbortClaude = await waitForClaude(() => latestClaude, claudeAtAbort);
    postAbortClaude.emit("event", { type: "system", subtype: "init", session_id: "test-session-post-abort" });
    postAbortClaude.finish("test-session-post-abort");
  });

  it("dirty workspace — the sync saves the work, then rebases", { timeout: 20_000 }, async () => {
    await githubAuth.setToken("test-token");
    const { sessionId, sessionDir } = await createSession();
    setupDivergence(sessionDir, { conflicting: false });
    const env = { ...process.env, HOME: tmpDir };

    fs.writeFileSync(path.join(sessionDir, "unstaged.txt"), "left behind\n");
    fs.writeFileSync(path.join(sessionDir, "staged.txt"), "already added\n");
    execSync("git add staged.txt", { cwd: sessionDir, env });

    const res = await postRebase(sessionId, "main");
    expect(res.status).toBe(200);

    const completeMsg = await waitForMessage("rebase_complete", 10_000);
    expect(completeMsg).toMatchObject({ type: "rebase_complete" });

    const log = execSync("git log --oneline", { cwd: sessionDir, env, encoding: "utf-8" });
    expect(log).toContain("Save work before syncing with main");
    expect(log).toContain("Upstream commit");
    expect(fs.readFileSync(path.join(sessionDir, "unstaged.txt"), "utf-8")).toBe("left behind\n");
    expect(fs.readFileSync(path.join(sessionDir, "staged.txt"), "utf-8")).toBe("already added\n");
    const tracked = execSync("git ls-files", { cwd: sessionDir, env, encoding: "utf-8" });
    expect(tracked).toContain("unstaged.txt");
    expect(tracked).toContain("staged.txt");
    expect(execSync("git status --porcelain", { cwd: sessionDir, env, encoding: "utf-8" }).trim()).toBe("");
  });
});
