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

describe("Integration: GitHub repo creation", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let githubAuthManager: StubGitHubAuthManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-gh-repo-"));

    const gitManager = new GitManager(tmpDir);
    await gitManager.init();

    const sessionsFile = path.join(tmpDir, "sessions.json");
    const sessionManager = new SessionManager(sessionsFile);

    githubAuthManager = new StubGitHubAuthManager();

    app = await buildApp({
      gitManager,
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
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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
