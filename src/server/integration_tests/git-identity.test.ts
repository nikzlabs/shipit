import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { GitHubAuthManager } from "../github-auth.js";
import { ViteManager } from "../vite-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubViteManager,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
} from "./test-helpers.js";

describe("Integration: git identity flow", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let origHome: string | undefined;
  let origNoSystem: string | undefined;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-gitid-"));
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
   * Create a git repo in tmpDir with NO identity configured.
   * Also overrides process.env so simple-git child processes ignore global config.
   */
  async function initRepoWithoutIdentity(): Promise<GitManager> {
    origHome = process.env.HOME;
    origNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    process.env.HOME = tmpDir;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    const { execSync } = await import("node:child_process");
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: tmpDir };
    execSync("git init", { cwd: tmpDir, env });
    execSync("git config commit.gpgsign false", { cwd: tmpDir, env });
    // Set temporary identity, commit, then unset so the repo has no persistent identity
    execSync("git config user.name tmp", { cwd: tmpDir, env });
    execSync("git config user.email tmp@tmp", { cwd: tmpDir, env });
    execSync('git commit --allow-empty -m "init"', { cwd: tmpDir, env });
    execSync("git config --unset user.name", { cwd: tmpDir, env });
    execSync("git config --unset user.email", { cwd: tmpDir, env });
    return new GitManager(tmpDir);
  }

  async function startApp(gitManager: GitManager): Promise<number> {
    const sessionsFile = path.join(tmpDir, "sessions.json");
    app = await buildApp({
      gitManager,
      sessionManager: new SessionManager(sessionsFile),
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startVite: false,
      portScanIntervalMs: 0,
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    return match ? Number(match[1]) : 0;
  }

  it("sends git_identity_required on connect when identity is missing", async () => {
    const gitManager = await initRepoWithoutIdentity();
    port = await startApp(gitManager);

    const client = await TestClient.connect(port);
    const msg1 = await client.receive(); // preview_status
    expect(msg1.type).toBe("preview_status");

    const msg2 = await client.receive(); // git_identity_required
    expect(msg2.type).toBe("git_identity_required");

    client.close();
  });

  it("does not send git_identity_required when identity exists", async () => {
    const gitManager = new GitManager(tmpDir);
    await gitManager.init(); // init() sets identity
    port = await startApp(gitManager);

    const client = await TestClient.connect(port);
    const msg1 = await client.receive(); // preview_status
    expect(msg1.type).toBe("preview_status");

    // Should not receive git_identity_required — wait briefly to confirm
    await expect(client.receive(500)).rejects.toThrow("timed out");

    client.close();
  });

  it("sets git identity and responds with git_identity_set", async () => {
    const gitManager = await initRepoWithoutIdentity();
    port = await startApp(gitManager);

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    await client.receive(); // git_identity_required

    client.send({ type: "set_git_identity", name: "Test User", email: "test@example.com" });
    const resp = await client.receive();
    expect(resp).toMatchObject({
      type: "git_identity_set",
      name: "Test User",
      email: "test@example.com",
    });

    // Verify identity is actually configured
    expect(await gitManager.hasIdentity()).toBe(true);

    client.close();
  });

  it("returns error for empty name", async () => {
    const gitManager = await initRepoWithoutIdentity();
    port = await startApp(gitManager);

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    await client.receive(); // git_identity_required

    client.send({ type: "set_git_identity", name: "", email: "test@example.com" });
    const resp = await client.receive();
    expect(resp).toMatchObject({ type: "error", message: "Git user name cannot be empty" });

    client.close();
  });

  it("returns error for empty email", async () => {
    const gitManager = await initRepoWithoutIdentity();
    port = await startApp(gitManager);

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    await client.receive(); // git_identity_required

    client.send({ type: "set_git_identity", name: "Test", email: "" });
    const resp = await client.receive();
    expect(resp).toMatchObject({ type: "error", message: "Git email cannot be empty" });

    client.close();
  });

  it("returns error for whitespace-only name", async () => {
    const gitManager = await initRepoWithoutIdentity();
    port = await startApp(gitManager);

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    await client.receive(); // git_identity_required

    client.send({ type: "set_git_identity", name: "   ", email: "test@example.com" });
    const resp = await client.receive();
    expect(resp).toMatchObject({ type: "error", message: "Git user name cannot be empty" });

    client.close();
  });
});
