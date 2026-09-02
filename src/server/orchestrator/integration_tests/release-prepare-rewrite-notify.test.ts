/**
 * `shipit release prepare` re-materializes the session's worktree from the
 * orchestrator (`checkout -B` onto the release branch, plus the cherry-picks or
 * the `--from` merge-override), so the route owes the live container an
 * `onWorkspaceRewritten` call — otherwise it keeps running on the pre-prepare
 * `shipit.yaml`, compose file and `node_modules` (nikzlabs/shipit#2429).
 *
 * That call used to sit AFTER `prepareRelease` returned, so it ran only when the
 * release succeeded. But `prepareRelease` rewrites the tree BEFORE most of the
 * ways it can fail — the content-free guard, the no-op-bump 500, the force-push,
 * `agentCreatePr`'s errors, and both release-PR guards all throw once
 * `createBranchFrom` has already checked the release branch out. Those failures
 * left the container stale with nothing anywhere saying so.
 *
 * This drives the real route over HTTP against a real git remote and takes the
 * content-free guard — a routinely-hit, post-rewrite failure — as the witness.
 */

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
import type { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { UsageManager } from "../usage.js";
import type { CredentialStore } from "../credential-store.js";

let tmpDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let client: TestClient;
let latestClaude: FakeClaudeProcess | null = null;
let dbManager: DatabaseManager;
let port: number;
let credentialStore: CredentialStore;
let githubAuth: StubGitHubAuthManager;

beforeEach(async () => {
  dbManager = createTestDatabaseManager();
  tmpDir = fs.mkdtempSync("/tmp/shipit-release-rewrite-test-");
  latestClaude = null;
  credentialStore = createTestCredentialStore(tmpDir);
  githubAuth = new StubGitHubAuthManager();
  // `prepareRelease` refuses unauthenticated up front — which is a PRE-rewrite
  // bail and would make this test pass for the wrong reason.
  await githubAuth.setToken("test-token");

  app = await buildApp({
    credentialStore,
    credentialsDir: path.join(tmpDir, "credentials"),
    workspaceDir: tmpDir,
    agentFactory: () => {
      const c = new FakeClaudeProcess();
      latestClaude = c;
      return c as never;
    },
    authManager: new StubAuthManager() as never,
    githubAuthManager: githubAuth as never,
    sessionManager: new SessionManager(dbManager),
    chatHistoryManager: new ChatHistoryManager(dbManager),
    usageManager: new UsageManager(dbManager),
    serveStatic: false,
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

/** Run one agent turn so the session (and its runner) exist. */
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
  const sessionId = fs.readdirSync(sessionsDir)[0];
  return { sessionId, sessionDir: path.join(sessionsDir, sessionId, "workspace") };
}

/**
 * Give the session a bare remote carrying `main` and a `stable` maintenance
 * branch, plus a package.json for the version source. `stable` is left equal to
 * `main`, which is what makes a bare `prepare patch` content-free.
 */
function setupRemoteWithStable(sessionDir: string): void {
  const env = { ...process.env, HOME: tmpDir };
  const bareDir = path.join(tmpDir, "bare-remote.git");
  fs.mkdirSync(bareDir, { recursive: true });
  execSync("git init --bare -b main", { cwd: bareDir, env });
  execSync(`git remote add origin ${bareDir}`, { cwd: sessionDir, env });

  fs.writeFileSync(
    path.join(sessionDir, "package.json"),
    JSON.stringify({ name: "app", version: "0.2.0" }, null, 2),
  );
  execSync("git add -A && git commit -m 'Add package.json'", { cwd: sessionDir, env });
  execSync("git push -u origin main", { cwd: sessionDir, env });
  execSync("git push origin main:stable", { cwd: sessionDir, env });
}

async function postPrepare(
  sessionId: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: { error?: string } }> {
  const http = await import("node:http");
  const body = JSON.stringify({ bump: "patch", ...extra });
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/release/prepare`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let buf = "";
        res.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: buf ? JSON.parse(buf) : {} });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("Integration: release prepare tells the container its tree was rewritten", () => {
  it("notifies even when prepare fails AFTER rewriting the worktree", async () => {
    const { sessionId, sessionDir } = await createSession();
    setupRemoteWithStable(sessionDir);

    // The runner is the thing `onWorkspaceRewritten` talks to. Both members it
    // touches are optional on the interface, so we attach our own.
    const runner = app.runnerRegistry.get(sessionId);
    expect(runner).toBeDefined();
    const rewrites: string[] = [];
    (runner as { notifyWorkspaceRewritten?: (label: string) => void }).notifyWorkspaceRewritten = (label) => {
      rewrites.push(label);
    };

    // A bare `prepare patch` resets `release/0.2.1` onto `origin/stable` and
    // then refuses as content-free — a failure on the far side of the rewrite.
    const res = await postPrepare(sessionId);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no changes/i);

    // The tree was rewritten regardless of the refusal, so the container must
    // have been told. Before the fix this array was empty.
    expect(rewrites).toEqual(["release-prepare"]);

    // And the rewrite really happened — the refusal is not a pre-rewrite bail.
    const head = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: sessionDir,
      env: { ...process.env, HOME: tmpDir },
    }).toString().trim();
    expect(head).toBe("release/0.2.1");
  });

  /**
   * The other half of the contract, and the reason this isn't an unconditional
   * `finally`. The notification is not free — `reevaluateWorkspaceConfig` can
   * queue a Compose reconcile that clears the service map, poller and log
   * followers, and `notifyWorkspaceRewritten` opens the install gate, tearing
   * down install-gated preview services. Firing it after a failure that never
   * touched the worktree would disrupt a live session for nothing.
   */
  it("does NOT notify when prepare fails before touching the worktree", async () => {
    const { sessionId, sessionDir } = await createSession();
    setupRemoteWithStable(sessionDir);

    const runner = app.runnerRegistry.get(sessionId);
    const rewrites: string[] = [];
    (runner as { notifyWorkspaceRewritten?: (label: string) => void }).notifyWorkspaceRewritten = (label) => {
      rewrites.push(label);
    };

    // `stable` exists, but this run asks for a maintenance branch that doesn't —
    // refused up front, before any `checkout -B`.
    const res = await postPrepare(sessionId, { releaseBranch: "nonexistent" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/doesn't exist on the remote/);

    expect(rewrites).toEqual([]);
    const head = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: sessionDir,
      env: { ...process.env, HOME: tmpDir },
    }).toString().trim();
    expect(head).not.toBe("release/0.2.1");
  });
});
