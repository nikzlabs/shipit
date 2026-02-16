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

describe("Integration: GitHub auth status & tokens", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let githubAuthManager: StubGitHubAuthManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-gh-status-"));

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
});
