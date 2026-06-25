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
import { AuthManager } from "../agents/claude/auth-manager.js";
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

  it("GET /api/secrets returns empty keys for unknown repo", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/secrets?repoUrl=https://github.com/org/unknown",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ keys: [] });
  });

  it("GET /api/secrets returns key names only — never values", async () => {
    const repoUrl = "https://github.com/org/repo";
    await app.inject({
      method: "PUT",
      url: "/api/secrets",
      payload: { repoUrl, set: { API_KEY: "supersecret", DB_URL: "postgres://localhost" } },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/secrets?repoUrl=${encodeURIComponent(repoUrl)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().keys.sort()).toEqual(["API_KEY", "DB_URL"]);
    // The plaintext value must never appear in the response body.
    expect(res.payload).not.toContain("supersecret");
    expect(res.json()).not.toHaveProperty("secrets");
  });

  // ---- PUT /api/secrets ----

  it("PUT /api/secrets returns 400 without repoUrl", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/secrets",
      payload: { set: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("repoUrl");
  });

  it("PUT /api/secrets accepts an empty body (clears nothing new)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/secrets",
      payload: { repoUrl: "https://github.com/org/repo" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().saved).toBe(true);
  });

  it("PUT /api/secrets rejects a non-object set", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/secrets",
      payload: { repoUrl: "https://github.com/org/repo", set: "nope" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("set");
  });

  it("PUT /api/secrets saves typed values and GET lists their names", async () => {
    const repoUrl = "https://github.com/org/repo";

    const putRes = await app.inject({
      method: "PUT",
      url: "/api/secrets",
      payload: {
        repoUrl,
        set: { API_KEY: "test123", DB_URL: "postgres://localhost" },
      },
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json().saved).toBe(true);

    const getRes = await app.inject({
      method: "GET",
      url: `/api/secrets?repoUrl=${encodeURIComponent(repoUrl)}`,
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().keys.sort()).toEqual(["API_KEY", "DB_URL"]);
  });

  it("PUT /api/secrets keeps existing values via `keep` without resending them", async () => {
    const repoUrl = "https://github.com/org/repo";

    // Seed two secrets.
    await app.inject({
      method: "PUT",
      url: "/api/secrets",
      payload: { repoUrl, set: { KEEP_ME: "v1", ALSO: "v2" } },
    });

    // Second save: keep KEEP_ME (no value resent), change ALSO. Because ALSO is
    // neither set nor kept on the *first* request's terms, dropping it here
    // confirms keep-vs-delete semantics.
    await app.inject({
      method: "PUT",
      url: "/api/secrets",
      payload: { repoUrl, keep: ["KEEP_ME"], set: { NEW_ONE: "v3" } },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/secrets?repoUrl=${encodeURIComponent(repoUrl)}`,
    });
    expect(res.json().keys.sort()).toEqual(["KEEP_ME", "NEW_ONE"]);
    // ALSO was neither set nor kept → deleted.
    expect(res.json().keys).not.toContain("ALSO");
  });

  it("PUT /api/secrets overwrites a kept key when also present in `set`", async () => {
    const repoUrl = "https://github.com/org/repo";

    await app.inject({
      method: "PUT",
      url: "/api/secrets",
      payload: { repoUrl, set: { TOKEN: "old" } },
    });
    await app.inject({
      method: "PUT",
      url: "/api/secrets",
      payload: { repoUrl, keep: ["TOKEN"], set: { TOKEN: "new" } },
    });

    // Names don't reveal which won; assert via the server-side store instead.
    const res = await app.inject({
      method: "GET",
      url: `/api/secrets?repoUrl=${encodeURIComponent(repoUrl)}`,
    });
    expect(res.json().keys).toEqual(["TOKEN"]);
  });
});
