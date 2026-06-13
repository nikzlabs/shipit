import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
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
import type { AiReviewCard, WsAiReviewAdded } from "../../shared/types.js";

/**
 * docs/203 — plain-text AI review write-back, full flow. Drives a
 * `send_review_message` turn (which authorizes the review tool for one file),
 * simulates the worker relaying the parent's `submit_review` markdown call to
 * the `/review-submit` endpoint, and asserts:
 *   - one persisted `ai_review_added` review card lands on the connected client,
 *   - the human draft for the file is untouched (decoupled — docs/203),
 *   - the tool is callable ONLY inside a review turn, for ONLY that file,
 *   - the re-review submit PATCHES the same card (no duplicate, `reReviewed`),
 *   - the reviewer label (cross-agent / fallback) flows through to the card.
 */
describe("Integration: plain-text AI review", () => {
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

  const submitReview = (payload: { filePath: string; markdown: string; reviewerLabel?: string }) =>
    app.inject({ method: "POST", url: `/api/sessions/${sessionId}/review-submit`, payload });

  const historyAiReviews = async (): Promise<AiReviewCard[]> => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const body = res.json() as { messages: { aiReview?: AiReviewCard }[] };
    return body.messages.map((m) => m.aiReview).filter((c): c is AiReviewCard => !!c);
  };

  it("authorizes the tool; a markdown submit records one review card and broadcasts it", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    client.send({ type: "send_review_message", text: "Review it.", sessionId, reviewFilePath: planPath });
    await waitForClaude(() => lastClaude);

    const submit = await submitReview({
      filePath: planPath,
      markdown: "1. `plan.md:6` — tighten the architecture section.\n   Fix: name the registry.",
      reviewerLabel: "Reviewed by Codex",
    });
    expect(submit.statusCode).toBe(200);
    const body = submit.json() as { ok: boolean; reviewId: string; reReviewed: boolean };
    expect(body.ok).toBe(true);
    expect(body.reviewId).toBeTruthy();
    expect(body.reReviewed).toBe(false);

    const added = (await client.receiveType("ai_review_added")) as WsAiReviewAdded;
    expect(added.card.filePath).toBe(planPath);
    expect(added.card.reviewId).toBe(body.reviewId);
    expect(added.card.reviewerLabel).toBe("Reviewed by Codex");
    expect(added.card.markdown).toContain("tighten the architecture");

    // Persisted exactly once.
    expect(await historyAiReviews()).toHaveLength(1);

    // No human draft was created — the AI-review and user-comment systems are
    // fully decoupled (docs/203).
    const draftRes = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/file-reviews/draft?filePath=${encodeURIComponent(planPath)}`,
    });
    expect(draftRes.statusCode).toBe(404);

    lastClaude.finish();
    client.close();
  });

  it("rejects a submit for a file other than the authorized one", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    client.send({ type: "send_review_message", text: "Review it.", sessionId, reviewFilePath: planPath });
    await waitForClaude(() => lastClaude);

    const res = await submitReview({ filePath: "docs/012-foo/other.md", markdown: "x" });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toContain("authorized for");

    lastClaude.finish();
    client.close();
  });

  it("rejects a submit outside a review turn (an ordinary turn cannot emit a card)", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    // A normal send_message turn — runner exists but activeReviewFilePath is null.
    client.send({ type: "send_message", text: "Just chatting.", sessionId });
    await waitForClaude(() => lastClaude);

    const res = await submitReview({ filePath: planPath, markdown: "x" });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toContain("active review turn");

    lastClaude.finish();
    client.close();
  });

  it("rejects a stale submit after the review turn has finished (no out-of-turn card)", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    client.send({ type: "send_review_message", text: "Review it.", sessionId, reviewFilePath: planPath });
    await waitForClaude(() => lastClaude);

    // The turn ends. `activeReviewFilePath`/`activeReviewId` linger until the next
    // turn starts, but `running` flips to false — a late tool call must not pass.
    lastClaude.finish();
    await new Promise((r) => setTimeout(r, 50));

    const res = await submitReview({ filePath: planPath, markdown: "late finding" });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toContain("active review turn");
    expect(await historyAiReviews()).toHaveLength(0);

    client.close();
  });

  it("fails clearly when no active runner resolves (never a bare out-of-turn append)", async () => {
    // No client connected and no turn started → no runner in the registry.
    const res = await submitReview({ filePath: planPath, markdown: "x" });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain("No active session runner");
  });

  it("rejects an empty-markdown submit", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();
    client.send({ type: "send_review_message", text: "Review it.", sessionId, reviewFilePath: planPath });
    await waitForClaude(() => lastClaude);

    const res = await submitReview({ filePath: planPath, markdown: "   " });
    expect(res.statusCode).toBe(400);

    lastClaude.finish();
    client.close();
  });

  it("the re-review submit PATCHES the same card by reviewId (no duplicate)", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    client.send({ type: "send_review_message", text: "Review it.", sessionId, reviewFilePath: planPath });
    await waitForClaude(() => lastClaude);

    const first = (await submitReview({
      filePath: planPath,
      markdown: "1. `plan.md:6` — issue A.",
      reviewerLabel: "Reviewed by Codex",
    })).json() as { reviewId: string; reReviewed: boolean };
    expect(first.reReviewed).toBe(false);
    await client.receiveType("ai_review_added");

    const second = (await submitReview({
      filePath: planPath,
      markdown: "No material issues found.",
      reviewerLabel: "Reviewed by Codex",
    })).json() as { reviewId: string; reReviewed: boolean };
    expect(second.reviewId).toBe(first.reviewId);
    expect(second.reReviewed).toBe(true);

    const patched = (await client.receiveType("ai_review_added")) as WsAiReviewAdded;
    expect(patched.card.reviewId).toBe(first.reviewId);
    expect(patched.card.markdown).toBe("No material issues found.");
    expect(patched.card.reReviewed).toBe(true);

    // Exactly one persisted card — the re-review patched it, didn't stack a new one.
    const cards = await historyAiReviews();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.reReviewed).toBe(true);

    lastClaude.finish();
    client.close();
  });

  it("flows a cross-agent fallback label through to the card", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    client.send({ type: "send_review_message", text: "Review it.", sessionId, reviewFilePath: planPath });
    await waitForClaude(() => lastClaude);

    // The parent's `shipit agent run` failed, so it fell back to a same-model
    // Task review and labeled the card accordingly (the failure/fallback decision
    // itself is exercised in sub-agent.test.ts; here we assert the label lands).
    await submitReview({
      filePath: planPath,
      markdown: "No material issues found.",
      reviewerLabel: "Reviewed by Claude (Codex unavailable)",
    });
    const added = (await client.receiveType("ai_review_added")) as WsAiReviewAdded;
    expect(added.card.reviewerLabel).toBe("Reviewed by Claude (Codex unavailable)");

    lastClaude.finish();
    client.close();
  });
});
