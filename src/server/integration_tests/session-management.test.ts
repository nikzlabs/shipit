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
  createTestCredentialStore,
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
      credentialStore: createTestCredentialStore(tmpDir),
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

  it("bootstrap returns empty session list initially", async () => {
    const res = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions).toEqual([]);
  });

  it("new_session returns session list", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "new_session" });
    const msg = await client.receive();

    expect(msg.type).toBe("session_list");

    client.close();
  });

});

describe("Integration: bootstrap sessions remoteUrl caching", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-session-remote-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
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

  it("bootstrap returns cached remoteUrl from session metadata", async () => {
    sessionManager.track("sess-remote", "My repo", path.join(tmpDir, "sess-remote"));
    sessionManager.setRemoteUrl("sess-remote", "https://github.com/owner/repo.git");

    const res = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(res.statusCode).toBe(200);
    const sessions = res.json().sessions as Array<{ id: string; remoteUrl?: string }>;
    const session = sessions.find((s) => s.id === "sess-remote");
    expect(session?.remoteUrl).toBe("https://github.com/owner/repo.git");
  });

  it("bootstrap lazy-populates remoteUrl from git config", async () => {
    // Create a real git repo with an origin remote
    const sessionDir = path.join(tmpDir, "sess-git");
    fs.mkdirSync(sessionDir, { recursive: true });
    const git = new GitManager(sessionDir);
    await git.init();
    await git.addRemote("origin", "https://github.com/lazy/populated.git");

    sessionManager.track("sess-git", "Lazy session", sessionDir);
    // No remoteUrl cached yet

    const res = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(res.statusCode).toBe(200);
    const sessions = res.json().sessions as Array<{ id: string; remoteUrl?: string }>;
    const session = sessions.find((s) => s.id === "sess-git");
    expect(session?.remoteUrl).toBe("https://github.com/lazy/populated.git");

    // Should also be persisted in the manager
    expect(sessionManager.get("sess-git")?.remoteUrl).toBe("https://github.com/lazy/populated.git");
  });

  it("bootstrap handles sessions with missing workspace dirs gracefully", async () => {
    sessionManager.track("sess-missing", "Gone session", path.join(tmpDir, "does-not-exist"));

    const res = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(res.statusCode).toBe(200);
    const sessions = res.json().sessions as Array<{ id: string; remoteUrl?: string }>;
    const session = sessions.find((s) => s.id === "sess-missing");
    // Should not crash and remoteUrl stays undefined
    expect(session?.remoteUrl).toBeUndefined();
  });

});
