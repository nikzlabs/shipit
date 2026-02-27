import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";

import { ClaudeProcess } from "../claude.js";

import type { FastifyInstance } from "fastify";
import {
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
} from "./test-helpers.js";

describe("Integration: Git operations", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionDir: string;
  let sessionManager: SessionManager;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-ops-"));

    // Pre-create a session directory with its own git repo
    sessionId = crypto.randomUUID();
    sessionDir = path.join(tmpDir, "sessions", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const credentialStore = createTestCredentialStore(tmpDir);
    const git = new GitManager(sessionDir);
    await git.init();

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);
    sessionManager.track(sessionId, "Test session", sessionDir);

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    await app.listen({ port: 0, host: "127.0.0.1" });
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

  it("GET /api/sessions/:id/git/log returns commit history", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/git/log` });
    expect(res.statusCode).toBe(200);
    const commits = res.json().commits;
    expect(commits.length).toBeGreaterThanOrEqual(1);
    expect(commits[0].message).toBe("Initial commit");
  });

  it("GET /api/sessions/:id/git/log returns 404 for missing session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/nonexistent/git/log" });
    expect(res.statusCode).toBe(404);
  });

});
