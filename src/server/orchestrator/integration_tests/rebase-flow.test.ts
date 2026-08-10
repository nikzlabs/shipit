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
import { CredentialStore } from "../credential-store.js";
import { ProviderAccountManager } from "../provider-account-manager.js";

let tmpDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let client: TestClient;
let githubAuth: StubGitHubAuthManager;
let latestClaude: FakeClaudeProcess | null = null;
/** Every FakeClaudeProcess the app created, in order. */
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
  // Prevent rebase --continue from opening an editor.
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

  // The session is already on `main` (git.init() creates it). Add a base
  // commit with shared.txt so the conflicting case can edit it on both sides,
  // then push as origin/main.
  fs.writeFileSync(path.join(sessionDir, "shared.txt"), "v1\n");
  execSync("git add -A && git commit -m 'Add shared'", { cwd: sessionDir, env });
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

/**
 * Wait until the agent has been run with a prompt containing `needle`.
 *
 * `waitForClaude`'s "not this instance" form doesn't fit here: the orchestrator
 * may reuse the same process across turns, so identity can't distinguish turn N
 * from turn N+1. The prompt text can.
 */
async function waitForPrompt(needle: string, timeoutMs = 5000): Promise<FakeClaudeProcess> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const c = latestClaude;
    if (c?.runCalled && c.lastPrompt.includes(needle)) return c;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for a prompt containing "${needle}"`);
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

  // docs/221 — the user-visible half of a manual sync (the "Synced with main"
  // card) already worked; the agent was never told. A sync runs with no turn in
  // flight, so the notice is parked on the session and delivered by the next
  // turn's prompt — this asserts the whole round trip, not just the DB write.
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

    // Delivered exactly once: the consume is read-and-clear, so a second turn
    // must not re-litigate a sync the agent already heard about.
    await collectMessages(500);
    client.send({ type: "send_message", text: "and again" });
    const second = await waitForPrompt("and again");
    expect(second.lastPrompt).not.toContain("[System]");
    second.finish("test-session-1");
  });

  it("up-to-date branch — emits rebase_complete without rebase_started", { timeout: 20_000 }, async () => {
    const { sessionId, sessionDir } = await createSession();

    // Set up a remote where main equals current HEAD — no divergence.
    // Session is already on `main` from git.init(); just add a remote and push.
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

  // docs/260 reqs 6, 9, 12 — the conflict-resolution turn is a system turn on
  // the shared dispatch path (`runner.dispatch` → `runDispatchedTurn` →
  // `executeAgentTurn`), so it takes the same per-turn account selection and
  // attempt loop a user-typed turn does. Under docs/150 this scenario was a
  // preflight block ("no CLI ever spawns"); docs/260 inverts it: refusal
  // memory alone must never stop the turn (req 5) — the optimistic first
  // selection still returns a refusal-blocked account (req 12) and the turn
  // runs on it (req 9's try-once). Only after every account has actually
  // refused THIS turn does the resolution fail — with the provider's own
  // words (req 6) — and the rebase reports the failure instead of silently
  // hanging on a resolution turn that will never happen.
  it("still tries refusal-benched accounts for the conflict-resolution turn, aborting only after every account refuses (docs/260 reqs 6, 9, 12)", { timeout: 20_000 }, async () => {
    await githubAuth.setToken("test-token");
    const { sessionId, sessionDir } = await createSession();
    setupDivergence(sessionDir, { conflicting: true });

    // Both connected Claude subscriptions carry refusal memory by the time the
    // rebase needs an agent (`exhaustedUntil` + `exhaustedAt`, the shape
    // `refusalBlockedUntil` honours).
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

    // reqs 9, 12 — the benched account is still TRIED: a CLI spawns and is
    // handed the conflict prompt. Blocking here (the docs/150 behavior) is the
    // regression this test now guards against.
    const attempt1 = await waitForClaude(() => latestClaude, claudeBeforeRebase);
    expect(attempt1.lastPrompt.length).toBeGreaterThan(0);

    // The provider itself refuses → the attempt loop re-runs the resolution
    // turn on the second account, same conflict prompt.
    const quotaError = "You've hit Claude's 5h usage limit. It resets at 2099-01-01T00:00:00.000Z.";
    attempt1.emit("event", { type: "agent_result", error: quotaError, sessionId: "test-session-1" });
    const attempt2 = await waitForClaude(() => latestClaude, attempt1);
    expect(attempt2.lastPrompt).toBe(attempt1.lastPrompt);

    // The second account refuses too — every candidate is in the turn's
    // attempt ledger, so the turn fails with the provider's refusals (req 6)...
    attempt2.emit("event", { type: "agent_result", error: quotaError, sessionId: "test-session-1" });
    const err = await waitForMessage("error", 8_000) as unknown as { message: string };
    expect(err.message).toContain("Every connected account refused this turn for quota");
    expect(err.message).toContain("usage limit");
    // ...and the rebase reports the failure instead of hanging.
    await waitForMessage("rebase_aborted", 8_000);
    // The ledger bounds the loop: exactly one real attempt per account.
    expect(allClaudes.slice(spawnedBefore).filter((c) => c.runCalled)).toHaveLength(2);
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

    // planning#338 — the abort explicitly settles the resolution turn the flow was
    // awaiting (the fake CLI's kill, like a container kill whose terminal SSE
    // is dropped once the slot clears, never reports completion on its own).
    // Without that settle the flow's session hold is never released and every
    // later message queues forever. The proof is end-to-end: a new message
    // must spawn a fresh agent turn, not sit in the queue.
    const claudeAtAbort = latestClaude;
    client.send({ type: "send_message", text: "after abort" });
    const postAbortClaude = await waitForClaude(() => latestClaude, claudeAtAbort);
    postAbortClaude.emit("event", { type: "system", subtype: "init", session_id: "test-session-post-abort" });
    postAbortClaude.finish("test-session-post-abort");
  });
});
