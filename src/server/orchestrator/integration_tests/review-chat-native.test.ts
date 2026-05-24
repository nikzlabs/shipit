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
import type { AgentReview, WsAgentReviewAdded } from "../../shared/types.js";

/**
 * docs/125 + docs/151 — chat-native review write-back, full flow. Drives a
 * `send_review_message` turn (which authorizes the review tool for one file),
 * simulates the worker relaying the subagent's `submit_review_comments` call
 * to the `/review-submit` endpoint, and asserts:
 *   - an `agent_reviews` row is persisted with the snapshot,
 *   - the human draft for the file is untouched,
 *   - an `agent_review_added` WS card lands on the connected client,
 *   - the tool response includes the rendered structured findings.
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

  it("send_review_message authorizes the tool; submit creates an agent_review row and broadcasts the card", async () => {
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
    const body = submit.json() as { added: number; reviewId: string; rendered: string };
    expect(body.added).toBe(1);
    expect(body.reviewId).toBeTruthy();
    // The tool response carries the rendered structured findings — the subagent
    // is instructed to echo this verbatim to the parent.
    expect(body.rendered).toContain("Review of docs/012-foo/plan.md");
    expect(body.rendered).toContain("«A design»");
    expect(body.rendered).toContain("Clarify the registry.");

    // The client receives an agent_review_added card.
    const added = (await client.receiveType("agent_review_added")) as WsAgentReviewAdded;
    expect(added.filePath).toBe(planPath);
    expect(added.findingCount).toBe(1);
    expect(added.reviewId).toBe(body.reviewId);

    // No human draft was created for this file — AI findings live in their own
    // immutable storage path now, not the human-draft bucket.
    const draftRes = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/file-reviews/draft?filePath=${encodeURIComponent(planPath)}`,
    });
    expect(draftRes.statusCode).toBe(404);

    // And the GET endpoint returns the persisted snapshot + comments.
    const fetched = (await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/agent-reviews/${body.reviewId}`,
    })).json() as AgentReview;
    expect(fetched.snapshotContent).toContain("## Architecture");
    expect(fetched.comments).toHaveLength(1);

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

  it("accepts a submit when no explicit review turn is in progress", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/review-submit`,
      payload: {
        filePath: planPath,
        comments: [
          { kind: "selection", quoted_text: "Do the thing", text: "Make the outcome testable." },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reviewId: string; findingCount: number };
    expect(body.findingCount).toBe(1);

    // The human draft endpoint still returns 404 — AI submissions don't land in
    // the draft bucket post-docs/151.
    const draftRes = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/file-reviews/draft?filePath=${encodeURIComponent(planPath)}`,
    });
    expect(draftRes.statusCode).toBe(404);

    // But the agent-review GET endpoint returns the persisted row.
    const fetched = (await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/agent-reviews/${body.reviewId}`,
    })).json() as AgentReview;
    expect(fetched.comments).toHaveLength(1);
  });

  it("normal agent turns can submit review comments and broadcast the card", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    client.send({ type: "send_message", text: "Review the plan.", sessionId });
    await waitForClaude(() => lastClaude);

    const submit = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/review-submit`,
      payload: {
        filePath: planPath,
        comments: [
          { kind: "selection", quoted_text: "A design", text: "Tie this to the data flow." },
        ],
      },
    });
    expect(submit.statusCode).toBe(200);

    const added = (await client.receiveType("agent_review_added")) as WsAgentReviewAdded;
    expect(added.filePath).toBe(planPath);
    expect(added.findingCount).toBe(1);

    lastClaude.finish();
    client.close();
  });

  it("the empty-array signal still creates a row and a card with 'no findings'", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    client.send({ type: "send_message", text: "Review the plan.", sessionId });
    await waitForClaude(() => lastClaude);

    const submit = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/review-submit`,
      payload: { filePath: planPath, comments: [] },
    });
    expect(submit.statusCode).toBe(200);
    const body = submit.json() as { rendered: string; findingCount: number };
    expect(body.findingCount).toBe(0);
    expect(body.rendered).toContain("no findings");

    const added = (await client.receiveType("agent_review_added")) as WsAgentReviewAdded;
    expect(added.findingCount).toBe(0);

    lastClaude.finish();
    client.close();
  });

  it("rejects a payload with a bare-string item by naming the index in the error", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/review-submit`,
      payload: { filePath: planPath, comments: ["just a string"] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("Comment at index 0 is not an object");
  });

});
