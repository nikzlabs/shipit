import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { DatabaseManager } from "../../shared/database.js";
import {
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

describe("Integration: POST /api/sessions/:id/agent/own-turn (planning#639)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-own-turn-route-"));
    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const report = (sessionId: string) =>
    app.inject({ method: "POST", url: `/api/sessions/${sessionId}/agent/own-turn`, payload: {} });

  // The agent in the container can call this route too, and a runner starts Compose services.
  it("makes no runner when no worker reports a turn in flight", async () => {
    const created = await app.inject({ method: "POST", url: "/api/_test/sessions", payload: { title: "Own turn" } });
    const { sessionId } = created.json<{ sessionId: string }>();
    app.runnerRegistry.dispose(sessionId, { force: true });
    expect(app.runnerRegistry.get(sessionId)).toBeUndefined();

    const res = await report(sessionId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ following: false });
    expect(app.runnerRegistry.get(sessionId)).toBeUndefined();
  });
});
