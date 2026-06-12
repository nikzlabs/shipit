/**
 * Integration test for issue-**write** idempotency (SHI-112).
 *
 * A crashed turn (exit 137 / OOM) that is retried — or a resumed agent CLI
 * session — re-drives the tail `shipit issue …` shim verbatim: it re-executes
 * as a fresh subprocess and POSTs an identical write to the orchestrator. The
 * production symptom was ~12 duplicate comments on one issue from a single
 * retry loop. `runner.recordedCards` (which dedups the read card) is reset at
 * every turn start, so it can't span the resume boundary; the write relay must
 * dedup on the write's *content* within a window.
 *
 * This drives the real orchestrator (`buildApp()`) with a live WS viewer (which
 * is what puts a runner in the registry) and a faked tracker REST layer that
 * COUNTS its write calls, asserting:
 *   - a replayed identical comment performs the tracker write exactly once and
 *     emits exactly one provenance card — the replay returns the original card's
 *     id (so the shim still sees `ok: true`) without a second write;
 *   - a genuinely distinct comment still gets its own write + its own card.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { GitManager } from "../../shared/git.js";
import type { CredentialStore } from "../credential-store.js";
import type { GitHubAuthManager } from "../github-auth.js";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
  createTestSession,
} from "./test-helpers.js";
import type { DatabaseManager } from "../../shared/database.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Integration: issue write idempotency (SHI-112)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let githubAuthManager: StubGitHubAuthManager;
  let sessionId: string;
  let commentPostCount: number;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue-write-idemp-"));
    sessionManager = new SessionManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);
    githubAuthManager = new StubGitHubAuthManager();
    await githubAuthManager.setToken("ghp_test_token");
    commentPostCount = 0;

    const trackerFetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      // POST a comment → record the call and return the created comment.
      if (/\/issues\/\d+\/comments$/.test(url) && init?.method === "POST") {
        commentPostCount += 1;
        const body = init.body ? (JSON.parse(init.body) as { body?: string }).body : "";
        return jsonResponse(
          {
            id: 9000 + commentPostCount,
            html_url: `https://github.com/octocat/hello-world/issues/42#issuecomment-${9000 + commentPostCount}`,
            body,
          },
          201,
        );
      }
      if (/\/issues\/\d+/.test(url)) {
        return jsonResponse({
          id: 1,
          number: 42,
          title: "An open issue",
          html_url: "https://github.com/octocat/hello-world/issues/42",
          state: "open",
          labels: ["P1"],
          body: "The GitHub body.",
          assignee: { login: "octocat" },
        });
      }
      return jsonResponse({ message: "Not Found" }, 404);
    });

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as unknown as never,
      credentialStore,
      databaseManager: dbManager,
      workspaceDir: tmpDir,
      serveStatic: false,
      trackerFetchImpl: trackerFetch as unknown as typeof fetch,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);

    const created = await createTestSession(sessionManager, tmpDir);
    sessionId = created.sessionId;
    sessionManager.setRemoteUrl(sessionId, "https://github.com/octocat/hello-world.git");
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore */ }
  });

  async function writeCardsInHistory(): Promise<{ cardId: string }[]> {
    const history = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    return (history.json() as { messages: { issueWrite?: { cardId: string } }[] }).messages
      .map((m) => m.issueWrite)
      .filter((c): c is { cardId: string } => Boolean(c));
  }

  it("a replayed identical comment writes the tracker once and emits one card", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    const post = () =>
      app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/issue/comment`,
        payload: { tracker: "github", id: "42", body: "looks good" },
      });

    // First write — real tracker call + card.
    const first = await post();
    expect(first.statusCode).toBe(200);
    const firstCardId = (first.json() as { cardId: string }).cardId;

    // Three replays of the identical write (simulating a crash/retry loop).
    for (let i = 0; i < 3; i++) {
      const replay = await post();
      expect(replay.statusCode).toBe(200);
      // The replay surfaces the ORIGINAL card id — no second card minted.
      expect((replay.json() as { cardId: string }).cardId).toBe(firstCardId);
    }

    // Exactly one real tracker write despite four POSTs.
    expect(commentPostCount).toBe(1);

    // Exactly one provenance card in history.
    const cards = await writeCardsInHistory();
    expect(cards).toHaveLength(1);
    expect(cards[0].cardId).toBe(firstCardId);

    client.close();
  });

  it("a genuinely distinct comment still gets its own write + card", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    const first = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/issue/comment`,
      payload: { tracker: "github", id: "42", body: "looks good" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/issue/comment`,
      payload: { tracker: "github", id: "42", body: "actually, one more thing" },
    });
    expect(second.statusCode).toBe(200);

    // Different content → two real writes and two distinct cards.
    expect(commentPostCount).toBe(2);
    const cards = await writeCardsInHistory();
    expect(cards).toHaveLength(2);
    expect(cards[0].cardId).not.toBe(cards[1].cardId);

    client.close();
  });
});
