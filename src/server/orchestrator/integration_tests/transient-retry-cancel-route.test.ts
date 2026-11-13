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

describe("Integration: cancel a waiting automatic continuation (docs/342-transient-provider-retry reqs 9-11)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-transient-cancel-"));
    sessionManager = new SessionManager(dbManager);
    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
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

  const cancel = (sessionId: string) =>
    app.inject({ method: "POST", url: `/api/sessions/${sessionId}/agent/transient-retry/cancel`, payload: {} });

  it("cancels it for a session with no runner, and the row stops showing it", async () => {
    const created = await app.inject({ method: "POST", url: "/api/_test/sessions", payload: { title: "Waiting" } });
    const { sessionId } = created.json<{ sessionId: string }>();
    app.runnerRegistry.dispose(sessionId, { force: true });
    sessionManager.setQuotaResume(sessionId, {
      agentId: "claude",
      cause: "transient",
      lastUsedAt: sessionManager.get(sessionId)!.lastUsedAt,
      wakeAttempts: 0,
      notBefore: new Date(Date.now() + 30_000).toISOString(),
      transientRetry: 1,
    });
    expect(sessionManager.get(sessionId)!.transientRetryAt).toBeDefined();

    const res = await cancel(sessionId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cancelled: true });
    expect(sessionManager.getQuotaResume(sessionId)).toBeUndefined();
    expect(sessionManager.get(sessionId)!.transientRetryAt).toBeUndefined();
    expect(app.runnerRegistry.get(sessionId)).toBeUndefined();
    expect((await cancel(sessionId)).json()).toEqual({ cancelled: false });
  });

  it("answers 404 for an unknown session", async () => {
    expect((await cancel("no-such-session")).statusCode).toBe(404);
  });
});
