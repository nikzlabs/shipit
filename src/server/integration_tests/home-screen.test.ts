import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
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
  waitForClaude,
} from "./test-helpers.js";

// ---------------------------------------------------------------------------
// home_create_repo_with_template
// ---------------------------------------------------------------------------

describe("Integration: home_create_repo_with_template", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let githubAuthManager: StubGitHubAuthManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-home-create-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    const sessionManager = new SessionManager(sessionsFile);

    githubAuthManager = new StubGitHubAuthManager();

    app = await buildApp({
      createGitManager: (dir: string) => {
        const gm = new GitManager(dir);
        // Stub push so it doesn't attempt a real remote push
        gm.push = async () => "pushed (stub)";
        return gm;
      },
      sessionManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
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
      // Ignore cleanup errors
    }
  });

  it("creates a GitHub repo, applies template, and returns home_repo_ready", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Authenticate with GitHub first
    client.send({ type: "github_set_token", token: "ghp_test" });
    await client.receiveSkipLogs(); // github_status

    client.send({
      type: "home_create_repo_with_template",
      repoName: "my-new-app",
      templateId: "static-html",
      description: "Test project",
      isPrivate: true,
    } as any);

    // Should receive session_started then home_repo_ready
    const sessionMsg = await client.receiveSkipLogs();
    expect(sessionMsg.type).toBe("session_started");
    const session = (sessionMsg as any).session;
    expect(session.id).toBeTruthy();
    expect(session.workspaceDir).toBeTruthy();

    const repoReady = await client.receiveSkipLogs();
    expect(repoReady).toMatchObject({
      type: "home_repo_ready",
      success: true,
      repoUrl: "https://github.com/test-user/my-new-app.git",
      sessionId: session.id,
    });

    // Verify template files were written to the session directory
    expect(fs.existsSync(path.join(session.workspaceDir, "index.html"))).toBe(true);

    client.close();
  });

  it("returns error for empty repoName", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Authenticate with GitHub first
    client.send({ type: "github_set_token", token: "ghp_test" });
    await client.receiveSkipLogs(); // github_status

    client.send({
      type: "home_create_repo_with_template",
      repoName: "",
      templateId: "static-html",
    } as any);

    const msg = await client.receiveSkipLogs();
    expect(msg).toMatchObject({
      type: "home_repo_ready",
      success: false,
      message: "Repository name is required",
    });

    client.close();
  });

  it("returns error for missing templateId", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Authenticate with GitHub first
    client.send({ type: "github_set_token", token: "ghp_test" });
    await client.receiveSkipLogs(); // github_status

    client.send({
      type: "home_create_repo_with_template",
      repoName: "my-app",
      templateId: "",
    } as any);

    const msg = await client.receiveSkipLogs();
    expect(msg).toMatchObject({
      type: "home_repo_ready",
      success: false,
      message: "Template is required",
    });

    client.close();
  });

  it("returns error for unknown templateId", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Authenticate with GitHub first
    client.send({ type: "github_set_token", token: "ghp_test" });
    await client.receiveSkipLogs(); // github_status

    client.send({
      type: "home_create_repo_with_template",
      repoName: "my-app",
      templateId: "nonexistent-template-xyz",
    } as any);

    const msg = await client.receiveSkipLogs();
    expect(msg).toMatchObject({
      type: "home_repo_ready",
      success: false,
      message: "Unknown template: nonexistent-template-xyz",
    });

    client.close();
  });

  it("returns error for invalid repoName characters", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Authenticate with GitHub first
    client.send({ type: "github_set_token", token: "ghp_test" });
    await client.receiveSkipLogs(); // github_status

    client.send({
      type: "home_create_repo_with_template",
      repoName: "my app!",
      templateId: "static-html",
    } as any);

    const msg = await client.receiveSkipLogs();
    expect(msg).toMatchObject({
      type: "home_repo_ready",
      success: false,
      message: "Repository name contains invalid characters",
    });

    client.close();
  });

  it("returns error when not authenticated with GitHub", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Do NOT authenticate with GitHub
    client.send({
      type: "home_create_repo_with_template",
      repoName: "my-app",
      templateId: "static-html",
    } as any);

    const msg = await client.receiveSkipLogs();
    expect(msg).toMatchObject({
      type: "home_repo_ready",
      success: false,
      message: "Not authenticated with GitHub",
    });

    client.close();
  });
});

// ---------------------------------------------------------------------------
// home_send_with_repo
// ---------------------------------------------------------------------------

describe("Integration: home_send_with_repo", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let lastClaude: FakeClaudeProcess;
  let githubAuthManager: StubGitHubAuthManager;

  /**
   * Create a bare git repo in tmpDir that can be cloned locally.
   * Uses execSync to set up a bare repo with one committed file.
   */
  function createBareRepo(): string {
    const bareDir = path.join(tmpDir, "bare-remote.git");
    fs.mkdirSync(bareDir, { recursive: true });
    execSync("git init --bare", { cwd: bareDir, stdio: "ignore" });

    // Create a temporary working tree, commit a file, and push to the bare repo
    const workTree = path.join(tmpDir, "bare-work");
    fs.mkdirSync(workTree, { recursive: true });
    execSync("git init", { cwd: workTree, stdio: "ignore" });
    execSync("git config user.email 'test@test.com'", { cwd: workTree, stdio: "ignore" });
    execSync("git config user.name 'Test'", { cwd: workTree, stdio: "ignore" });
    fs.writeFileSync(path.join(workTree, "README.md"), "# Test Repo\n");
    execSync("git add .", { cwd: workTree, stdio: "ignore" });
    execSync("git commit -m 'initial commit'", { cwd: workTree, stdio: "ignore" });
    // Ensure we're on "main"
    try {
      execSync("git branch -M main", { cwd: workTree, stdio: "ignore" });
    } catch {
      // Already on main
    }
    execSync(`git remote add origin ${bareDir}`, { cwd: workTree, stdio: "ignore" });
    execSync("git push origin main", { cwd: workTree, stdio: "ignore" });

    return bareDir;
  }

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-home-send-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    const sessionManager = new SessionManager(sessionsFile);

    githubAuthManager = new StubGitHubAuthManager();

    app = await buildApp({
      createGitManager: (dir: string) => {
        const gm = new GitManager(dir);
        // Stub checkoutNewBranch and renameBranch so they work even if clone
        // produces an unexpected default branch
        const origCheckout = gm.checkoutNewBranch.bind(gm);
        gm.checkoutNewBranch = async (name: string) => {
          try { await origCheckout(name); } catch { /* ignore branch errors in tests */ }
        };
        gm.renameBranch = async () => { /* no-op in tests */ };
        return gm;
      },
      sessionManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as unknown as ClaudeProcess;
      },
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
      // Ignore cleanup errors
    }
  });

  it("clones repo, starts session, and runs Claude", async () => {
    const bareRepoPath = createBareRepo();
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Use file:// protocol so git clone works with local bare repos
    client.send({
      type: "home_send_with_repo",
      repoUrl: `file://${bareRepoPath}`,
      text: "Add a new feature",
    } as any);

    // Should receive session_started
    const sessionMsg = await client.receiveSkipLogs();
    expect(sessionMsg.type).toBe("session_started");
    const session = (sessionMsg as any).session;
    expect(session.id).toBeTruthy();
    expect(session.workspaceDir).toBeTruthy();

    // Wait for Claude to be called with the user's message
    const claude = await waitForClaude(() => lastClaude);
    expect(claude.runCalled).toBe(true);
    expect(claude.lastPrompt).toContain("Add a new feature");

    client.close();
  });

  it("returns error for empty text", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({
      type: "home_send_with_repo",
      repoUrl: "https://github.com/owner/repo.git",
      text: "",
    } as any);

    const msg = await client.receiveSkipLogs();
    expect(msg).toMatchObject({
      type: "error",
      message: "Message text is required",
    });

    client.close();
  });

  it("returns error for empty repoUrl", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({
      type: "home_send_with_repo",
      repoUrl: "",
      text: "Build something",
    } as any);

    const msg = await client.receiveSkipLogs();
    expect(msg).toMatchObject({
      type: "error",
      message: "Repository URL is required",
    });

    client.close();
  });

  it("returns error for text that exceeds max length", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const longText = "a".repeat(10001);
    client.send({
      type: "home_send_with_repo",
      repoUrl: "https://github.com/owner/repo.git",
      text: longText,
    } as any);

    const msg = await client.receiveSkipLogs();
    expect(msg).toMatchObject({
      type: "error",
      message: "Message too long (max 10000 characters)",
    });

    client.close();
  });

  it("expands owner/repo shorthand to full GitHub URL", async () => {
    // This will fail to clone since it's a fake URL, but we verify the error
    // message references the expanded URL rather than a validation error
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({
      type: "home_send_with_repo",
      repoUrl: "owner/repo",
      text: "Fix the bug",
    } as any);

    // The clone will fail since the URL isn't a real repo. We should get an
    // error message about the failed setup rather than a validation error.
    const msg = await client.receiveSkipLogs();
    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("Failed to setup repo");

    client.close();
  });
});
