import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { ViteManager } from "../vite-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubViteManager,
  StubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
} from "./test-helpers.js";

describe("Integration: Git operations", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionDir: string;
  let sessionManager: SessionManager;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-ops-"));

    // Pre-create a session directory with its own git repo
    sessionId = crypto.randomUUID();
    sessionDir = path.join(tmpDir, "sessions", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const git = new GitManager(sessionDir);
    await git.init();

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);
    sessionManager.track(sessionId, "Test session", sessionDir);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startVite: false,
      portScanIntervalMs: 0,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors — temp dir will be cleaned by OS
    }
  });

  it("get_git_log returns commit history for active session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Activate the session so git operations target the session dir
    client.send({ type: "get_chat_history", sessionId });
    await client.receive(); // chat_history response

    client.send({ type: "get_git_log" });
    const msg = await client.receive();

    expect(msg.type).toBe("git_log");
    const commits = (msg as any).commits;
    expect(commits.length).toBeGreaterThanOrEqual(1);
    expect(commits[0].message).toBe("Initial commit");

    client.close();
  });

  it("get_git_log returns error when no session is active", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "get_git_log" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("git");

    client.close();
  });

  it("rollback resets to a previous commit within session", async () => {
    // Create a file and commit it in the session directory
    const git = new GitManager(sessionDir);
    fs.writeFileSync(path.join(sessionDir, "rollback-test.txt"), "original");
    await git.autoCommit("Add rollback-test");

    const log = await git.log();
    const initialHash = log[log.length - 1].hash; // "Initial commit"

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Activate the session
    client.send({ type: "get_chat_history", sessionId });
    await client.receive(); // chat_history response

    client.send({ type: "rollback", commitHash: initialHash });
    const msg = await client.receive();

    expect(msg.type).toBe("rollback_complete");
    expect((msg as any).commitHash).toBe(initialHash);

    // File should be gone after rollback (in session dir)
    expect(fs.existsSync(path.join(sessionDir, "rollback-test.txt"))).toBe(false);

    client.close();
  });
});
