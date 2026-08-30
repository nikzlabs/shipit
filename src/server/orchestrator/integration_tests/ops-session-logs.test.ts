/**
 * Integration tests for the Ops server-log read (docs/264).
 *
 *   GET /api/sessions/:id/host-session-logs?target=<session>[&since=&until=&lines=]
 *
 * Covers the three contracts the incident packet named:
 *
 *  - the Ops GATE — 200 for an ops session, 403 for an ordinary one, 404 for a
 *    caller session that doesn't exist;
 *  - the CONTENT filter — neither a non-server entry NOR a server entry quoting
 *    workspace text can appear in the response, exercised end-to-end through the
 *    real `LogStore` file layout rather than a fake, so it is proven against the
 *    bytes the orchestrator actually writes;
 *  - CONTAINER-IS-GONE — the subject session has no runner and no container in
 *    this test at all. Everything answered comes off `sessions/<id>/logs/`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { RepoStore } from "../repo-store.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { DatabaseManager } from "../../shared/database.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

const SUBJECT = "7bc72326-c1ad-48fd-ac95-12149a000000";

describe("Integration: Ops session logs (docs/264)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-session-logs-"));
    sessionManager = new SessionManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      repoStore: new RepoStore(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // ignore cleanup errors
    }
  });

  async function createSession(kind?: "ops"): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/api/_test/sessions", payload: { title: "S" } });
    expect(res.statusCode).toBe(200);
    const { sessionId } = res.json() as { sessionId: string };
    if (kind === "ops") sessionManager.setKind(sessionId, "ops");
    return sessionId;
  }

  /**
   * Write the durable agent channel exactly where `LogStore` keeps it
   * (`{workspaceDir}/sessions/<id>/logs/agent.jsonl`, per `app-di.ts`). Writing
   * the file rather than driving a live session is the point: it is precisely
   * the state a destroyed container leaves behind.
   */
  function seedLogs(sessionId: string, entries: { ts: string; source: string; text: string }[]): void {
    const dir = path.join(tmpDir, "sessions", sessionId, "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "agent.jsonl"),
      entries.map((e) => `${JSON.stringify(e)}\n`).join(""),
    );
  }

  function seedSubject(): void {
    sessionManager.track(SUBJECT, "Shipkit multi-repo game tooling");
    sessionManager.setBranch(SUBJECT, "shipit/shipkit-multi-repo-game-tooling-vkmila");
    seedLogs(SUBJECT, [
      { ts: "2026-08-14T10:00:00.000Z", source: "stdout", text: "AGENT-STDOUT-MARKER" },
      { ts: "2026-08-14T10:00:01.000Z", source: "stderr", text: "AGENT-STDERR-MARKER" },
      { ts: "2026-08-14T10:00:02.000Z", source: "preview", text: "PREVIEW-ERROR-MARKER" },
      { ts: "2026-08-14T10:00:03.000Z", source: "install", text: "INSTALL-OUTPUT-MARKER" },
      // A server line that quotes the project's own docker-compose.yml. This is
      // the path an independent review found against the first design, which
      // filtered on the source alone and returned it.
      {
        ts: "2026-08-14T10:00:04.000Z",
        source: "server",
        text: "[compose] Stack error: Service `web`: device `WORKSPACE-CONTENT-MARKER` is not allowed.",
      },
      {
        ts: "2026-08-14T22:11:03.000Z",
        source: "server",
        text: "Auto-push rejected: this session's branch and its remote have diverged. Measuring which side carries what.",
      },
    ]);
  }

  it("returns the server-source line the ops session could not otherwise reach", async () => {
    const ops = await createSession("ops");
    seedSubject();

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-session-logs?target=${SUBJECT}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      sessionId: string;
      containerName: string;
      entries: { source: string; text: string }[];
      logsRetained: boolean;
      withheldUnclassified: number;
    };
    expect(body.sessionId).toBe(SUBJECT);
    expect(body.containerName).toBe("agent-7bc72326-c1a");
    expect(body.logsRetained).toBe(true);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].text).toContain("Auto-push rejected");
  });

  it("never returns agent output OR workspace content, in any part of the payload", async () => {
    const ops = await createSession("ops");
    seedSubject();

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-session-logs?target=${SUBJECT}&lines=2000`,
    });
    expect(res.statusCode).toBe(200);
    for (const marker of [
      "AGENT-STDOUT-MARKER",
      "AGENT-STDERR-MARKER",
      "PREVIEW-ERROR-MARKER",
      "INSTALL-OUTPUT-MARKER",
      // The source label said "server"; the CONTENT is the project's compose file.
      "WORKSPACE-CONTENT-MARKER",
    ]) {
      expect(res.body).not.toContain(marker);
    }
    // Withheld, and reported — never silently dropped.
    expect((res.json() as { withheldUnclassified: number }).withheldUnclassified).toBe(1);
  });

  it("answers for a session with no runner and no container", async () => {
    const ops = await createSession("ops");
    seedSubject();
    // Nothing in this test ever created a container or a runner for SUBJECT —
    // it exists only as a DB row plus a logs dir, which is what an evicted /
    // destroyed session looks like on the host.
    sessionManager.setDiskTier(SUBJECT, "evicted");

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-session-logs?target=${SUBJECT}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { diskTier: string; entries: unknown[] };
    expect(body.diskTier).toBe("evicted");
    expect(body.entries).toHaveLength(1);
  });

  it("distinguishes an empty window from pruned logs", async () => {
    const ops = await createSession("ops");
    seedSubject();

    const empty = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-session-logs?target=${SUBJECT}&since=2026-08-15T00%3A00%3A00Z`,
    });
    expect((empty.json() as { entries: unknown[]; logsRetained: boolean }).entries).toHaveLength(0);
    expect((empty.json() as { logsRetained: boolean }).logsRetained).toBe(true);

    sessionManager.track("cccc1111-0000-0000-0000-000000000000", "No logs at all");
    const pruned = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-session-logs?target=cccc1111-0000-0000-0000-000000000000`,
    });
    expect((pruned.json() as { logsRetained: boolean }).logsRetained).toBe(false);
  });

  it("resolves a truncated session id from a log line", async () => {
    const ops = await createSession("ops");
    seedSubject();

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-session-logs?target=7bc72326`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { sessionId: string }).sessionId).toBe(SUBJECT);
  });

  it("400s an invalid --lines rather than silently applying the default", async () => {
    const ops = await createSession("ops");
    seedSubject();
    for (const value of ["0", "-1", "garbage"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${ops}/host-session-logs?target=${SUBJECT}&lines=${value}`,
      });
      expect(res.statusCode, `lines=${value}`).toBe(400);
    }
  });

  it("400s an unparseable --since rather than returning the whole history", async () => {
    const ops = await createSession("ops");
    seedSubject();

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-session-logs?target=${SUBJECT}&since=1%20hour%20ago`,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/ISO-8601/);
  });

  it("404s a target that matches no session", async () => {
    const ops = await createSession("ops");
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-session-logs?target=deadbeef`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 403 for a non-ops caller, even with a valid target", async () => {
    const ordinary = await createSession();
    seedSubject();

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${ordinary}/host-session-logs?target=${SUBJECT}`,
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toMatch(/only available in Ops sessions/);
    expect(res.body).not.toContain("Auto-push rejected");
  });

  it("returns 404 for a caller session that doesn't exist", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/nope/host-session-logs?target=${SUBJECT}`,
    });
    expect(res.statusCode).toBe(404);
  });
});
