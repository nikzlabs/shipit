/**
 * Unit tests for the issue tracker service layer (docs/175 read + docs/177 write).
 *
 * `getIssueForTracker` is the single-issue read that backs `shipit issue view`;
 * `commentOnIssueForTracker` / `updateIssueForTracker` / `setIssueStatusForTracker`
 * / `setIssueAssigneeForTracker` are the do-then-surface writes, each snapshotting
 * prior state for undo, and `undoIssueWrite` replays that snapshot. The tests stub
 * the GitHub REST + Linear GraphQL HTTP and assert tracker-neutral behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "../credential-store.js";
import {
  getIssueForTracker,
  listIssuesForTracker,
  listLabelsForTracker,
  listStatusesForTracker,
  listIssueCommentsForTracker,
  addIssueCommentForTracker,
  userSetIssueStatus,
  userSetIssuePriority,
  userSetIssueLabels,
  createIssueForTracker,
  commentOnIssueForTracker,
  updateIssueForTracker,
  setIssueStatusForTracker,
  setIssueAssigneeForTracker,
  undoIssueWrite,
} from "./issues.js";
import { ServiceError } from "./types.js";
import type { GitHubTrackerContext } from "../trackers/index.js";

const TEAM = { id: "team-1", key: "SHI", name: "ShipIt" };
const GH: GitHubTrackerContext = { token: "ghp_test", repo: { owner: "octocat", repo: "hello-world" } };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ghResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function tmpStore(): CredentialStore {
  return new CredentialStore(fs.mkdtempSync(path.join(os.tmpdir(), "iss-")));
}

describe("getIssueForTracker (docs/175)", () => {
  let tmpDir: string;
  let credentialStore: CredentialStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "issues-service-"));
    credentialStore = new CredentialStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dispatches to the GitHub tracker by bare number", async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toContain("/repos/octocat/hello-world/issues/42");
      return jsonResponse({
        id: 1,
        number: 42,
        title: "An open issue",
        html_url: "https://github.com/octocat/hello-world/issues/42",
        state: "open",
        labels: ["P1"],
        body: "Body text",
        assignee: { login: "octocat" },
      });
    }) as unknown as typeof fetch;

    const { tracker, issue } = await getIssueForTracker(
      credentialStore,
      "github",
      "42",
      fetchImpl,
      GH,
    );
    expect(tracker.id).toBe("github");
    expect(issue.identifier).toBe("octocat/hello-world#42");
    expect(issue.priority.level).toBe("high");
    expect(issue.description).toBe("Body text");
  });

  it("dispatches to the Linear tracker by key", async () => {
    credentialStore.setLinearToken("lin_api_x");
    credentialStore.setLinearTeam(TEAM);

    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        query?: string;
        variables?: { id?: string };
      };
      expect(body.query).toContain("Issue");
      expect(body.variables?.id).toBe("TRACKER-28");
      return jsonResponse({
        data: {
          issue: {
            id: "abc",
            identifier: "TRACKER-28",
            title: "Decouple priorities",
            url: "https://linear.app/example/issue/TRACKER-28",
            description: "Body",
            priority: 1,
            priorityLabel: "Urgent",
            state: { name: "In Progress" },
            assignee: { displayName: "Nik" },
          },
        },
      });
    }) as unknown as typeof fetch;

    const { tracker, issue } = await getIssueForTracker(
      credentialStore,
      "linear",
      "TRACKER-28",
      fetchImpl,
    );
    expect(tracker.id).toBe("linear");
    expect(issue.identifier).toBe("TRACKER-28");
    expect(issue.priority.level).toBe("urgent");
    expect(issue.assignee?.name).toBe("Nik");
  });

  it("errors when the tracker is unconfigured (Linear, no token)", async () => {
    await expect(
      getIssueForTracker(credentialStore, "linear", "TRACKER-1"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("errors when the GitHub tracker has no repo binding", async () => {
    await expect(
      getIssueForTracker(credentialStore, "github", "1", undefined, {
        token: "ghp_test",
        repo: null,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an unknown tracker with 404", async () => {
    await expect(
      getIssueForTracker(credentialStore, "jira", "1", undefined, GH),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("404s when the GitHub issue does not exist", async () => {
    const fetchImpl = (async () => jsonResponse({ message: "Not Found" }, 404)) as unknown as typeof fetch;
    await expect(
      getIssueForTracker(credentialStore, "github", "999", fetchImpl, GH),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("404s when the number is a pull request, not an issue", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        id: 5,
        number: 7,
        title: "A pull request",
        html_url: "https://github.com/octocat/hello-world/pull/7",
        state: "open",
        pull_request: { url: "…" },
      })) as unknown as typeof fetch;
    await expect(
      getIssueForTracker(credentialStore, "github", "7", fetchImpl, GH),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("surfaces tracker HTTP failures as a 502", async () => {
    const fetchImpl = (async () => jsonResponse({ message: "boom" }, 500)) as unknown as typeof fetch;
    await expect(
      getIssueForTracker(credentialStore, "github", "1", fetchImpl, GH),
    ).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe("listIssuesForTracker availableStatuses (docs/191)", () => {
  it("attaches the Linear team's workflow states for the inline editor", async () => {
    const store = tmpStore();
    store.setLinearToken("lin_x");
    store.setLinearTeam(TEAM);
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const query = (JSON.parse((init?.body as string) ?? "{}").query as string) ?? "";
      if (query.includes("TeamIssues")) {
        return jsonResponse({ data: { team: { issues: { nodes: [] } } } });
      }
      if (query.includes("TeamStates")) {
        return jsonResponse({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "s2", name: "Done", type: "completed", position: 1 },
                  { id: "s1", name: "Todo", type: "unstarted", position: 0 },
                ],
              },
            },
          },
        });
      }
      throw new Error(`no route for "${query.trim().slice(0, 20)}"`);
    }) as unknown as typeof fetch;
    const out = await listIssuesForTracker(store, "linear", fetchImpl, undefined);
    // Sorted by board position, regardless of the response order.
    expect(out.availableStatuses).toEqual([
      { name: "Todo", type: "unstarted" },
      { name: "Done", type: "completed" },
    ]);
  });

  it("attaches GitHub's fixed Open/Closed pair (no extra request)", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if ((url as string).includes("/issues?state=")) return ghResponse([]);
      throw new Error(`unexpected ${url as string}`);
    }) as unknown as typeof fetch;
    const out = await listIssuesForTracker(tmpStore(), "github", fetchImpl, GH);
    expect(out.availableStatuses).toEqual([
      { name: "Open", type: "started", color: "#3fb950" },
      { name: "Closed", type: "completed", color: "#8957e5" },
    ]);
  });

  it("drops duplicate-status issues from the default open list, keeps them when includeDone", async () => {
    const store = tmpStore();
    store.setLinearToken("lin_x");
    store.setLinearTeam(TEAM);
    const nodes = [
      {
        id: "a", identifier: "SHI-1", title: "Open one", url: "https://linear.app/x/SHI-1",
        priority: 0, state: { name: "Todo", type: "unstarted" }, assignee: null, labels: { nodes: [] },
      },
      {
        id: "b", identifier: "SHI-2", title: "A dup", url: "https://linear.app/x/SHI-2",
        priority: 0, state: { name: "Duplicate", type: "unstarted" }, assignee: null, labels: { nodes: [] },
      },
    ];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const query = (JSON.parse((init?.body as string) ?? "{}").query as string) ?? "";
      if (query.includes("TeamIssues")) return jsonResponse({ data: { team: { issues: { nodes } } } });
      if (query.includes("TeamStates")) return jsonResponse({ data: { team: { states: { nodes: [] } } } });
      throw new Error(`no route for "${query.trim().slice(0, 20)}"`);
    }) as unknown as typeof fetch;

    const open = await listIssuesForTracker(store, "linear", fetchImpl, undefined);
    expect(open.issues.map((i) => i.identifier)).toEqual(["SHI-1"]);

    const all = await listIssuesForTracker(store, "linear", fetchImpl, undefined, { includeDone: true });
    expect(all.issues.map((i) => i.identifier)).toEqual(["SHI-1", "SHI-2"]);
  });

  it("degrades to no availableStatuses when the states lookup fails (best-effort)", async () => {
    const store = tmpStore();
    store.setLinearToken("lin_x");
    store.setLinearTeam(TEAM);
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const query = (JSON.parse((init?.body as string) ?? "{}").query as string) ?? "";
      if (query.includes("TeamIssues")) {
        return jsonResponse({ data: { team: { issues: { nodes: [] } } } });
      }
      // TeamStates errors — the list must still succeed without statuses.
      return jsonResponse({ errors: [{ message: "states boom" }] });
    }) as unknown as typeof fetch;
    const out = await listIssuesForTracker(store, "linear", fetchImpl, undefined);
    expect(out.issues).toEqual([]);
    expect(out.availableStatuses).toBeUndefined();
  });
});

describe("listLabelsForTracker (SHI-92 foundation)", () => {
  it("returns the GitHub repo's labels with normalized colors", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      expect((url as string)).toContain("/repos/octocat/hello-world/labels");
      return ghResponse([
        { name: "bug", color: "d73a4a" },
        { name: "design", color: "a2eeef" },
      ]);
    }) as unknown as typeof fetch;
    const out = await listLabelsForTracker(tmpStore(), "github", fetchImpl, GH);
    expect(out.labels).toEqual([
      { name: "bug", color: "#d73a4a" },
      { name: "design", color: "#a2eeef" },
    ]);
  });

  it("returns the Linear workspace labels with their colors", async () => {
    const store = tmpStore();
    store.setLinearToken("lin_x");
    store.setLinearTeam(TEAM);
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const query = (JSON.parse((init?.body as string) ?? "{}").query as string) ?? "";
      if (query.includes("IssueLabels")) {
        return jsonResponse({
          data: { issueLabels: { nodes: [{ name: "security", color: "#d73a4a" }] } },
        });
      }
      throw new Error(`no route for "${query.trim().slice(0, 20)}"`);
    }) as unknown as typeof fetch;
    const out = await listLabelsForTracker(store, "linear", fetchImpl, undefined);
    expect(out.labels).toEqual([{ name: "security", color: "#d73a4a" }]);
  });

  it("returns an empty set for an unconfigured tracker (no error)", async () => {
    // Linear with no token/team is unconfigured — a normal empty state.
    const out = await listLabelsForTracker(tmpStore(), "linear", undefined, undefined);
    expect(out.labels).toEqual([]);
  });
});

describe("listStatusesForTracker (SHI-199)", () => {
  it("returns GitHub's fixed Open/Closed pair without a network call", async () => {
    // GitHub has no workflow states — the discovery list is the static pair, so
    // no fetch should fire.
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const out = await listStatusesForTracker(tmpStore(), "github", fetchImpl, GH);
    expect(out.statuses).toEqual([
      { name: "Open", type: "started", color: "#3fb950" },
      { name: "Closed", type: "completed", color: "#8957e5" },
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns the Linear team's workflow states in board order", async () => {
    const store = tmpStore();
    store.setLinearToken("lin_x");
    store.setLinearTeam(TEAM);
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const query = (JSON.parse((init?.body as string) ?? "{}").query as string) ?? "";
      if (query.includes("TeamStates")) {
        return jsonResponse({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "s2", name: "In Progress", type: "started", position: 2, color: "#f2c94c" },
                  { id: "s1", name: "Backlog", type: "backlog", position: 1, color: "#bec2c8" },
                ],
              },
            },
          },
        });
      }
      throw new Error(`no route for "${query.trim().slice(0, 20)}"`);
    }) as unknown as typeof fetch;
    const out = await listStatusesForTracker(store, "linear", fetchImpl, undefined);
    // Sorted by board position, not the order returned.
    expect(out.statuses).toEqual([
      { name: "Backlog", type: "backlog", color: "#bec2c8" },
      { name: "In Progress", type: "started", color: "#f2c94c" },
    ]);
  });

  it("returns an empty set for an unconfigured tracker (no error)", async () => {
    const out = await listStatusesForTracker(tmpStore(), "linear", undefined, undefined);
    expect(out.statuses).toEqual([]);
  });
});

describe("user-initiated inline writes (docs/191)", () => {
  it("userSetIssueStatus sets GitHub state and returns the updated issue (no undo)", async () => {
    const out = await userSetIssueStatus(tmpStore(), "github", "42", "completed", ghFetch(), GH);
    expect(out.issue.status?.name).toBe("Closed");
    // Returns just the issue — no IssueWriteOutcome verb/undo (no provenance card).
    expect(out).not.toHaveProperty("undo");
    expect(out).not.toHaveProperty("verb");
  });

  it("userSetIssueStatus maps an ambiguous status to a 422", async () => {
    await expect(
      userSetIssueStatus(tmpStore(), "github", "42", "in review", ghFetch(), GH),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("userSetIssueStatus 400s on a blank status", async () => {
    await expect(
      userSetIssueStatus(tmpStore(), "github", "42", "  ", ghFetch(), GH),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("userSetIssueStatus 409s for an unconnected tracker", async () => {
    await expect(
      userSetIssueStatus(tmpStore(), "github", "42", "completed", ghFetch(), { token: null, repo: null }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("userSetIssuePriority updates Linear priority and returns the issue", async () => {
    const store = tmpStore();
    store.setLinearToken("lin_x");
    store.setLinearTeam(TEAM);
    const node = {
      id: "uuid-1", identifier: "SHI-9", title: "Doc", url: "https://linear.app/x/SHI-9",
      priority: 2, priorityLabel: "High", state: { name: "Todo", type: "unstarted" }, assignee: null, labels: { nodes: [] },
    };
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const query = (JSON.parse((init?.body as string) ?? "{}").query as string) ?? "";
      if (query.includes("IssueId")) return jsonResponse({ data: { issue: { id: "uuid-1" } } });
      if (query.includes("issueUpdate")) return jsonResponse({ data: { issueUpdate: { success: true, issue: node } } });
      throw new Error(`no route for "${query.trim().slice(0, 20)}"`);
    });
    const out = await userSetIssuePriority(store, "linear", "SHI-9", "high", fetchImpl as unknown as typeof fetch);
    // The issueUpdate input mapped "high" → numeric 2.
    const update = fetchImpl.mock.calls.find(
      ([, i]) => ((JSON.parse((i?.body as string) ?? "{}").query as string) ?? "").includes("issueUpdate"),
    )!;
    expect(JSON.parse(update[1]?.body as string).variables.input).toEqual({ priority: 2 });
    expect(out.issue.priority.level).toBe("high");
  });

  it("userSetIssuePriority is rejected on GitHub with a 422 (no native field)", async () => {
    await expect(
      userSetIssuePriority(tmpStore(), "github", "42", "high", ghFetch(), GH),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("userSetIssueLabels replaces the full set (wholesale) and returns the updated issue", async () => {
    const fetchImpl = ghFetchWithLabels(["security", "bug", "design"], {
      issue: { labels: [{ name: "security" }, { name: "bug" }] },
    });
    const out = await userSetIssueLabels(tmpStore(), "github", "42", ["security", "design"], fetchImpl, GH);
    expect(out.issue.labels).toEqual([{ name: "security" }, { name: "design" }]);
    // Wholesale replace: the PATCH carried exactly the requested set (not a merge
    // with the issue's prior labels), since the editor commits the end-state.
    const patch = fetchImpl.mock.calls.find(([, i]) => (i?.method ?? "GET") === "PATCH")!;
    expect(JSON.parse(patch[1]?.body as string).labels).toEqual(["security", "design"]);
    // Inline user write — just the issue, no provenance card / undo.
    expect(out).not.toHaveProperty("undo");
    expect(out).not.toHaveProperty("verb");
  });

  it("userSetIssueLabels accepts an empty set to clear all labels", async () => {
    const fetchImpl = ghFetchWithLabels(["security"], { issue: { labels: [{ name: "security" }] } });
    const out = await userSetIssueLabels(tmpStore(), "github", "42", [], fetchImpl, GH);
    const patch = fetchImpl.mock.calls.find(([, i]) => (i?.method ?? "GET") === "PATCH")!;
    expect(JSON.parse(patch[1]?.body as string).labels).toEqual([]);
    expect(out.issue.labels).toBeUndefined();
  });

  it("userSetIssueLabels rejects an unknown label name with a 422", async () => {
    const fetchImpl = ghFetchWithLabels(["security", "bug"]);
    await expect(
      userSetIssueLabels(tmpStore(), "github", "42", ["nope"], fetchImpl, GH),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("userSetIssueLabels 400s on a blank issue id", async () => {
    await expect(
      userSetIssueLabels(tmpStore(), "github", "  ", ["bug"], ghFetch(), GH),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

/** A GitHub REST stub routing on method + path tail. */
describe("issue comment read/post services (docs/189 follow-up)", () => {
  function ghCommentsFetch() {
    return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = url as string;
      const method = init?.method ?? "GET";
      if (method === "GET" && u.includes("/issues/42/comments")) {
        return ghResponse([
          {
            id: 1,
            body: "First",
            html_url: "https://github.com/octocat/hello-world/issues/42#c1",
            created_at: "2026-06-01T00:00:00Z",
            user: { login: "octocat", avatar_url: "http://a" },
          },
        ]);
      }
      if (method === "POST" && u.endsWith("/issues/42/comments")) {
        return ghResponse({
          id: 2,
          body: JSON.parse(init?.body as string).body,
          html_url: "https://github.com/octocat/hello-world/issues/42#c2",
          created_at: "2026-06-02T00:00:00Z",
          user: { login: "octocat", avatar_url: "http://a" },
        });
      }
      throw new Error(`unexpected ${method} ${u}`);
    });
  }

  it("listIssueCommentsForTracker returns the thread for a configured tracker", async () => {
    const out = await listIssueCommentsForTracker(tmpStore(), "github", "42", ghCommentsFetch(), GH);
    expect(out.comments).toEqual([
      {
        id: "1",
        body: "First",
        url: "https://github.com/octocat/hello-world/issues/42#c1",
        createdAt: "2026-06-01T00:00:00Z",
        author: { name: "octocat", avatarUrl: "http://a" },
      },
    ]);
  });

  it("listIssueCommentsForTracker 400s for an unconfigured tracker", async () => {
    await expect(
      listIssueCommentsForTracker(tmpStore(), "github", "42", ghCommentsFetch(), {
        token: null,
        repo: null,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("addIssueCommentForTracker posts and returns the created comment", async () => {
    const out = await addIssueCommentForTracker(tmpStore(), "github", "42", "Posted inline", ghCommentsFetch(), GH);
    expect(out.comment.body).toBe("Posted inline");
    expect(out.comment.author).toEqual({ name: "octocat", avatarUrl: "http://a" });
  });

  it("addIssueCommentForTracker 400s on an empty body", async () => {
    await expect(
      addIssueCommentForTracker(tmpStore(), "github", "42", "   ", ghCommentsFetch(), GH),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("addIssueCommentForTracker 409s for an unconnected tracker", async () => {
    await expect(
      addIssueCommentForTracker(tmpStore(), "github", "42", "hi", ghCommentsFetch(), { token: null, repo: null }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

function ghFetch(over: Partial<{ issue: Record<string, unknown> }> = {}) {
  const issue = {
    id: 1,
    number: 42,
    title: "Original title",
    html_url: "https://github.com/octocat/hello-world/issues/42",
    body: "original body",
    state: "open",
    assignee: { login: "alice" },
    ...over.issue,
  };
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = url as string;
    const method = init?.method ?? "GET";
    if (method === "GET" && u.endsWith("/issues/42")) return ghResponse(issue);
    if (method === "POST" && u.endsWith("/issues/42/comments")) {
      return ghResponse({ id: 9001, html_url: `${issue.html_url}#c`, body: "noted" });
    }
    if (method === "POST" && u.endsWith("/issues")) {
      return ghResponse({ ...issue, number: 7, html_url: "https://github.com/octocat/hello-world/issues/7", ...JSON.parse(init?.body as string) });
    }
    if (method === "DELETE" && u.endsWith("/issues/comments/9001")) return ghResponse(null, 204);
    if (method === "PATCH" && u.endsWith("/issues/42")) {
      return ghResponse({ ...issue, ...JSON.parse(init?.body as string) });
    }
    throw new Error(`unexpected ${method} ${u}`);
  });
}

/**
 * A GitHub stub that also serves the repo `GET /labels` endpoint (SHI-92), so
 * label resolution can validate names. `existing` is the repo's label set.
 */
function ghFetchWithLabels(existing: string[], over: Partial<{ issue: Record<string, unknown> }> = {}) {
  const issue = {
    id: 1,
    number: 42,
    title: "Original title",
    html_url: "https://github.com/octocat/hello-world/issues/42",
    body: "original body",
    state: "open",
    labels: (over.issue?.labels as unknown[]) ?? [],
    assignee: { login: "alice" },
    ...over.issue,
  };
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = url as string;
    const method = init?.method ?? "GET";
    if (method === "GET" && u.includes("/labels")) return ghResponse(existing.map((name) => ({ name })));
    if (method === "GET" && u.endsWith("/issues/42")) return ghResponse(issue);
    if (method === "POST" && u.endsWith("/issues")) {
      return ghResponse({ ...issue, number: 7, html_url: "https://github.com/octocat/hello-world/issues/7", ...JSON.parse(init?.body as string) });
    }
    if (method === "PATCH" && u.endsWith("/issues/42")) {
      return ghResponse({ ...issue, ...JSON.parse(init?.body as string) });
    }
    throw new Error(`unexpected ${method} ${u}`);
  });
}

/** A Linear GraphQL stub routing by query substring (IssueStates / issueUpdate). */
function linearFetch(states: { id: string; name: string; type: string; position: number }[]) {
  const node = {
    id: "uuid-1", identifier: "SHI-9", title: "New doc", url: "https://linear.app/x/SHI-9",
    priority: 0, state: { name: "Todo", type: "unstarted" }, assignee: null,
    team: { states: { nodes: states } },
  };
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const query = (JSON.parse((init?.body as string) ?? "{}").query as string) ?? "";
    if (query.includes("IssueStates")) {
      return jsonResponse({ data: { issue: { id: "uuid-1", team: { states: { nodes: states } } } } });
    }
    if (query.includes("issueUpdate")) {
      return jsonResponse({ data: { issueUpdate: { success: true, issue: node } } });
    }
    throw new Error(`linearFetch: no route for "${query.trim().slice(0, 30)}"`);
  });
}

/** Pull the `issueUpdate` mutation's `input` from a linearFetch call list. */
function lastIssueUpdateInput(fetchImpl: ReturnType<typeof linearFetch>): Record<string, unknown> {
  const call = fetchImpl.mock.calls.find(
    ([, i]) => ((JSON.parse((i?.body as string) ?? "{}").query as string) ?? "").includes("issueUpdate"),
  )!;
  return JSON.parse(call[1]?.body as string).variables.input;
}

describe("issue write services (docs/177)", () => {
  let store: CredentialStore;
  beforeEach(() => {
    store = tmpStore();
  });

  it("create: files an issue and returns a create undo snapshot (docs/187)", async () => {
    const out = await createIssueForTracker(store, "github", "New doc", "tracks docs/187", {}, ghFetch(), GH);
    expect(out.verb).toBe("create");
    expect(out.summary).toContain("octocat/hello-world#7");
    expect(out.undo).toEqual({ kind: "create" });
    expect(out.issue.id).toBe("7");
  });

  it("create: rejects an unconfigured tracker with a 409 ServiceError", async () => {
    await expect(
      createIssueForTracker(store, "linear", "x", ""),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("create: forwards labels to the GitHub adapter (resolved against repo labels) (SHI-92)", async () => {
    const fetchImpl = ghFetchWithLabels(["security", "backend"]);
    const out = await createIssueForTracker(store, "github", "New", "", { labels: ["security"] }, fetchImpl, GH);
    // The POST /issues carried the resolved label.
    const post = fetchImpl.mock.calls.find(([u, i]) => i?.method === "POST" && (u as string).endsWith("/issues"))!;
    expect(JSON.parse(post[1]?.body as string).labels).toEqual(["security"]);
    expect(out.summary).toContain("labels: security");
  });

  it("create: rejects --priority on GitHub with a 422 (SHI-92)", async () => {
    await expect(
      createIssueForTracker(store, "github", "New", "", { priority: "high" }, ghFetch(), GH),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("create: an unknown GitHub label is rejected with the candidate list (SHI-92)", async () => {
    const fetchImpl = ghFetchWithLabels(["security", "backend"]);
    await expect(
      createIssueForTracker(store, "github", "New", "", { labels: ["nope"] }, fetchImpl, GH),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("undo: create → cancels the issue (close as not_planned)", async () => {
    const fetchImpl = ghFetch();
    await undoIssueWrite(
      store,
      { tracker: "github", issueId: "42", undo: { kind: "create" } },
      fetchImpl,
      GH,
    );
    const patch = fetchImpl.mock.calls.find(([, i]) => i?.method === "PATCH")!;
    expect(JSON.parse(patch[1]?.body as string)).toEqual({ state: "closed", state_reason: "not_planned" });
  });

  it("undo: create on Linear cancels via the team's canceled state", async () => {
    store.setLinearToken("lin_x");
    store.setLinearTeam({ id: "team-1", key: "SHI", name: "ShipIt" });
    const fetchImpl = linearFetch([
      { id: "s-todo", name: "Todo", type: "unstarted", position: 0 },
      { id: "s-done", name: "Done", type: "completed", position: 1 },
      { id: "s-cancel", name: "Canceled", type: "canceled", position: 2 },
    ]);
    await undoIssueWrite(store, { tracker: "linear", issueId: "uuid-1", undo: { kind: "create" } }, fetchImpl);
    expect(lastIssueUpdateInput(fetchImpl)).toEqual({ stateId: "s-cancel" });
  });

  it("undo: create on Linear falls back to completed when the team has no canceled state", async () => {
    store.setLinearToken("lin_x");
    store.setLinearTeam({ id: "team-1", key: "SHI", name: "ShipIt" });
    const fetchImpl = linearFetch([
      { id: "s-todo", name: "Todo", type: "unstarted", position: 0 },
      { id: "s-done", name: "Done", type: "completed", position: 1 },
    ]);
    await undoIssueWrite(store, { tracker: "linear", issueId: "uuid-1", undo: { kind: "create" } }, fetchImpl);
    // No canceled state → the first setStatus throws, the service retries with completed.
    expect(lastIssueUpdateInput(fetchImpl)).toEqual({ stateId: "s-done" });
  });

  it("comment: writes and returns a delete-comment undo snapshot", async () => {
    const fetchImpl = ghFetch();
    const out = await commentOnIssueForTracker(store, "github", "42", "noted", fetchImpl, GH);
    expect(out.verb).toBe("comment");
    expect(out.summary).toContain("octocat/hello-world#42");
    expect(out.undo).toEqual({ kind: "comment", commentId: "9001" });
    // docs/189 — the comment body is captured (clipped) for the card's line 2.
    expect(out.content).toEqual({ comment: "noted" });
  });

  it("comment: clips a long body to a single-line preview (docs/189)", async () => {
    const body = `${"a".repeat(400)}\n\nsecond para`;
    const out = await commentOnIssueForTracker(store, "github", "42", body, ghFetch(), GH);
    const preview = out.content?.comment ?? "";
    expect(preview.endsWith("…")).toBe(true);
    expect(preview).not.toContain("\n");
    expect(preview.length).toBeLessThanOrEqual(281); // 280 + ellipsis
  });

  it("edit: snapshots the prior title for undo", async () => {
    const out = await updateIssueForTracker(store, "github", "42", { title: "New title" }, ghFetch(), GH);
    expect(out.verb).toBe("edit");
    expect(out.undo).toEqual({ kind: "edit", previousTitle: "Original title" });
    // docs/189 — the title delta is surfaced on line 2.
    expect(out.content).toEqual({ title: { before: "Original title", after: "New title" } });
  });

  it("edit: a description-only edit flags descriptionChanged (docs/189)", async () => {
    const out = await updateIssueForTracker(store, "github", "42", { description: "new body" }, ghFetch(), GH);
    expect(out.content).toEqual({ descriptionChanged: true });
  });

  it("edit: labels are additive (merged with existing) and snapshot the prior set (SHI-92)", async () => {
    const fetchImpl = ghFetchWithLabels(["existing", "added"], { issue: { labels: [{ name: "existing" }] } });
    const out = await updateIssueForTracker(store, "github", "42", { labels: ["added"] }, fetchImpl, GH);
    // PATCH carried the merged set (existing kept + added), not just "added".
    const patch = fetchImpl.mock.calls.find(([, i]) => i?.method === "PATCH")!;
    expect(JSON.parse(patch[1]?.body as string).labels).toEqual(["existing", "added"]);
    // Undo restores the prior set.
    expect(out.undo).toMatchObject({ kind: "edit", previousLabels: ["existing"] });
    // docs/189 — a labels-only edit still shows what changed on line 2 via `attrs`.
    expect(out.content?.attrs).toContain("labels:");
  });

  it("undo: edit → restores the prior label set by replacing (SHI-92)", async () => {
    const fetchImpl = ghFetchWithLabels(["existing"], { issue: { labels: [{ name: "added" }] } });
    await undoIssueWrite(
      store,
      { tracker: "github", issueId: "42", undo: { kind: "edit", previousLabels: ["existing"] } },
      fetchImpl,
      GH,
    );
    const patch = fetchImpl.mock.calls.find(([, i]) => i?.method === "PATCH")!;
    expect(JSON.parse(patch[1]?.body as string).labels).toEqual(["existing"]);
  });

  it("undo: edit → restores the prior parent on Linear (SHI-206)", async () => {
    store.setLinearToken("lin_x");
    store.setLinearTeam(TEAM);
    const node = {
      id: "uuid-1", identifier: "SHI-9", title: "Doc", url: "https://linear.app/x/SHI-9",
      priority: 0, priorityLabel: "No priority", state: { name: "Todo" }, assignee: null, labels: { nodes: [] },
    };
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const query = (JSON.parse((init?.body as string) ?? "{}").query as string) ?? "";
      if (query.includes("IssueId")) return jsonResponse({ data: { issue: { id: "uuid-prior" } } });
      if (query.includes("issueUpdate")) return jsonResponse({ data: { issueUpdate: { success: true, issue: node } } });
      throw new Error(`no route for "${query.trim().slice(0, 30)}"`);
    });
    await undoIssueWrite(
      store,
      { tracker: "linear", issueId: "uuid-1", undo: { kind: "edit", previousParentId: "uuid-prior" } },
      fetchImpl as unknown as typeof fetch,
    );
    // The reverse write re-parents to the snapshotted prior id (resolved verbatim).
    const update = fetchImpl.mock.calls.find(([, i]) => ((JSON.parse((i?.body as string) ?? "{}").query as string) ?? "").includes("issueUpdate"))!;
    expect(JSON.parse(update[1]?.body as string).variables.input).toEqual({ parentId: "uuid-prior" });
  });

  it("edit: snapshots the prior priority level for undo on Linear (SHI-92)", async () => {
    store.setLinearToken("lin_x");
    store.setLinearTeam(TEAM);
    const node = {
      id: "uuid-1", identifier: "SHI-9", title: "Doc", url: "https://linear.app/x/SHI-9",
      priority: 2, priorityLabel: "High", state: { name: "Todo", type: "unstarted" }, assignee: null,
      labels: { nodes: [] },
    };
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const query = (JSON.parse((init?.body as string) ?? "{}").query as string) ?? "";
      if (query.includes("query Issue")) {
        // Prior issue has priority level "low" (numeric 4).
        return jsonResponse({ data: { issue: { ...node, priority: 4, priorityLabel: "Low" } } });
      }
      if (query.includes("IssueId")) return jsonResponse({ data: { issue: { id: "uuid-1" } } });
      if (query.includes("issueUpdate")) return jsonResponse({ data: { issueUpdate: { success: true, issue: node } } });
      throw new Error(`no route for "${query.trim().slice(0, 30)}"`);
    });
    const out = await updateIssueForTracker(store, "linear", "SHI-9", { priority: "high" }, fetchImpl as unknown as typeof fetch);
    // The issueUpdate input mapped "high" → numeric 2.
    const update = fetchImpl.mock.calls.find(([, i]) => ((JSON.parse((i?.body as string) ?? "{}").query as string) ?? "").includes("issueUpdate"))!;
    expect(JSON.parse(update[1]?.body as string).variables.input).toEqual({ priority: 2 });
    expect(out.undo).toMatchObject({ kind: "edit", previousPriority: "low" });
  });

  it("edit: reparents on Linear, resolves the parentId, and snapshots the prior parent (SHI-206)", async () => {
    store.setLinearToken("lin_x");
    store.setLinearTeam(TEAM);
    const node = {
      id: "uuid-1", identifier: "SHI-9", title: "Doc", url: "https://linear.app/x/SHI-9",
      priority: 2, priorityLabel: "High", state: { name: "Todo", type: "unstarted" }, assignee: null,
      labels: { nodes: [] },
    };
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const query = (JSON.parse((init?.body as string) ?? "{}").query as string) ?? "";
      if (query.includes("query Issue")) {
        // Prior issue already nests under SHI-100 → its internal id is snapshotted.
        return jsonResponse({ data: { issue: { ...node, parent: { id: "uuid-old", identifier: "SHI-100" } } } });
      }
      if (query.includes("IssueId")) return jsonResponse({ data: { issue: { id: "uuid-1" } } });
      if (query.includes("issueUpdate")) {
        return jsonResponse({ data: { issueUpdate: { success: true, issue: { ...node, parent: { id: "uuid-204", identifier: "SHI-204" } } } } });
      }
      throw new Error(`no route for "${query.trim().slice(0, 30)}"`);
    });
    const out = await updateIssueForTracker(store, "linear", "SHI-9", { parent: "SHI-204" }, fetchImpl as unknown as typeof fetch);
    // The issueUpdate input carries the resolved parentId.
    const update = fetchImpl.mock.calls.find(([, i]) => ((JSON.parse((i?.body as string) ?? "{}").query as string) ?? "").includes("issueUpdate"))!;
    expect(JSON.parse(update[1]?.body as string).variables.input).toEqual({ parentId: "uuid-1" });
    expect(out.undo).toMatchObject({ kind: "edit", previousParentId: "uuid-old" });
    // docs/189 — the reparent is surfaced on line 2.
    expect(out.content?.attrs).toContain("parent → SHI-204");
  });

  it("edit: detaching on Linear snapshots previousParentId null and sends parentId null (SHI-206)", async () => {
    store.setLinearToken("lin_x");
    store.setLinearTeam(TEAM);
    const node = {
      id: "uuid-1", identifier: "SHI-9", title: "Doc", url: "https://linear.app/x/SHI-9",
      priority: 0, priorityLabel: "No priority", state: { name: "Todo", type: "unstarted" }, assignee: null,
      labels: { nodes: [] },
    };
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const query = (JSON.parse((init?.body as string) ?? "{}").query as string) ?? "";
      // Prior issue has no parent → previousParentId is null (undo would detach).
      if (query.includes("query Issue")) return jsonResponse({ data: { issue: node } });
      if (query.includes("IssueId")) return jsonResponse({ data: { issue: { id: "uuid-1" } } });
      if (query.includes("issueUpdate")) return jsonResponse({ data: { issueUpdate: { success: true, issue: node } } });
      throw new Error(`no route for "${query.trim().slice(0, 30)}"`);
    });
    const out = await updateIssueForTracker(store, "linear", "SHI-9", { parent: null }, fetchImpl as unknown as typeof fetch);
    const update = fetchImpl.mock.calls.find(([, i]) => ((JSON.parse((i?.body as string) ?? "{}").query as string) ?? "").includes("issueUpdate"))!;
    expect(JSON.parse(update[1]?.body as string).variables.input).toEqual({ parentId: null });
    expect(out.undo).toMatchObject({ kind: "edit", previousParentId: null });
    expect(out.content?.attrs).toContain("parent → none");
  });

  it("status: snapshots the prior native status name for undo", async () => {
    // Prior state is open → native name "Open".
    const out = await setIssueStatusForTracker(store, "github", "42", "completed", ghFetch(), GH);
    expect(out.undo).toEqual({ kind: "status", previousStatus: "Open" });
    // docs/189 — the status transition is surfaced on line 2 (from the prior name).
    expect(out.content?.status?.from).toBe("Open");
    expect(out.content?.status?.to).toBeTruthy();
  });

  it("assignee: snapshots the prior internal id (login), not the display name", async () => {
    const out = await setIssueAssigneeForTracker(store, "github", "42", "bob", ghFetch(), GH);
    expect(out.undo).toEqual({ kind: "assignee", previousAssigneeId: "alice" });
    // docs/189 — the new assignee name is surfaced on line 2.
    expect(typeof out.content?.assignee).toBe("string");
  });

  it("assignee: prior id is null when the issue was unassigned", async () => {
    const fetchImpl = ghFetch({ issue: { assignee: null } });
    const out = await setIssueAssigneeForTracker(store, "github", "42", "bob", fetchImpl, GH);
    expect(out.undo).toEqual({ kind: "assignee", previousAssigneeId: null });
  });

  it("assignee: content.assignee is null when clearing the assignee (docs/189)", async () => {
    const out = await setIssueAssigneeForTracker(store, "github", "42", null, ghFetch(), GH);
    expect(out.summary).toContain("unassigned");
    expect(out.content).toEqual({ assignee: null });
  });

  it("maps an ambiguous status to a 422 ServiceError listing options", async () => {
    await expect(
      setIssueStatusForTracker(store, "github", "42", "in review", ghFetch(), GH),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects an unconfigured tracker with a ServiceError", async () => {
    await expect(
      getIssueForTracker(store, "linear", "TRACKER-1"),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it("undo: comment → deletes the comment by id", async () => {
    const fetchImpl = ghFetch();
    await undoIssueWrite(
      store,
      { tracker: "github", issueId: "42", undo: { kind: "comment", commentId: "9001" } },
      fetchImpl,
      GH,
    );
    expect(fetchImpl.mock.calls.some(([u, i]) => i?.method === "DELETE" && (u as string).includes("/issues/comments/9001"))).toBe(true);
  });

  it("undo: assignee → replays the prior internal id verbatim (raw)", async () => {
    const fetchImpl = ghFetch();
    await undoIssueWrite(
      store,
      { tracker: "github", issueId: "42", undo: { kind: "assignee", previousAssigneeId: "alice" } },
      fetchImpl,
      GH,
    );
    const patch = fetchImpl.mock.calls.find(([, i]) => i?.method === "PATCH")!;
    expect(JSON.parse(patch[1]?.body as string)).toEqual({ assignees: ["alice"] });
  });
});
