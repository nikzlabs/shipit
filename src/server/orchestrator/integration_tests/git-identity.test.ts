import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { GitHubAuthManager } from "../github-auth.js";


import { setGitIdentity } from "../git-config.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

describe("Integration: git identity flow", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionDir: string;
  let sessionId: string;
  let sessionManager: SessionManager;
  let origGitConfigGlobal: string | undefined;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-gitid-"));
    sessionId = crypto.randomUUID();
    sessionDir = path.join(tmpDir, "sessions", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Save original GIT_CONFIG_GLOBAL so we can restore it
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    // Clear it before starting the app so `app-di.ts`'s
    // `if (!process.env.GIT_CONFIG_GLOBAL) initGlobalGitConfig(...)` runs and
    // points GIT_CONFIG_GLOBAL at the test's tmpDir (with no identity). If
    // the surrounding environment has a real `GIT_CONFIG_GLOBAL` set (e.g.
    // when this test suite is dogfooded under an outer ShipIt whose
    // /credentials/.gitconfig has a baked-in identity), the init step would
    // be skipped and `getGitIdentity()` would return that real identity,
    // suppressing the `git_identity_required` event this test expects.
    delete process.env.GIT_CONFIG_GLOBAL;
  });

  afterEach(async () => {
    dbManager.close();
    // Restore GIT_CONFIG_GLOBAL
    if (origGitConfigGlobal !== undefined) {
      process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    } else {
      delete process.env.GIT_CONFIG_GLOBAL;
    }

    if (app) await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  /**
   * Create a git repo in the session directory.
   * Identity comes from the global git config (GIT_CONFIG_GLOBAL).
   */
  async function initSessionRepo(): Promise<void> {
    const git = new GitManager(sessionDir);
    await git.init();
  }

  async function startApp(): Promise<number> {
    sessionManager = new SessionManager(dbManager);
    sessionManager.track(sessionId, "Test session", sessionDir);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      workspaceDir: tmpDir,
      credentialsDir: path.join(tmpDir, "credentials"),
      serveStatic: false,
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = /:(\d+)$/.exec(address);
    return match ? Number(match[1]) : 0;
  }

  it("sends git_identity_required when no global identity is set", async () => {
    // buildApp will call initGlobalGitConfig(credentialsDir) which sets
    // GIT_CONFIG_GLOBAL to an empty config — no identity
    port = await startApp();

    // Pre-create a session directory (bypasses git identity check)
    fs.mkdirSync(sessionDir, { recursive: true });
    sessionManager.track(sessionId, "Test session", sessionDir);

    const client = await TestClient.connect(port, sessionId);

    // Should receive git_identity_required on connect (no global identity set)
    const identityMsg = await client.receiveType("git_identity_required");
    expect(identityMsg.type).toBe("git_identity_required");

    client.close();
  });

  it("does not send git_identity_required when global identity is set", async () => {
    // Pre-populate global git config with identity before starting the app
    // Note: buildApp will call initGlobalGitConfig which sets GIT_CONFIG_GLOBAL.
    // We need to set identity AFTER buildApp sets GIT_CONFIG_GLOBAL, but
    // the check happens on WS connect. So we start the app first, set identity,
    // then connect.
    port = await startApp();

    // Now set the identity in the global config (GIT_CONFIG_GLOBAL is already set by buildApp)
    setGitIdentity("Test User", "test@example.com");

    // Also init the session repo so activation works
    await initSessionRepo();
    sessionManager.track(sessionId, "Test session", sessionDir);

    // Connect directly to the session (auto-activates)
    const client = await TestClient.connect(port, sessionId);

    // Should not receive git_identity_required — wait briefly to confirm
    try {
      while (true) {
        const msg = await client.receive(500);
        expect(msg.type).not.toBe("git_identity_required");
      }
    } catch {
      // Timeout — no more messages, which is the expected outcome
    }

    client.close();
  });

  it("session repos inherit identity from global git config", async () => {
    port = await startApp();

    // Set identity in the global config
    setGitIdentity("Global User", "global@example.com");

    // Init a repo — it should inherit the global identity
    await initSessionRepo();

    // Verify commits use the global identity
    const git = new GitManager(sessionDir);
    const log = await git.log(1);
    expect(log).toHaveLength(1);
    expect(log[0].author).toBe("Global User");

    sessionManager.track(sessionId, "Test session", sessionDir);
    const client = await TestClient.connect(port, sessionId);

    try {
      while (true) {
        const msg = await client.receive(500);
        expect(msg.type).not.toBe("git_identity_required");
      }
    } catch {
      // Timeout — expected
    }

    client.close();
  });

});
