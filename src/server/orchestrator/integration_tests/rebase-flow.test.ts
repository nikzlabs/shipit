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
let port: number;

beforeEach(async () => {
  dbManager = createTestDatabaseManager();
  tmpDir = fs.mkdtempSync("/tmp/shipit-rebase-flow-test-");
  latestClaude = null;
  // Prevent rebase --continue from opening an editor.
  process.env.GIT_EDITOR = "true";

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
  port = typeof addr === "object" && addr ? addr.port : 0;
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

/** Create a session and run an initial agent turn to set it up. */
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

/**
 * Set up the session with a bare remote and create divergence between
 * the session's branch and origin/main. Returns the bare remote path.
 */
function setupDivergence(
  sessionDir: string,
  opts: { conflicting: boolean },
): string {
  const env = { ...process.env, HOME: tmpDir };
  const bareDir = path.join(tmpDir, "bare-remote.git");
  fs.mkdirSync(bareDir, { recursive: true });
  execSync("git init --bare -b main", { cwd: bareDir, env });
  execSync(`git remote add origin ${bareDir}`, { cwd: sessionDir, env });

  // Push current branch to origin so we have a base.
  execSync("git checkout -b main", { cwd: sessionDir, env });
  fs.writeFileSync(path.join(sessionDir, "shared.txt"), "v1\n");
  execSync("git add -A && git commit -m 'Base commit'", { cwd: sessionDir, env });
  execSync("git push -u origin main", { cwd: sessionDir, env });

  // Create feature branch and add a feature commit.
  execSync("git checkout -b feature", { cwd: sessionDir, env });
  if (opts.conflicting) {
    fs.writeFileSync(path.join(sessionDir, "shared.txt"), "feature edit\n");
  } else {
    fs.writeFileSync(path.join(sessionDir, "feature.txt"), "feature\n");
  }
  execSync("git add -A && git commit -m 'Feature commit'", { cwd: sessionDir, env });
  execSync("git push -u origin feature", { cwd: sessionDir, env });

  // Move main forward via a temp clone so origin/main diverges.
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

/** Issue a POST to start a rebase via HTTP. */
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

/** Drain WS messages up to a timeout. */
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

/** Wait until a message of the given type arrives. */
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
    // Tear down the runner so the rebase endpoint can't find one.
    // (createSession leaves a runner attached, but if we look up a totally
    // non-existent ID we still get 404 from the runner registry check.)
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

  it("up-to-date branch — emits rebase_complete without rebase_started", { timeout: 20_000 }, async () => {
    const { sessionId, sessionDir } = await createSession();

    // Set up a remote where main equals current HEAD — no divergence.
    const env = { ...process.env, HOME: tmpDir };
    const bareDir = path.join(tmpDir, "bare-remote.git");
    fs.mkdirSync(bareDir, { recursive: true });
    execSync("git init --bare -b main", { cwd: bareDir, env });
    execSync(`git remote add origin ${bareDir}`, { cwd: sessionDir, env });
    // Push current HEAD as main.
    execSync("git branch -m main", { cwd: sessionDir, env });
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

    // The driver creates a *new* FakeClaudeProcess via the agent factory.
    // Capture the next instance so we can drive its resolution.
    const claudeBeforeRebase = latestClaude;

    const res = await postRebase(sessionId, "main");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("started");

    // Server emits rebase_started → rebase_conflicts → system_user_message → ...
    await waitForMessage("rebase_started");
    const conflictsMsg = await waitForMessage("rebase_conflicts");
    expect(conflictsMsg).toMatchObject({
      type: "rebase_conflicts",
      conflicts: expect.arrayContaining([expect.objectContaining({ path: "shared.txt" })]),
    });

    // The agent factory was called for the resolution turn — find the new
    // FakeClaudeProcess and have it "resolve" the conflict.
    const conflictAgent = await waitForClaude(() => latestClaude, claudeBeforeRebase);

    // Resolve by writing a clean merged file (must be done in the worktree).
    fs.writeFileSync(path.join(sessionDir, "shared.txt"), "merged\n");
    conflictAgent.finish("test-session-1");

    // Wait for completion event.
    const completeMsg = await waitForMessage("rebase_complete", 8_000);
    expect(completeMsg).toMatchObject({ type: "rebase_complete" });

    // Verify the file is actually merged on disk.
    const finalContent = fs.readFileSync(path.join(sessionDir, "shared.txt"), "utf-8");
    expect(finalContent).not.toContain("<<<<<<<");
    expect(finalContent).toContain("merged");
  });

  it("rebase abort endpoint — kills agent, restores tree, emits rebase_aborted", { timeout: 15_000 }, async () => {
    const { sessionId, sessionDir } = await createSession();
    setupDivergence(sessionDir, { conflicting: true });

    const claudeBeforeRebase = latestClaude;
    await postRebase(sessionId, "main");

    // Wait for rebase to start and conflicts to arrive — the agent is now busy.
    await waitForMessage("rebase_started");
    await waitForMessage("rebase_conflicts");
    await waitForClaude(() => latestClaude, claudeBeforeRebase);

    // Hit the abort endpoint via HTTP.
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

    // The aborted message should appear on the WS.
    await waitForMessage("rebase_aborted");

    // Working tree should no longer be in rebase state.
    const env = { ...process.env, HOME: tmpDir };
    const isRebasing = fs.existsSync(path.join(sessionDir, ".git", "rebase-merge")) ||
                       fs.existsSync(path.join(sessionDir, ".git", "rebase-apply"));
    expect(isRebasing).toBe(false);
    // The original feature commit is restored.
    const log = execSync("git log --oneline", { cwd: sessionDir, env, encoding: "utf-8" });
    expect(log).toContain("Feature commit");
  });
});
