import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { DatabaseManager } from "../../shared/database.js";
import {
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

describe("Integration: the agent's plugin routes", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionId: string;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-plugin-routes-"));

    sessionId = crypto.randomUUID();
    // Plugin state resolution requires the session's workspace subdirectory.
    const sessionDir = path.join(tmpDir, "sessions", sessionId, "workspace");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "shipit.yaml"), "agent:\n  install: npm ci\n");

    const sessionManager = new SessionManager(dbManager);
    sessionManager.track(sessionId, "Plugin routes", sessionDir);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
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
    } catch { /* best effort */ }
  });

  it("hands the refresh route a refresh hook (req 12)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/plugin/refresh`,
      payload: {},
    });

    expect(res.statusCode, res.body).not.toBe(501);
    expect(res.json()).toMatchObject({ rows: [] });
  });

  it("answers the exec route honestly where there is no container runtime (req 17)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/plugin/exec`,
      payload: { alias: "probe", command: "probe" },
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({
      error: "This runtime cannot run plugin commands (it has no container runtime).",
    });
  });

  it("answers 404 from the handler, not from an unregistered route", async () => {
    const missing = crypto.randomUUID();
    for (const verb of ["refresh", "exec"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${missing}/plugin/${verb}`,
        payload: { alias: "probe", command: "probe" },
      });
      expect(res.statusCode, verb).toBe(404);
      expect(res.json(), verb).toMatchObject({ error: "Session not found" });
    }
  });
});
