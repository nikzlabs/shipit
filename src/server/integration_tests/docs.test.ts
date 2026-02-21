import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { PreviewManager } from "../preview-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import type { FastifyInstance } from "fastify";
import {
  StubPreviewManager,
  StubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
  createTestCredentialStore,
} from "./test-helpers.js";

describe("Integration: Docs", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionId: string;
  let sessionDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-docs-"));

    // Create a session with a doc file
    sessionId = crypto.randomUUID();
    sessionDir = path.join(tmpDir, "sessions", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "README.md"), "# Hello\nWorld");

    const sessionsFile = path.join(tmpDir, "sessions.json");
    const sessionManager = new SessionManager(sessionsFile);
    sessionManager.track(sessionId, "Test session", sessionDir);

    const git = new GitManager(sessionDir);
    await git.init({ name: "Test", email: "test@test.com" });

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
      // Ignore cleanup errors — temp dir will be cleaned by OS
    }
  });

  it("list_docs returns markdown files in session workspace", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/docs` });
    expect(res.statusCode).toBe(200);
    expect(res.json().files).toContain("README.md");
  });

  it("get_doc returns file content", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/docs/README.md` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe("README.md");
    expect(body.content).toBe("# Hello\nWorld");
  });

  it("get_doc rejects path traversal", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/docs/..%2F..%2Fetc%2Fpasswd`,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("get_doc returns error for non-existent file", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/docs/does-not-exist.md` });
    expect(res.statusCode).toBe(404);
  });
});
