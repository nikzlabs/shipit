/**
 * Integration tests for secrets API routes (GET/PUT /api/secrets).
 *
 * Uses buildApp() to create a real Fastify server with SecretStore backed
 * by an in-memory SQLite database.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { GitManager } from "../../shared/git.js";
import type { FastifyInstance } from "fastify";
import type { DatabaseManager } from "../../shared/database.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { GitHubAuthManager } from "../github-auth.js";
import { CredentialStore } from "../credential-store.js";
import { initGlobalGitConfig } from "../git-config.js";

describe("Integration: Secrets API routes", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-secrets-api-"));
    initGlobalGitConfig(tmpDir);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      credentialStore: new CredentialStore(tmpDir),
      workspaceDir: tmpDir,
      serveStatic: false,
    });
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ---- GET /api/secrets ----

  it("GET /api/secrets returns 400 without repoUrl", async () => {
    const res = await app.inject({ method: "GET", url: "/api/secrets" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("repoUrl");
  });

  it("GET /api/secrets returns empty secrets for unknown repo", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/secrets?repoUrl=https://github.com/org/unknown",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ secrets: {} });
  });

  // ---- PUT /api/secrets ----

  it("PUT /api/secrets returns 400 without repoUrl", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/secrets",
      payload: { secrets: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("repoUrl");
  });

  it("PUT /api/secrets returns 400 without secrets object", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/secrets",
      payload: { repoUrl: "https://github.com/org/repo" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("secrets");
  });

  it("PUT /api/secrets saves and GET /api/secrets retrieves them", async () => {
    const repoUrl = "https://github.com/org/repo";

    const putRes = await app.inject({
      method: "PUT",
      url: "/api/secrets",
      payload: {
        repoUrl,
        secrets: { API_KEY: "test123", DB_URL: "postgres://localhost" },
      },
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json().saved).toBe(true);

    const getRes = await app.inject({
      method: "GET",
      url: `/api/secrets?repoUrl=${encodeURIComponent(repoUrl)}`,
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().secrets).toEqual({
      API_KEY: "test123",
      DB_URL: "postgres://localhost",
    });
  });

  it("PUT /api/secrets replaces previous secrets", async () => {
    const repoUrl = "https://github.com/org/repo";

    await app.inject({
      method: "PUT",
      url: "/api/secrets",
      payload: { repoUrl, secrets: { OLD_KEY: "old" } },
    });

    await app.inject({
      method: "PUT",
      url: "/api/secrets",
      payload: { repoUrl, secrets: { NEW_KEY: "new" } },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/secrets?repoUrl=${encodeURIComponent(repoUrl)}`,
    });
    expect(res.json().secrets).toEqual({ NEW_KEY: "new" });
    expect(res.json().secrets).not.toHaveProperty("OLD_KEY");
  });
});
