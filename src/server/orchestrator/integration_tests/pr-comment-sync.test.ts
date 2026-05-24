/**
 * Integration tests for GitHub PR review-comment sync (docs/102).
 *
 * Covers the four write-back routes (reply, resolve, unresolve, submit
 * review). The poller-driven read side ships with docs/133 Phase 4 and has
 * its own tests; these only exercise mutations.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { UsageManager } from "../usage.js";
import { CredentialStore } from "../credential-store.js";
import type { FastifyInstance } from "fastify";

let tmpDir: string;
let app: FastifyInstance;
let githubAuth: StubGitHubAuthManager;
let credentialStore: CredentialStore;
let sessionId: string;
let sessionDir: string;
let sessionManager: SessionManager;
let dbManager: DatabaseManager;

beforeEach(async () => {
  dbManager = createTestDatabaseManager();
  tmpDir = fs.mkdtempSync("/tmp/shipit-pr-comment-sync-test-");

  githubAuth = new StubGitHubAuthManager();

  sessionId = crypto.randomUUID();
  sessionDir = path.join(tmpDir, "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  credentialStore = createTestCredentialStore(tmpDir);
  const git = new GitManager(sessionDir);
  await git.init();

  sessionManager = new SessionManager(dbManager);
  sessionManager.track(sessionId, "Test session", sessionDir);

  app = await buildApp({
    credentialStore,
    workspaceDir: tmpDir,
    createGitManager: (dir: string) => new GitManager(dir),
    agentFactory: () => new FakeClaudeProcess() as never,
    authManager: new StubAuthManager() as never,
    githubAuthManager: githubAuth as never,
    sessionManager,
    chatHistoryManager: new ChatHistoryManager(dbManager),
    usageManager: new UsageManager(dbManager),
    serveStatic: false,
  });
});

afterEach(async () => {
  await app.close();
  dbManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("PR review-thread sync", () => {
  it("requires authentication for replies", async () => {
    // No token set.
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/threads/THREAD_1/reply`,
      payload: { body: "hello" },
    });
    expect(res.statusCode).toBe(401);
    expect(githubAuth.reviewThreadReplyCalls).toHaveLength(0);
  });

  it("returns 404 for unknown session", async () => {
    await githubAuth.setToken("test-token");
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/does-not-exist/pr/threads/THREAD_1/reply`,
      payload: { body: "hello" },
    });
    expect(res.statusCode).toBe(404);
    expect(githubAuth.reviewThreadReplyCalls).toHaveLength(0);
  });

  it("rejects empty reply body with 400", async () => {
    await githubAuth.setToken("test-token");
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/threads/THREAD_1/reply`,
      payload: { body: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(githubAuth.reviewThreadReplyCalls).toHaveLength(0);
  });

  it("posts a reply with the trimmed body and the thread id", async () => {
    await githubAuth.setToken("test-token");
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/threads/PRT_kwDOAB12345/reply`,
      payload: { body: "  thanks for the review!  " },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true });
    expect(githubAuth.reviewThreadReplyCalls).toHaveLength(1);
    expect(githubAuth.reviewThreadReplyCalls[0]).toEqual({
      threadId: "PRT_kwDOAB12345",
      body: "thanks for the review!",
    });
  });

  it("resolves a thread", async () => {
    await githubAuth.setToken("test-token");
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/threads/PRT_kwDOAB12345/resolve`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true });
    expect(githubAuth.reviewThreadResolveCalls).toEqual([{ threadId: "PRT_kwDOAB12345" }]);
  });

  it("unresolves a thread", async () => {
    await githubAuth.setToken("test-token");
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/threads/PRT_kwDOAB12345/unresolve`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true });
    expect(githubAuth.reviewThreadUnresolveCalls).toEqual([{ threadId: "PRT_kwDOAB12345" }]);
  });

  it("propagates GitHub errors as 502", async () => {
    await githubAuth.setToken("test-token");
    githubAuth.setReviewThreadResult({
      success: false,
      message: "Could not resolve thread: not found",
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/threads/MISSING/resolve`,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("not found") });
  });

  it("submits local line comments as one pull request review", async () => {
    await githubAuth.setToken("test-token");
    await new GitManager(sessionDir).addRemote("origin", "https://github.com/user/repo.git");
    githubAuth.setPrData({
      url: "https://github.com/user/repo/pull/7",
      number: 7,
      base: "main",
      title: "My PR",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/review`,
      payload: {
        comments: [
          { path: "src/a.ts", line: 12, body: "  tighten this  " },
          { path: "src/b.ts", line: 3, body: "handle null" },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, count: 2 });
    expect(githubAuth.submitPullRequestReviewCalls).toEqual([
      {
        pullRequestId: "PR_node_1",
        body: "ShipIt review: 2 comments",
        comments: [
          { path: "src/a.ts", line: 12, body: "tighten this", side: "RIGHT" },
          { path: "src/b.ts", line: 3, body: "handle null", side: "RIGHT" },
        ],
      },
    ]);
  });

  it("rejects an empty review batch with 400", async () => {
    await githubAuth.setToken("test-token");
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/review`,
      payload: { comments: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(githubAuth.submitPullRequestReviewCalls).toHaveLength(0);
  });
});
