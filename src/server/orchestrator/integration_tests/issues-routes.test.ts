/**
 * Integration tests for the inline tracker Issues tab routes (docs/170).
 *
 * Spins up a real Fastify app via `buildApp()` with stub managers and a stubbed
 * `trackerFetchImpl` so the Linear GraphQL calls never hit the network.
 * Exercises: the unconfigured empty state, connect (token validation) → team
 * binding → priority-sorted listing, the token non-echo invariant, and
 * disconnect. Orchestrator-only — no Docker, no real worker.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { GitManager } from "../../shared/git.js";
import type { FastifyInstance } from "fastify";
import type { DatabaseManager } from "../../shared/database.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { GitHubAuthManager } from "../github-auth.js";
import { CredentialStore } from "../credential-store.js";
import { initGlobalGitConfig } from "../git-config.js";
import type { TrackerInfo, TrackerIssue } from "../../shared/types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const TEAM = { id: "team-1", key: "SHI", name: "ShipIt" };

describe("Integration: Issues tab routes (docs/170)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let dbManager: DatabaseManager;
  /** Routes each GraphQL operation to a canned response by query content. */
  let trackerFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-issues-routes-"));
    initGlobalGitConfig(tmpDir);
    credentialStore = new CredentialStore(tmpDir);

    trackerFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      const query = (JSON.parse(rawBody) as { query?: string }).query ?? "";
      if (query.includes("teams")) {
        return jsonResponse({ data: { teams: { nodes: [TEAM] } } });
      }
      if (query.includes("TeamIssues")) {
        return jsonResponse({
          data: {
            team: {
              issues: {
                nodes: [
                  { id: "b", identifier: "SHI-2", title: "Low", url: "u2", priority: 4, priorityLabel: "Low", state: { name: "Todo" }, assignee: null },
                  { id: "a", identifier: "SHI-1", title: "Urgent", url: "u1", priority: 1, priorityLabel: "Urgent", state: { name: "In Progress" }, assignee: { displayName: "Nik" } },
                ],
              },
            },
          },
        });
      }
      return jsonResponse({ data: {} });
    });

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      credentialStore,
      workspaceDir: tmpDir,
      serveStatic: false,
      trackerFetchImpl: trackerFetch as unknown as typeof fetch,
    });
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* ignore */
    }
  });

  it("GET /api/trackers reports Linear as not configured initially", async () => {
    const res = await app.inject({ method: "GET", url: "/api/trackers" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { trackers: TrackerInfo[] };
    expect(body.trackers).toEqual([{ id: "linear", label: "Linear", configured: false }]);
  });

  it("GET /api/issues returns an empty list with tracker info when unconfigured", async () => {
    const res = await app.inject({ method: "GET", url: "/api/issues?tracker=linear" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tracker: TrackerInfo; issues: TrackerIssue[] };
    expect(body.tracker.configured).toBe(false);
    expect(body.issues).toEqual([]);
    // No GraphQL call should fire when unconfigured.
    expect(trackerFetch).not.toHaveBeenCalled();
  });

  it("connects + binds a team, then lists priority-sorted issues", async () => {
    // Connect: validates the token by listing teams.
    const connect = await app.inject({
      method: "POST",
      url: "/api/trackers/linear/token",
      payload: { token: "lin_api_x" },
    });
    expect(connect.statusCode).toBe(200);
    expect((connect.json() as { teams: typeof TEAM[] }).teams).toEqual([TEAM]);

    // Bind the team.
    const bind = await app.inject({
      method: "POST",
      url: "/api/trackers/linear/team",
      payload: TEAM,
    });
    expect(bind.statusCode).toBe(200);
    expect((bind.json() as { tracker: TrackerInfo }).tracker).toEqual({
      id: "linear",
      label: "Linear",
      configured: true,
      binding: { key: "SHI", name: "ShipIt" },
    });

    // List: urgent first.
    const list = await app.inject({ method: "GET", url: "/api/issues?tracker=linear" });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { tracker: TrackerInfo; issues: TrackerIssue[] };
    expect(body.tracker.configured).toBe(true);
    expect(body.issues.map((i) => i.identifier)).toEqual(["SHI-1", "SHI-2"]);
    expect(body.issues[0].priority.level).toBe("urgent");
    expect(body.issues[1].assignee).toBeUndefined();
    expect(body.issues[0].status).toEqual({ name: "In Progress" });
  });

  it("passes includeDone through to the tracker's excluded-state filter", async () => {
    await app.inject({ method: "POST", url: "/api/trackers/linear/token", payload: { token: "t" } });
    await app.inject({ method: "POST", url: "/api/trackers/linear/team", payload: TEAM });

    const variablesFor = (callIndex: number) => {
      const init = trackerFetch.mock.calls[callIndex][1] as RequestInit;
      return (JSON.parse(init.body as string) as { variables: { excludedTypes?: string[] } }).variables;
    };

    // Default: open working set — completed + canceled excluded.
    await app.inject({ method: "GET", url: "/api/issues?tracker=linear" });
    const defaultCall = trackerFetch.mock.calls.length - 1;
    expect(variablesFor(defaultCall).excludedTypes).toEqual(["completed", "canceled"]);

    // includeDone=true: only canceled stays excluded.
    await app.inject({ method: "GET", url: "/api/issues?tracker=linear&includeDone=true" });
    const doneCall = trackerFetch.mock.calls.length - 1;
    expect(variablesFor(doneCall).excludedTypes).toEqual(["canceled"]);
  });

  it("rejects an unknown tracker with 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/issues?tracker=jira" });
    expect(res.statusCode).toBe(404);
  });

  it("never echoes the stored token back to the client", async () => {
    await app.inject({ method: "POST", url: "/api/trackers/linear/token", payload: { token: "secret-token" } });
    await app.inject({ method: "POST", url: "/api/trackers/linear/team", payload: TEAM });
    const trackers = await app.inject({ method: "GET", url: "/api/trackers" });
    const issues = await app.inject({ method: "GET", url: "/api/issues?tracker=linear" });
    expect(trackers.body).not.toContain("secret-token");
    expect(issues.body).not.toContain("secret-token");
    // But it is persisted server-side.
    expect(credentialStore.getLinearToken()).toBe("secret-token");
  });

  it("disconnects, clearing the token + team binding", async () => {
    await app.inject({ method: "POST", url: "/api/trackers/linear/token", payload: { token: "t" } });
    await app.inject({ method: "POST", url: "/api/trackers/linear/team", payload: TEAM });
    const res = await app.inject({ method: "POST", url: "/api/trackers/linear/disconnect" });
    expect(res.statusCode).toBe(200);
    expect(credentialStore.getLinearToken()).toBeNull();
    expect(credentialStore.getLinearTeam()).toBeNull();
  });
});
