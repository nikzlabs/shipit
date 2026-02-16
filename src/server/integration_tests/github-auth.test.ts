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

describe("Integration: GitHub authentication", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let gitManager: GitManager;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess = null as any;
  let githubAuthManager: StubGitHubAuthManager;

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-github-"));

    gitManager = new GitManager(tmpDir);
    await gitManager.init();

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);

    githubAuthManager = new StubGitHubAuthManager();

    app = await buildApp({
      gitManager,
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
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("github_get_status returns unauthenticated by default", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_get_status" });
    const msg = await client.receive();

    expect(msg.type).toBe("github_status");
    expect((msg as any).authenticated).toBe(false);

    client.close();
  });

  it("github_set_token with valid token returns authenticated status", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_set_token", token: "ghp_valid_test_token" });
    const msg = await client.receive();

    expect(msg.type).toBe("github_status");
    expect((msg as any).authenticated).toBe(true);
    expect((msg as any).username).toBe("test-user");

    client.close();
  });

  it("github_set_token with empty token returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_set_token", token: "" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("GitHub token cannot be empty");

    client.close();
  });

  it("github_set_token with whitespace-only token returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_set_token", token: "   " });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("GitHub token cannot be empty");

    client.close();
  });

  it("github_logout clears credentials", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // First authenticate
    client.send({ type: "github_set_token", token: "ghp_test" });
    const authMsg = await client.receive();
    expect((authMsg as any).authenticated).toBe(true);

    // Then logout
    client.send({ type: "github_logout" });
    const logoutMsg = await client.receive();

    expect(logoutMsg.type).toBe("github_status");
    expect((logoutMsg as any).authenticated).toBe(false);

    client.close();
  });

  it("github_push without auth returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_push" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Not authenticated with GitHub");

    client.close();
  });

  it("github_pull without auth returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_pull" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Not authenticated with GitHub");

    client.close();
  });

  it("github_set_remote adds a remote and returns remotes list", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_set_remote", name: "origin", url: "https://github.com/test/repo.git" });
    const msg = await client.receive();

    expect(msg.type).toBe("github_remotes");
    expect((msg as any).remotes).toHaveLength(1);
    expect((msg as any).remotes[0]).toMatchObject({
      name: "origin",
      url: "https://github.com/test/repo.git",
    });

    client.close();
  });

  it("github_set_remote rejects empty name", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_set_remote", name: "", url: "https://github.com/test/repo.git" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Remote name and URL are required");

    client.close();
  });

  it("github_set_remote rejects empty url", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_set_remote", name: "origin", url: "" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Remote name and URL are required");

    client.close();
  });

  it("github_get_remotes returns empty list initially", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_get_remotes" });
    const msg = await client.receive();

    expect(msg.type).toBe("github_remotes");
    expect((msg as any).remotes).toEqual([]);

    client.close();
  });

  it("github_push with auth but no remote returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Authenticate first
    client.send({ type: "github_set_token", token: "ghp_test" });
    await client.receive(); // github_status

    // Try to push without a remote configured
    client.send({ type: "github_push" });
    const msg = await client.receive();

    expect(msg.type).toBe("github_push_result");
    expect((msg as any).success).toBe(false);
    expect((msg as any).message).toContain("Push failed");

    client.close();
  });

  it("github_create_repo creates a repo and auto-configures remote", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Authenticate first
    client.send({ type: "github_set_token", token: "ghp_test" });
    await client.receive(); // github_status

    client.send({ type: "github_create_repo", name: "my-project", description: "A test project", isPrivate: true });
    const msg = await client.receive();

    expect(msg.type).toBe("github_repo_created");
    expect((msg as any).success).toBe(true);
    expect((msg as any).name).toBe("my-project");
    expect((msg as any).fullName).toBe("test-user/my-project");
    expect((msg as any).url).toBe("https://github.com/test-user/my-project");

    client.close();
  });

  it("github_create_repo without auth returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_create_repo", name: "my-project" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Not authenticated with GitHub");

    client.close();
  });

  it("github_create_repo with empty name returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Authenticate first
    client.send({ type: "github_set_token", token: "ghp_test" });
    await client.receive(); // github_status

    client.send({ type: "github_create_repo", name: "" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Repository name is required");

    client.close();
  });

  it("github_create_repo with invalid characters returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Authenticate first
    client.send({ type: "github_set_token", token: "ghp_test" });
    await client.receive(); // github_status

    client.send({ type: "github_create_repo", name: "my project!" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Repository name contains invalid characters");

    client.close();
  });
});
