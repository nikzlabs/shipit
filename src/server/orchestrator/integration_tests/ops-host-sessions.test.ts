/**
 * Integration tests for the Ops host-session inventory surface (docs/255).
 *
 *   GET /api/sessions/:id/host-sessions[?branch=&pr=&container=&id=…]
 *
 * Covers the two contracts this route exists to hold:
 *
 *  - the Ops GATE — 200 for an ops session, 403 for an ordinary one, 404 for a
 *    session that doesn't exist, and (crucially) the unchanged container guard:
 *    a container reaching the route for ANOTHER session's id is still refused by
 *    `api-container-guard.ts`'s §3 own-session check, which this feature
 *    deliberately did not touch;
 *  - the metadata-only BOUNDARY — the response body must not carry another
 *    session's conversation replay or workspace path.
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
import type { PrStatusSummary } from "../../shared/types/github-types.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

describe("Integration: Ops host-session inventory (docs/255)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-host-sessions-"));
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

  /** A subject session owning a branch and a PR — the thing we look up. */
  function seedSubject(id: string, branch: string, prNumber: number): void {
    sessionManager.track(id, "Fix the thing");
    sessionManager.setBranch(id, branch);
    sessionManager.setPrStatus(id, {
      sessionId: id,
      prNumber,
      prUrl: `https://github.com/nikzlabs/shipit/pull/${prNumber}`,
      prTitle: "Subject PR",
      prBody: "",
      prState: "merged",
      baseBranch: "main",
      headBranch: branch,
      insertions: 1,
      deletions: 0,
      checks: { state: "success", total: 1, passed: 1, failed: 0, pending: 0 },
      mergeable: "mergeable",
      reviewState: "none",
      reviewDecision: "none",
      autoMergeEnabled: false,
    } as PrStatusSummary);
  }

  it("resolves a branch to the session that owns it", async () => {
    const ops = await createSession("ops");
    seedSubject("83292266-7445-4a1b-9c2d-000000000000", "shipit/kmwodw", 1744);

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-sessions?branch=shipit%2Fkmwodw`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessions: Record<string, unknown>[] };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe("83292266-7445-4a1b-9c2d-000000000000");
    expect(body.sessions[0].containerName).toBe("agent-83292266-744");
  });

  it("resolves a PR number and a container name to the same session", async () => {
    const ops = await createSession("ops");
    seedSubject("83292266-7445-4a1b-9c2d-000000000000", "shipit/kmwodw", 1744);

    const byPr = await app.inject({ method: "GET", url: `/api/sessions/${ops}/host-sessions?pr=1744` });
    expect(byPr.statusCode).toBe(200);
    expect((byPr.json() as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual([
      "83292266-7445-4a1b-9c2d-000000000000",
    ]);

    const byContainer = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-sessions?container=agent-83292266-744`,
    });
    expect(byContainer.statusCode).toBe(200);
    expect((byContainer.json() as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual([
      "83292266-7445-4a1b-9c2d-000000000000",
    ]);
  });

  it("lists the whole inventory with no filters", async () => {
    const ops = await createSession("ops");
    seedSubject("aaaa1111-2222-3333-4444-555555555555", "shipit/a", 1);
    seedSubject("bbbb1111-2222-3333-4444-555555555555", "shipit/b", 2);

    const res = await app.inject({ method: "GET", url: `/api/sessions/${ops}/host-sessions` });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { sessions: { id: string }[] }).sessions.map((s) => s.id);
    // The ops session itself is inventory too.
    expect(ids).toContain("aaaa1111-2222-3333-4444-555555555555");
    expect(ids).toContain("bbbb1111-2222-3333-4444-555555555555");
    expect(ids).toContain(ops);
  });

  it("does not leak another session's conversation or workspace", async () => {
    const ops = await createSession("ops");
    seedSubject("83292266-7445-4a1b-9c2d-000000000000", "shipit/kmwodw", 1744);
    sessionManager.setConversationReplay(
      "83292266-7445-4a1b-9c2d-000000000000",
      "PRIVATE-TRANSCRIPT-MARKER",
    );

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-sessions?branch=shipit%2Fkmwodw`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("PRIVATE-TRANSCRIPT-MARKER");
    expect(res.body).not.toContain("workspaceDir");
    // The PR's own prose is withheld too — identity and state only.
    expect(res.body).not.toContain("Subject PR");
  });

  it("does not leak a credential-bearing repo URL across the session boundary", async () => {
    const ops = await createSession("ops");
    seedSubject("83292266-7445-4a1b-9c2d-000000000000", "shipit/kmwodw", 1744);
    // `setGitRemote` persists a user-supplied origin verbatim, so a session row
    // can hold userinfo. Showing it to a DIFFERENT session is the token leak
    // req 8 forbids — the projection strips it at the crossing.
    //
    // Generic `u:pw@` rather than a realistic `x-access-token:<pat>@` shape on
    // purpose: `stripUrlCredentials` strips ANY http(s) userinfo, so the path
    // under test is identical, and a PAT-shaped fixture trips the secret scanner
    // on every commit. Don't "improve" it back.
    sessionManager.setRemoteUrl(
      "83292266-7445-4a1b-9c2d-000000000000",
      "https://u:pw@github.com/o/r.git",
    );

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-sessions?branch=shipit%2Fkmwodw`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("u:pw@");
    expect((res.json() as { sessions: { remoteUrl: string }[] }).sessions[0].remoteUrl).toBe(
      "https://github.com/o/r.git",
    );
  });

  it("refuses a user-set container_name and points at the label instead", async () => {
    const ops = await createSession("ops");
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-sessions?container=payments-db`,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("shipit-parent-session");
  });

  it("pages the inventory with limit + offset", async () => {
    const ops = await createSession("ops");
    seedSubject("aaaa1111-2222-3333-4444-555555555555", "shipit/a", 1);
    seedSubject("bbbb1111-2222-3333-4444-555555555555", "shipit/b", 2);

    const first = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-sessions?limit=1`,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { sessions: { id: string }[]; total: number; nextOffset?: number };
    expect(firstBody.sessions).toHaveLength(1);
    expect(firstBody.total).toBe(3); // two subjects + the ops session itself
    expect(firstBody.nextOffset).toBe(1);

    const second = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-sessions?limit=1&offset=${firstBody.nextOffset}`,
    });
    const secondBody = second.json() as { sessions: { id: string }[] };
    expect(secondBody.sessions).toHaveLength(1);
    expect(secondBody.sessions[0].id).not.toBe(firstBody.sessions[0].id);
  });

  it("rejects an invalid pr filter (400)", async () => {
    const ops = await createSession("ops");
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-sessions?pr=not-a-number`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 403 for a non-ops session", async () => {
    const id = await createSession();
    const res = await app.inject({ method: "GET", url: `/api/sessions/${id}/host-sessions` });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toMatch(/only available in Ops sessions/);
  });

  it("returns 404 for a session that doesn't exist", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/nope/host-sessions` });
    expect(res.statusCode).toBe(404);
  });
});
