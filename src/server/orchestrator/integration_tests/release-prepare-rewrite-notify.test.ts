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

    const runner = app.runnerRegistry.get(sessionId);
    expect(runner).toBeDefined();
    const rewrites: string[] = [];
    (runner as { notifyWorkspaceRewritten?: (label: string) => void }).notifyWorkspaceRewritten = (label) => {
      rewrites.push(label);
    };

    const res = await postPrepare(sessionId);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no changes/i);

    expect(rewrites).toEqual(["release-prepare"]);

    const head = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: sessionDir,
      env: { ...process.env, HOME: tmpDir },
    }).toString().trim();
    expect(head).toBe("release/0.2.1");
  });

  it("does NOT notify when prepare fails before touching the worktree", async () => {
    const { sessionId, sessionDir } = await createSession();
    setupRemoteWithStable(sessionDir);

    const runner = app.runnerRegistry.get(sessionId);
    const rewrites: string[] = [];
    (runner as { notifyWorkspaceRewritten?: (label: string) => void }).notifyWorkspaceRewritten = (label) => {
      rewrites.push(label);
    };

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
