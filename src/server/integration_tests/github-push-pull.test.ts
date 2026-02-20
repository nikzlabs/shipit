import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
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

describe("Integration: GitHub push, pull & remotes", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionId: string;
  let githubAuthManager: StubGitHubAuthManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-gh-pushpull-"));

    // Pre-create a session directory with its own git repo
    sessionId = crypto.randomUUID();
    const sessionDir = path.join(tmpDir, "sessions", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const git = new GitManager(sessionDir);
    await git.init();

    const sessionsFile = path.join(tmpDir, "sessions.json");
    const sessionManager = new SessionManager(sessionsFile);
    sessionManager.track(sessionId, "Test session", sessionDir);

    githubAuthManager = new StubGitHubAuthManager();

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startPreview: false,
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

    // Activate session so git operations work
    client.send({ type: "get_chat_history", sessionId });
    await client.receiveType("chat_history"); // skip side-effects from activateSession

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

    // Activate session so git operations work
    client.send({ type: "get_chat_history", sessionId });
    await client.receiveType("chat_history"); // skip side-effects from activateSession

    client.send({ type: "github_get_remotes" });
    const msg = await client.receive();

    expect(msg.type).toBe("github_remotes");
    expect((msg as any).remotes).toEqual([]);

    client.close();
  });

  it("github_push with auth but no remote returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Activate session so git operations work
    client.send({ type: "get_chat_history", sessionId });
    await client.receiveType("chat_history"); // skip side-effects from activateSession

    // Authenticate first
    client.send({ type: "github_set_token", token: "ghp_test" });
    await client.receive(); // github_status
    await client.receive(); // github_search_results (user repos)

    // Try to push without a remote configured
    client.send({ type: "github_push" });
    const msg = await client.receive();

    expect(msg.type).toBe("github_push_result");
    expect((msg as any).success).toBe(false);
    expect((msg as any).message).toContain("Push failed");

    client.close();
  });
});
