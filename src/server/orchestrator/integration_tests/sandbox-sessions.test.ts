/**
 * docs/211 — integration coverage for the Sandbox session creation route, end to
 * end through `buildApp`:
 *
 *   POST /api/sessions/sandbox
 *
 * Verifies the route stamps the server-authoritative `kind = "sandbox"` and the
 * (normalized) capability set, leaves the session repo-less, and surfaces it in
 * the sidebar list. The branch-op / auto-commit invariant is unit-tested in
 * `ws-handlers/post-turn.test.ts`; here we assert the durable creation contract a
 * parallel effort builds the capability wiring on top of.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { RepoStore } from "../repo-store.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { DatabaseManager } from "../../shared/database.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

describe("Integration: sandbox session creation (docs/211)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-sandbox-"));
    sessionManager = new SessionManager(dbManager);
    const repoStore = new RepoStore(dbManager);
    const credentialStore = createTestCredentialStore(tmpDir);
    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      repoStore,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // ignore cleanup errors
    }
  });

  it("stamps kind=sandbox + the chosen capabilities, repo-less, and lists it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sandbox",
      payload: { capabilities: { git: true, docker: true, network: false } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { session: { id: string; kind: string; remoteUrl: string }; capabilities: unknown };
    expect(body.session.kind).toBe("sandbox");
    expect(body.capabilities).toEqual({ git: true, docker: true, network: false });
    expect(body.session.remoteUrl).toBe("");

    // Server-authoritative + durable: read straight off the session row.
    const persisted = sessionManager.get(body.session.id);
    expect(persisted?.kind).toBe("sandbox");
    expect(persisted?.capabilities).toEqual({ git: true, docker: true, network: false });

    // It shows up in the sidebar list (its own sandbox grouping is client-side).
    expect(sessionManager.list().some((s) => s.id === body.session.id && s.kind === "sandbox")).toBe(true);
  });

  it("defaults to network-on / git+docker-off when no capabilities are sent", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions/sandbox", payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { capabilities: unknown };
    expect(body.capabilities).toEqual({ git: false, docker: false, network: true });
  });

  it("normalizes a partial / junk capability payload against the defaults", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sandbox",
      // Only docker supplied (+ a junk key) — git/network fall back to defaults.
      payload: { capabilities: { docker: true, bogus: "x" } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { capabilities: unknown };
    expect(body.capabilities).toEqual({ git: false, docker: true, network: true });
  });
});
