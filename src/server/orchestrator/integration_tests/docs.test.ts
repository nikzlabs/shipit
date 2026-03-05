import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";


import type { FastifyInstance } from "fastify";
import {
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

describe("Integration: Docs", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionId: string;
  let sessionDir: string;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-docs-"));

    // Create a session with a doc file
    sessionId = crypto.randomUUID();
    sessionDir = path.join(tmpDir, "sessions", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "README.md"), "# Hello\nWorld");

    const sessionManager = new SessionManager(dbManager);
    sessionManager.track(sessionId, "Test session", sessionDir);

    const credentialStore = createTestCredentialStore(tmpDir);
    const git = new GitManager(sessionDir);
    await git.init();

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
  });

  afterEach(async () => {
    dbManager.close();
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
