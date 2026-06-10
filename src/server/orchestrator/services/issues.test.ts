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

/** A GitHub REST stub routing on method + path tail. */
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
  });

  it("edit: snapshots the prior title for undo", async () => {
    const out = await updateIssueForTracker(store, "github", "42", { title: "New title" }, ghFetch(), GH);
    expect(out.verb).toBe("edit");
    expect(out.undo).toEqual({ kind: "edit", previousTitle: "Original title" });
  });

  it("edit: labels are additive (merged with existing) and snapshot the prior set (SHI-92)", async () => {
    const fetchImpl = ghFetchWithLabels(["existing", "added"], { issue: { labels: [{ name: "existing" }] } });
    const out = await updateIssueForTracker(store, "github", "42", { labels: ["added"] }, fetchImpl, GH);
    // PATCH carried the merged set (existing kept + added), not just "added".
    const patch = fetchImpl.mock.calls.find(([, i]) => i?.method === "PATCH")!;
    expect(JSON.parse(patch[1]?.body as string).labels).toEqual(["existing", "added"]);
    // Undo restores the prior set.
    expect(out.undo).toMatchObject({ kind: "edit", previousLabels: ["existing"] });
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

  it("status: snapshots the prior native status name for undo", async () => {
    // Prior state is open → native name "Open".
    const out = await setIssueStatusForTracker(store, "github", "42", "completed", ghFetch(), GH);
    expect(out.undo).toEqual({ kind: "status", previousStatus: "Open" });
  });

  it("assignee: snapshots the prior internal id (login), not the display name", async () => {
    const out = await setIssueAssigneeForTracker(store, "github", "42", "bob", ghFetch(), GH);
    expect(out.undo).toEqual({ kind: "assignee", previousAssigneeId: "alice" });
  });

  it("assignee: prior id is null when the issue was unassigned", async () => {
    const fetchImpl = ghFetch({ issue: { assignee: null } });
    const out = await setIssueAssigneeForTracker(store, "github", "42", "bob", fetchImpl, GH);
    expect(out.undo).toEqual({ kind: "assignee", previousAssigneeId: null });
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
