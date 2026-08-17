/**
 * Integration test for the issue **read** navigation card (docs/188).
 *
 * When the agent runs `shipit issue view`, the orchestrator's view route emits a
 * read-only jump-to-issue card into the transcript — the read-path sibling of
 * the write provenance card. This drives the route through a *real* orchestrator
 * (`buildApp()`) with a live WS viewer (which is what puts a runner in the
 * registry) and faked GitHub REST, asserting:
 *   - a successful view emits an `issue_ref_card` WS message with the issue's
 *     identifier/title/url and is recorded in-band on the runner so it persists;
 *   - re-viewing the same issue within a turn does NOT emit a second card
 *     (per-turn dedup), so repeated reads don't spam the transcript.
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
import type { WsIssueRefCard, WsIssueWriteCard } from "../../shared/types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Integration: issue read navigation card (docs/188)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let githubAuthManager: StubGitHubAuthManager;
  let sessionId: string;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue-read-card-"));
    sessionManager = new SessionManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);
    githubAuthManager = new StubGitHubAuthManager();
    await githubAuthManager.setToken("ghp_test_token");

    const trackerFetch = vi.fn(async (url: string, init?: { method?: string }) => {
      // POST a comment → return the created comment (with id, for the undo snapshot).
      if (/\/issues\/\d+\/comments$/.test(url) && init?.method === "POST") {
        return jsonResponse({ id: 9001, html_url: "https://github.com/octocat/hello-world/issues/42#issuecomment-9001", body: "looks good" }, 201);
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

  function runnerRecordedCards(): { message: { issueRef?: { cardId: string } } }[] {
    const reg = (app as unknown as {
      runnerRegistry: { get(id: string): { recordedCards: { message: { issueRef?: { cardId: string } } }[] } | undefined };
    }).runnerRegistry;
    return reg.get(sessionId)?.recordedCards ?? [];
  }

  /**
   * `shipit issue view` is an agent tool call, so it fires with the turn in
   * flight — which is what puts the card on `recordedCards` (the anchor AND the
   * per-turn dedup key) instead of `emitChatCard`'s post-turn append path.
   * These tests drive the HTTP relay directly, so mark the turn running.
   */
  function markTurnRunning(): void {
    const reg = (app as unknown as {
      runnerRegistry: { get(id: string): { running: boolean } | undefined };
    }).runnerRegistry;
    const runner = reg.get(sessionId);
    if (runner) runner.running = true;
  }

  it("emits + records a navigation card when the agent views an issue", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status
    markTurnRunning();

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/issue/view?tracker=github&id=42`,
    });
    expect(res.statusCode).toBe(200);

    const card = (await client.receiveType("issue_ref_card")) as WsIssueRefCard;
    expect(card.card.tracker).toBe("github");
    expect(card.card.identifier).toBe("octocat/hello-world#42");
    expect(card.card.title).toBe("An open issue");
    expect(card.card.url).toBe("https://github.com/octocat/hello-world/issues/42");

    // Recorded in-band on the runner so it persists at its transcript position.
    const recorded = runnerRecordedCards();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].message.issueRef?.cardId).toBe(card.card.cardId);

    client.close();
  });

  it("dedupes repeated views of the same issue within a turn", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status
    markTurnRunning();

    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/issue/view?tracker=github&id=42`,
      });
      expect(res.statusCode).toBe(200);
    }

    // Three reads, one card — the agent re-checking an issue shouldn't spam the
    // transcript.
    expect(runnerRecordedCards()).toHaveLength(1);

    client.close();
  });

  it("persists the write card to history the instant it fires — no reconnect-clobber window (docs/191)", async () => {
    // Regression for the reported "commented on issue card disappears then
    // reappears" bug. The write card is emitted off the HTTP relay mid-turn; it
    // used to only be RECORDED on the runner and not written to chat history
    // until the next tool-result boundary. A `loadSessionHistory` in that window
    // (any WS reconnect) replaced the live transcript with a DB snapshot lacking
    // the card, so it flickered out and back. `emitChatCard` now persists the
    // in-progress turn in the same call, so the card is in `/history`
    // immediately — here we assert that WITHOUT ever sending a tool-result.
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/issue/comment`,
      payload: { tracker: "github", id: "42", body: "looks good" },
    });
    expect(res.statusCode).toBe(200);

    const card = (await client.receiveType("issue_write_card")) as WsIssueWriteCard;
    expect(card.card.verb).toBe("comment");
    expect(card.card.summary).toContain("commented on");

    // No boundary, no turn finalize — just read history straight away. The card
    // must already be there (the fix). Before docs/191 this was empty.
    const history = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const writeCards = (history.json() as { messages: { issueWrite?: { cardId: string; undoState: string } }[] }).messages
      .map((m) => m.issueWrite)
      .filter(Boolean);
    expect(writeCards).toHaveLength(1);
    expect(writeCards[0]?.cardId).toBe(card.card.cardId);
    expect(writeCards[0]?.undoState).toBe("available");

    client.close();
  });

  // docs/248-declared-issue-trackers req 16 — the card records the declared NAME it was addressed
  // through, not just the destination it resolved to, so a later re-point
  // re-targets it. Persisted with the card (it rides the existing `issue_ref`
  // JSON blob, so no schema change), which is what makes it survive a reload.
  it("records the declared tracker name on the read card", async () => {
    fs.writeFileSync(
      path.join(sessionManager.get(sessionId)!.workspaceDir!, "shipit.yaml"),
      "issues:\n  trackers:\n    - kind: github\n      repo: octocat/hello-world\n      name: planning\n",
    );
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status
    markTurnRunning();

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/issue/view?tracker=${encodeURIComponent("github:octocat/hello-world")}&id=42`,
    });
    expect(res.statusCode).toBe(200);

    const card = (await client.receiveType("issue_ref_card")) as WsIssueRefCard;
    expect(card.card.trackerName).toBe("planning");

    const history = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const refCards = (history.json() as { messages: { issueRef?: { trackerName?: string } }[] }).messages
      .map((m) => m.issueRef)
      .filter(Boolean);
    expect(refCards[0]?.trackerName).toBe("planning");

    client.close();
  });

  // The session's own repository is reachable unnamed (req 12), so a card for it
  // carries no name and keeps resolving through its destination.
  it("records no tracker name for the session's own unnamed repository", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status
    markTurnRunning();

    await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/issue/view?tracker=github&id=42` });
    const card = (await client.receiveType("issue_ref_card")) as WsIssueRefCard;
    expect(card.card.trackerName).toBeUndefined();

    client.close();
  });
});
