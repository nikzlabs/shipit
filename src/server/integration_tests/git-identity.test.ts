import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { CredentialStore } from "../credential-store.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { GitHubAuthManager } from "../github-auth.js";
import { PreviewManager } from "../preview-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubPreviewManager,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
} from "./test-helpers.js";

describe("Integration: git identity flow", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionDir: string;
  let sessionId: string;
  let sessionManager: SessionManager;
  let origHome: string | undefined;
  let origNoSystem: string | undefined;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-gitid-"));
    sessionId = crypto.randomUUID();
    sessionDir = path.join(tmpDir, "sessions", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(async () => {
    // Restore process.env (in case test set it)
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origNoSystem !== undefined) process.env.GIT_CONFIG_NOSYSTEM = origNoSystem;
    else delete process.env.GIT_CONFIG_NOSYSTEM;

    if (app) await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  /**
   * Create a git repo in the session directory with NO identity configured.
   * Overrides process.env so simple-git child processes ignore global config.
   */
  async function initSessionRepoWithoutIdentity(): Promise<void> {
    origHome = process.env.HOME;
    origNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    process.env.HOME = tmpDir;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    const { execSync } = await import("node:child_process");
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: tmpDir };
    execSync("git init -b main", { cwd: sessionDir, env });
    execSync("git config commit.gpgsign false", { cwd: sessionDir, env });
    // Set temporary identity, commit, then unset so the repo has no persistent identity
    execSync("git config user.name tmp", { cwd: sessionDir, env });
    execSync("git config user.email tmp@tmp", { cwd: sessionDir, env });
    execSync('git commit --allow-empty -m "init"', { cwd: sessionDir, env });
    execSync("git config --unset user.name", { cwd: sessionDir, env });
    execSync("git config --unset user.email", { cwd: sessionDir, env });
  }

  async function startApp(extraDeps?: { credentialStore?: CredentialStore }): Promise<number> {
    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);
    sessionManager.track(sessionId, "Test session", sessionDir);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startPreview: false,
      portScanIntervalMs: 0,
      ...extraDeps,
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    return match ? Number(match[1]) : 0;
  }

  it("sends git_identity_required when activating session with missing identity", async () => {
    await initSessionRepoWithoutIdentity();
    port = await startApp();

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Activate the session — this triggers the per-session identity check
    client.send({ type: "activate_session", sessionId });

    const identityMsg = await client.receiveType("git_identity_required");
    expect(identityMsg.type).toBe("git_identity_required");

    client.close();
  });

  it("does not send git_identity_required when session has identity", async () => {
    const git = new GitManager(sessionDir);
    await git.init({ name: "Test", email: "test@test.com" });
    await git.setIdentity("Test User", "test@example.com");
    port = await startApp();

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Activate the session
    client.send({ type: "activate_session", sessionId });

    // Should not receive git_identity_required — wait briefly to confirm
    // (drain any remaining side-effect messages like preview_status first)
    try {
      while (true) {
        const msg = await client.receive(500);
        expect(msg.type).not.toBe("git_identity_required");
      }
    } catch {
      // Timeout — no more messages, which is the expected outcome
    }

    client.close();
  });

  it("auto-applies stored global identity instead of prompting", async () => {
    await initSessionRepoWithoutIdentity();
    // Pre-populate credential store with identity
    const store = new CredentialStore(tmpDir);
    store.setGitIdentity("Stored User", "stored@example.com");

    port = await startApp({ credentialStore: store });

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Activate the session — should auto-apply, not prompt
    client.send({ type: "activate_session", sessionId });

    // Should receive git_identity_set (auto-applied), NOT git_identity_required
    const msg = await client.receiveType("git_identity_set");
    expect(msg).toMatchObject({
      type: "git_identity_set",
      name: "Stored User",
      email: "stored@example.com",
    });

    // Verify identity is actually configured in the session's git repo
    const git = new GitManager(sessionDir);
    expect(await git.hasIdentity()).toBe(true);

    client.close();
  });

});
