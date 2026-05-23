import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
  createTestSession,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import type { FastifyInstance } from "fastify";
import type { CredentialStore } from "../credential-store.js";
import type { FileReview, WsReviewUpdated } from "../../shared/types.js";

/**
 * docs/125 — chat-native AI review, full flow. Drives a `send_review_message`
 * turn (which authorizes the review tool for one file), simulates the worker
 * relaying the subagent's `submit_review_comments` call to the
 * `/review-submit` endpoint, and asserts the draft picks up the AI comment and
 * a `review_updated` WS message reaches the connected client.
 */
describe("Integration: chat-native AI review", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess = null as unknown as FakeClaudeProcess;
  let sessionId: string;
  let sessionDir: string;
  const planPath = "docs/012-foo/plan.md";

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as unknown as FakeClaudeProcess;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-chat-native-"));
    sessionManager = new SessionManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as unknown as never;
      },
      credentialStore,
      databaseManager: dbManager,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);

    const created = await createTestSession(sessionManager, tmpDir);
    sessionId = created.sessionId;
    sessionDir = created.sessionDir;
    fs.mkdirSync(path.join(sessionDir, "docs/012-foo"), { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, planPath),
      "# Plan\n\n## Summary\nDo the thing.\n\n## Architecture\nA design.\n",
    );
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore */ }
  });

  it("send_review_message authorizes the tool; submit lands the comment and broadcasts review_updated", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    client.send({ type: "send_review_message", text: "Review it.", sessionId, reviewFilePath: planPath });
    // The review turn starts; the fake agent stays running so the per-turn
    // allow-list (runner.activeReviewFilePath) is set when we submit below.
    await waitForClaude(() => lastClaude);

    // Simulate the worker relaying the subagent's submit_review_comments call.
    const submit = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/review-submit`,
      payload: {
        filePath: planPath,
        comments: [
          { kind: "selection", quoted_text: "A design", text: "Clarify the registry." },
        ],
      },
    });
    expect(submit.statusCode).toBe(200);
    expect((submit.json() as { added: number }).added).toBe(1);

    // The client receives the broadcast with the AI comment.
    const updated = (await client.receiveType("review_updated")) as WsReviewUpdated;
    expect(updated.filePath).toBe(planPath);
    expect(updated.review.comments).toHaveLength(1);
    expect(updated.review.comments[0]!.source).toBe("ai");

    // And the persisted draft reflects it.
    const draft = (await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/file-reviews/draft?filePath=${encodeURIComponent(planPath)}`,
    })).json() as FileReview;
    expect(draft.comments[0]!.source).toBe("ai");

    lastClaude.finish();
    client.close();
  });

  it("rejects a submit for a file other than the authorized one", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    client.send({ type: "send_review_message", text: "Review it.", sessionId, reviewFilePath: planPath });
    await waitForClaude(() => lastClaude);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/review-submit`,
      payload: { filePath: "docs/012-foo/other.md", comments: [] },
    });
    expect(res.statusCode).toBe(403);

    lastClaude.finish();
    client.close();
  });

  it("rejects a submit when no review turn is in progress", async () => {
    // No send_review_message → runner has no activeReviewFilePath (and may not
    // even exist yet). Either way the tool is unauthorized.
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/review-submit`,
      payload: { filePath: planPath, comments: [] },
    });
    expect(res.statusCode).toBe(403);
  });
});
