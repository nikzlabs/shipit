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
  let sessionManager: SessionManager;
  let githubAuthManager: StubGitHubAuthManager;
  let trackerFetch: ReturnType<typeof vi.fn>;
  let linearWorkspace: string;

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
      if (query.includes("IssueComments")) {
        return jsonResponse({
          data: {
            issue: {
              team: { key: "SHI" },
              comments: {
                nodes: [
                  {
                    id: "c1",
                    body: "First reply",
                    url: "https://linear.app/x/issue/SHI-1#c1",
                    createdAt: "2026-06-01T00:00:00.000Z",
                    user: { name: "nik", displayName: "Nik", avatarUrl: "http://a" },
                  },
                ],
              },
            },
          },
        });
      }
      if (query.includes("TeamStates")) {
        return jsonResponse({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "s-todo", name: "Todo", type: "unstarted", position: 0 },
                  { id: "s-prog", name: "In Progress", type: "started", position: 1 },
                  { id: "s-done", name: "Done", type: "completed", position: 2 },
                ],
              },
            },
          },
        });
      }
      if (query.includes("IssueStates")) {
        return jsonResponse({
          data: {
            issue: {
              id: "a",
              team: {
                key: "SHI",
                states: {
                  nodes: [
                    { id: "s-todo", name: "Todo", type: "unstarted", position: 0 },
                    { id: "s-done", name: "Done", type: "completed", position: 1 },
                  ],
                },
              },
            },
          },
        });
      }
      if (query.includes("IssueUpdate")) {
        return jsonResponse({
          data: {
            issueUpdate: {
              success: true,
              issue: {
                id: "a",
                identifier: "SHI-1",
                title: "Urgent",
                url: "https://linear.app/x/issue/SHI-1",
                priority: 2,
                priorityLabel: "High",
                state: { name: "Done", type: "completed" },
                assignee: null,
                team: { states: { nodes: [{ id: "s-todo", name: "Todo", type: "unstarted", position: 0 }] } },
              },
            },
          },
        });
      }
      if (query.includes("IssueId")) {
        return jsonResponse({ data: { issue: { id: "uuid-1", team: { key: "SHI" } } } });
      }
      if (query.includes("AddComment")) {
        return jsonResponse({
          data: {
            commentCreate: {
              success: true,
              comment: {
                id: "c2",
                body: "Posted from the UI",
                url: "https://linear.app/x/issue/SHI-1#c2",
                createdAt: "2026-06-02T00:00:00.000Z",
                user: { name: "nik", displayName: "Nik", avatarUrl: "http://a" },
              },
            },
          },
        });
      }
      if (query.includes("query Issue(")) {
        return jsonResponse({
          data: {
            issue: {
              id: "a",
              identifier: "SHI-1",
              title: "Urgent",
              url: "https://linear.app/x/issue/SHI-1",
              description: "The body of the issue.",
              priority: 1,
              priorityLabel: "Urgent",
              state: { name: "In Progress", type: "started" },
              assignee: { displayName: "Nik" },
              team: { key: "SHI", states: { nodes: [{ id: "s1", name: "Todo", type: "unstarted", position: 0 }] } },
            },
          },
        });
      }
      return jsonResponse({ data: {} });
    });

    sessionManager = new SessionManager(dbManager);
    githubAuthManager = new StubGitHubAuthManager();
    linearWorkspace = path.join(tmpDir, "linear-workspace");
    fs.mkdirSync(linearWorkspace, { recursive: true });
    fs.writeFileSync(
      path.join(linearWorkspace, "shipit.yaml"),
      "issues:\n  trackers:\n    - kind: linear\n      team: SHI\n      name: roadmap\n",
    );
    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      credentialStore,
      workspaceDir: tmpDir,
      serveStatic: false,
      trackerFetchImpl: trackerFetch as unknown as typeof fetch,
    });
    sessionManager.track("lin-sess", "Linear session", linearWorkspace);
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

  it("GET /api/trackers reports Linear and GitHub as not configured initially", async () => {
    const res = await app.inject({ method: "GET", url: "/api/trackers" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { trackers: TrackerInfo[] };
    expect(body.trackers).toEqual([{ id: "github", label: "GitHub", kind: "github", configured: false }]);
  });

  it("GitHub tracker auto-configures from the active session's GitHub remote", async () => {
    await githubAuthManager.setToken("ghp_test_token");
    sessionManager.track("gh-sess", "GH session");
    sessionManager.setRemoteUrl("gh-sess", "https://github.com/octocat/hello-world.git");

    trackerFetch.mockImplementationOnce(async () =>
      jsonResponse([
        {
          id: 1,
          number: 42,
          title: "An open issue",
          html_url: "https://github.com/octocat/hello-world/issues/42",
          state: "open",
          labels: ["P1"],
          assignee: null,
        },
      ]),
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/issues?tracker=github&sessionId=gh-sess",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tracker: TrackerInfo; issues: TrackerIssue[] };
    expect(body.tracker.configured).toBe(true);
    expect(body.tracker.binding).toEqual({
      key: "octocat/hello-world",
      name: "octocat/hello-world",
    });
    expect(body.issues.map((i) => i.identifier)).toEqual(["octocat/hello-world#42"]);
    expect(body.issues[0].priority.level).toBe("high");
  });

  it("GitHub tracker stays unconfigured without an active GitHub session", async () => {
    await githubAuthManager.setToken("ghp_test_token");
    const res = await app.inject({ method: "GET", url: "/api/issues?tracker=github" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tracker: TrackerInfo; issues: TrackerIssue[] };
    expect(body.tracker.configured).toBe(false);
    expect(body.issues).toEqual([]);
  });

  it("GET /api/issues returns an empty list with tracker info when unconfigured", async () => {
    const res = await app.inject({ method: "GET", url: "/api/issues?tracker=linear%3ASHI&sessionId=lin-sess" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tracker: TrackerInfo; issues: TrackerIssue[] };
    expect(body.tracker.configured).toBe(false);
    expect(body.issues).toEqual([]);
    expect(trackerFetch).not.toHaveBeenCalled();
  });

  it("connects the credential, then lists the declared team's issues priority-sorted", async () => {
    const connect = await app.inject({
      method: "POST",
      url: "/api/trackers/linear/token",
      payload: { token: "lin_api_x" },
    });
    expect(connect.statusCode).toBe(200);
    expect((connect.json() as { teams: typeof TEAM[] }).teams).toEqual([TEAM]);

    const list = await app.inject({ method: "GET", url: "/api/issues?tracker=linear%3ASHI&sessionId=lin-sess" });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { tracker: TrackerInfo; issues: TrackerIssue[] };
    expect(body.tracker.configured).toBe(true);
    expect(body.issues.map((i) => i.identifier)).toEqual(["roadmap#SHI-1", "roadmap#SHI-2"]);
    expect(body.issues[0].priority.level).toBe("urgent");
    expect(body.issues[1].assignee).toBeUndefined();
    expect(body.issues[0].status).toEqual({ name: "In Progress" });
  });

  it("passes includeDone through to the tracker's excluded-state filter", async () => {
    await app.inject({ method: "POST", url: "/api/trackers/linear/token", payload: { token: "t" } });

    // TeamIssues and TeamStates run in parallel, so either call can be last.
    const lastIssuesVariables = () => {
      for (let i = trackerFetch.mock.calls.length - 1; i >= 0; i--) {
        const init = trackerFetch.mock.calls[i][1] as RequestInit;
        const parsed = JSON.parse(init.body as string) as {
          query: string;
          variables: { excludedTypes?: string[] };
        };
        if (parsed.query.includes("issues(")) return parsed.variables;
      }
      throw new Error("no TeamIssues call recorded");
    };

    await app.inject({ method: "GET", url: "/api/issues?tracker=linear%3ASHI&sessionId=lin-sess" });
    expect(lastIssuesVariables().excludedTypes).toEqual(["completed", "canceled"]);

    await app.inject({ method: "GET", url: "/api/issues?tracker=linear%3ASHI&sessionId=lin-sess&includeDone=true" });
    expect(lastIssuesVariables().excludedTypes).toEqual(["canceled"]);
  });

  it("rejects an unknown tracker with 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/issues?tracker=jira" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/issue returns one fully-hydrated Linear issue", async () => {
    await app.inject({ method: "POST", url: "/api/trackers/linear/token", payload: { token: "t" } });

    const res = await app.inject({ method: "GET", url: "/api/issue?tracker=linear%3ASHI&sessionId=lin-sess&id=SHI-1" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tracker: TrackerInfo; issue: TrackerIssue };
    expect(body.issue.identifier).toBe("roadmap#SHI-1");
    expect(body.issue.description).toBe("The body of the issue.");
    expect(body.issue.status).toEqual({ name: "In Progress", type: "started" });
    expect(body.issue.availableStatuses).toEqual([{ name: "Todo", type: "unstarted" }]);
  });

  it("GET /api/issue 400s when the tracker is unconfigured", async () => {
    const res = await app.inject({ method: "GET", url: "/api/issue?tracker=linear%3ASHI&sessionId=lin-sess&id=SHI-1" });
    expect(res.statusCode).toBe(400);
    expect(trackerFetch).not.toHaveBeenCalled();
  });

  it("GET /api/issue/comments returns the Linear comment thread", async () => {
    await app.inject({ method: "POST", url: "/api/trackers/linear/token", payload: { token: "t" } });

    const res = await app.inject({ method: "GET", url: "/api/issue/comments?tracker=linear%3ASHI&sessionId=lin-sess&id=SHI-1" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { comments: { id: string; body: string; author?: { name: string } }[] };
    expect(body.comments).toEqual([
      {
        id: "c1",
        body: "First reply",
        url: "https://linear.app/x/issue/SHI-1#c1",
        createdAt: "2026-06-01T00:00:00.000Z",
        author: { name: "Nik", avatarUrl: "http://a" },
      },
    ]);
  });

  it("GET /api/issue/comments 400s when the tracker is unconfigured", async () => {
    const res = await app.inject({ method: "GET", url: "/api/issue/comments?tracker=linear%3ASHI&sessionId=lin-sess&id=SHI-1" });
    expect(res.statusCode).toBe(400);
    expect(trackerFetch).not.toHaveBeenCalled();
  });

  it("POST /api/issue/comments posts a user comment and returns it (no provenance card)", async () => {
    await app.inject({ method: "POST", url: "/api/trackers/linear/token", payload: { token: "t" } });

    const res = await app.inject({
      method: "POST",
      url: "/api/issue/comments",
      payload: { tracker: "linear:SHI", sessionId: "lin-sess", id: "SHI-1", body: "Posted from the UI" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { comment: { id: string; body: string; author?: { name: string } } };
    expect(body.comment.id).toBe("c2");
    expect(body.comment.body).toBe("Posted from the UI");
    expect(body.comment.author).toEqual({ name: "Nik", avatarUrl: "http://a" });
  });

  it("POST /api/issue/comments 400s without a body", async () => {
    await app.inject({ method: "POST", url: "/api/trackers/linear/token", payload: { token: "t" } });

    const res = await app.inject({
      method: "POST",
      url: "/api/issue/comments",
      payload: { tracker: "linear:SHI", sessionId: "lin-sess", id: "SHI-1", body: "   " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/issues includes the tracker's availableStatuses (docs/191)", async () => {
    await app.inject({ method: "POST", url: "/api/trackers/linear/token", payload: { token: "t" } });

    const res = await app.inject({ method: "GET", url: "/api/issues?tracker=linear%3ASHI&sessionId=lin-sess" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { availableStatuses?: { name: string }[] };
    expect(body.availableStatuses?.map((s) => s.name)).toEqual(["Todo", "In Progress", "Done"]);
  });

  it("GET /api/issue/labels returns the tracker's labels with colors (planning#94 foundation)", async () => {
    await app.inject({ method: "POST", url: "/api/trackers/linear/token", payload: { token: "t" } });

    trackerFetch.mockImplementationOnce(async () =>
      jsonResponse({
        data: {
          issueLabels: {
            nodes: [
              { name: "bug", color: "#d73a4a" },
              { name: "design", color: "#a2eeef" },
            ],
          },
        },
      }),
    );

    const res = await app.inject({ method: "GET", url: "/api/issue/labels?tracker=linear%3ASHI&sessionId=lin-sess" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { labels: { name: string; color?: string }[] };
    expect(body.labels).toEqual([
      { name: "bug", color: "#d73a4a" },
      { name: "design", color: "#a2eeef" },
    ]);
  });

  it("GET /api/issue/labels returns an empty set when the tracker is unconfigured", async () => {
    const res = await app.inject({ method: "GET", url: "/api/issue/labels?tracker=linear%3ASHI&sessionId=lin-sess" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { labels: unknown[] }).labels).toEqual([]);
  });

  it("POST /api/issue/status sets the status and returns the issue (no card)", async () => {
    await app.inject({ method: "POST", url: "/api/trackers/linear/token", payload: { token: "t" } });

    const res = await app.inject({
      method: "POST",
      url: "/api/issue/status",
      payload: { tracker: "linear:SHI", sessionId: "lin-sess", id: "SHI-1", status: "Done" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { issue: { identifier: string; status?: { name: string } } };
    expect(body.issue.identifier).toBe("roadmap#SHI-1");
    expect(body.issue.status?.name).toBe("Done");
  });

  it("POST /api/issue/status 400s without a status", async () => {
    await app.inject({ method: "POST", url: "/api/trackers/linear/token", payload: { token: "t" } });
    const res = await app.inject({
      method: "POST",
      url: "/api/issue/status",
      payload: { tracker: "linear:SHI", sessionId: "lin-sess", id: "SHI-1", status: "  " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/issue/priority sets Linear priority and returns the issue", async () => {
    await app.inject({ method: "POST", url: "/api/trackers/linear/token", payload: { token: "t" } });

    const res = await app.inject({
      method: "POST",
      url: "/api/issue/priority",
      payload: { tracker: "linear:SHI", sessionId: "lin-sess", id: "SHI-1", priority: "high" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { issue: { priority: { level: string } } };
    expect(body.issue.priority.level).toBe("high");
  });

  it("POST /api/issue/priority is rejected on GitHub with a 422 (no native field)", async () => {
    await githubAuthManager.setToken("ghp_test_token");
    sessionManager.track("gh-sess", "GH session");
    sessionManager.setRemoteUrl("gh-sess", "https://github.com/octocat/hello-world.git");

    const res = await app.inject({
      method: "POST",
      url: "/api/issue/priority",
      payload: { tracker: "github", id: "42", priority: "high", sessionId: "gh-sess" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("GET /api/issue reads a GitHub issue scoped to the session repo", async () => {
    await githubAuthManager.setToken("ghp_test_token");
    sessionManager.track("gh-sess", "GH session");
    sessionManager.setRemoteUrl("gh-sess", "https://github.com/octocat/hello-world.git");

    trackerFetch.mockImplementationOnce(async () =>
      jsonResponse({
        id: 1,
        number: 42,
        title: "An open issue",
        html_url: "https://github.com/octocat/hello-world/issues/42",
        body: "GitHub body",
        state: "open",
        labels: ["P1"],
        assignee: null,
      }),
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/issue?tracker=github&id=42&sessionId=gh-sess",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tracker: TrackerInfo; issue: TrackerIssue };
    expect(body.issue.identifier).toBe("octocat/hello-world#42");
    expect(body.issue.description).toBe("GitHub body");
    expect(body.issue.priority.level).toBe("high");
  });

  it("never echoes the stored token back to the client", async () => {
    await app.inject({ method: "POST", url: "/api/trackers/linear/token", payload: { token: "secret-token" } });
    const trackers = await app.inject({ method: "GET", url: "/api/trackers" });
    const issues = await app.inject({ method: "GET", url: "/api/issues?tracker=linear%3ASHI&sessionId=lin-sess" });
    expect(trackers.body).not.toContain("secret-token");
    expect(issues.body).not.toContain("secret-token");
    expect(credentialStore.getLinearToken()).toBe("secret-token");
  });

  it("disconnects, clearing the stored credential", async () => {
    await app.inject({ method: "POST", url: "/api/trackers/linear/token", payload: { token: "t" } });
    const res = await app.inject({ method: "POST", url: "/api/trackers/linear/disconnect" });
    expect(res.statusCode).toBe(200);
    expect(credentialStore.getLinearToken()).toBeNull();
  });

  it("has no team-binding route — the team is declared, not stored (req 4)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/trackers/linear/team", payload: TEAM });
    expect(res.statusCode).toBe(404);
  });
});
