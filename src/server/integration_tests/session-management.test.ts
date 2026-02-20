import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { PreviewManager } from "../preview-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubPreviewManager,
  StubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
} from "./test-helpers.js";

describe("Integration: Session management", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-session-mgmt-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
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
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors — temp dir will be cleaned by OS
    }
  });

  it("list_sessions returns empty list initially", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "list_sessions" });
    const msg = await client.receive();

    expect(msg.type).toBe("session_list");
    expect((msg as any).sessions).toEqual([]);

    client.close();
  });

  it("new_session returns session list", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "new_session" });
    const msg = await client.receive();

    expect(msg.type).toBe("session_list");

    client.close();
  });

  it("archive_session hides a session from the list", async () => {
    // Pre-populate a session
    sessionManager.track("sess-1", "Test session");

    const client = await TestClient.connect(port);
    await client.receive();

    // Verify it exists
    client.send({ type: "list_sessions" });
    const listMsg = await client.receive();
    expect((listMsg as any).sessions).toHaveLength(1);

    // Archive it
    client.send({ type: "archive_session", sessionId: "sess-1" });
    const archiveMsg = await client.receive();
    expect(archiveMsg.type).toBe("session_list");
    expect((archiveMsg as any).sessions).toHaveLength(0);

    // Session data is still preserved in the manager
    const session = sessionManager.get("sess-1");
    expect(session).toBeDefined();
    expect(session!.archived).toBe(true);

    client.close();
  });

  it("rename_session renames a session and returns updated session", async () => {
    sessionManager.track("sess-1", "Original title");

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "rename_session", sessionId: "sess-1", title: "New title" });
    const msg = await client.receive();

    expect(msg.type).toBe("session_renamed");
    expect((msg as any).session.id).toBe("sess-1");
    expect((msg as any).session.title).toBe("New title");

    // Verify the session was actually renamed in the manager
    const sessions = sessionManager.list();
    expect(sessions[0].title).toBe("New title");

    client.close();
  });

  it("rename_session returns error for non-existent session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "rename_session", sessionId: "nonexistent", title: "Nope" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Session not found");

    client.close();
  });

  it("rename_session rejects empty title", async () => {
    sessionManager.track("sess-1", "Original title");

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "rename_session", sessionId: "sess-1", title: "   " });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Session title cannot be empty");

    // Verify the title was NOT changed
    expect(sessionManager.list()[0].title).toBe("Original title");

    client.close();
  });
});

describe("Integration: list_sessions remoteUrl caching", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-session-remote-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
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
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("list_sessions returns cached remoteUrl from session metadata", async () => {
    sessionManager.track("sess-remote", "My repo", path.join(tmpDir, "sess-remote"));
    sessionManager.setRemoteUrl("sess-remote", "https://github.com/owner/repo.git");

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "list_sessions" });
    const msg = await client.receive();

    expect(msg.type).toBe("session_list");
    const sessions = (msg as any).sessions as Array<{ id: string; remoteUrl?: string }>;
    const session = sessions.find((s) => s.id === "sess-remote");
    expect(session?.remoteUrl).toBe("https://github.com/owner/repo.git");

    client.close();
  });

  it("list_sessions lazy-populates remoteUrl from git config", async () => {
    // Create a real git repo with an origin remote
    const sessionDir = path.join(tmpDir, "sess-git");
    fs.mkdirSync(sessionDir, { recursive: true });
    const git = new GitManager(sessionDir);
    await git.init();
    await git.addRemote("origin", "https://github.com/lazy/populated.git");

    sessionManager.track("sess-git", "Lazy session", sessionDir);
    // No remoteUrl cached yet

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "list_sessions" });
    const msg = await client.receive();

    expect(msg.type).toBe("session_list");
    const sessions = (msg as any).sessions as Array<{ id: string; remoteUrl?: string }>;
    const session = sessions.find((s) => s.id === "sess-git");
    expect(session?.remoteUrl).toBe("https://github.com/lazy/populated.git");

    // Should also be persisted in the manager
    expect(sessionManager.get("sess-git")?.remoteUrl).toBe("https://github.com/lazy/populated.git");

    client.close();
  });

  it("list_sessions handles sessions with missing workspace dirs gracefully", async () => {
    sessionManager.track("sess-missing", "Gone session", path.join(tmpDir, "does-not-exist"));

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "list_sessions" });
    const msg = await client.receive();

    expect(msg.type).toBe("session_list");
    const sessions = (msg as any).sessions as Array<{ id: string; remoteUrl?: string }>;
    const session = sessions.find((s) => s.id === "sess-missing");
    // Should not crash and remoteUrl stays undefined
    expect(session?.remoteUrl).toBeUndefined();

    client.close();
  });

  it("github_set_remote caches remoteUrl in session metadata", async () => {
    // Create a real git session and activate it
    const sessionDir = path.join(tmpDir, "sess-set-remote");
    fs.mkdirSync(sessionDir, { recursive: true });
    const git = new GitManager(sessionDir);
    await git.init();

    sessionManager.track("sess-set-remote", "Set remote session", sessionDir);

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Activate the session
    client.send({ type: "get_chat_history", sessionId: "sess-set-remote" });
    await client.receiveType("file_tree"); // drain all activation messages

    // Set the remote
    client.send({ type: "github_set_remote", name: "origin", url: "https://github.com/cached/url.git" });
    const msg = await client.receive();

    expect(msg.type).toBe("github_remotes");

    // Verify the remoteUrl is cached
    expect(sessionManager.get("sess-set-remote")?.remoteUrl).toBe("https://github.com/cached/url.git");

    client.close();
  });
});
