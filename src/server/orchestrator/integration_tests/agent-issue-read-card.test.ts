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
import type { WsIssueRefCard } from "../../shared/types.js";

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

    const trackerFetch = vi.fn(async (url: string) => {
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

  it("emits + records a navigation card when the agent views an issue", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

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
});
