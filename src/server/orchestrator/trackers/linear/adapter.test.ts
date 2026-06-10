import { describe, it, expect, vi } from "vitest";
import {
  LinearTracker,
  listLinearTeams,
  resolveLinearStateId,
  resolveLinearPriority,
  stripLinearUrlSlug,
  LINEAR_GRAPHQL_ENDPOINT,
} from "./adapter.js";
import { TrackerResolutionError } from "../tracker.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fetch stub that routes by a substring of the GraphQL `query`/`mutation`. */
function routerFetch(routes: { match: string; data: unknown }[]) {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const query = (JSON.parse((init?.body as string) ?? "{}").query as string) ?? "";
    const route = routes.find((r) => query.includes(r.match));
    if (!route) throw new Error(`routerFetch: no route for query starting "${query.trim().slice(0, 30)}"`);
    return jsonResponse({ data: route.data });
  });
}

/** A minimal issue node matching ISSUE_FIELDS_WITH_STATES for write responses. */
function issueNode(over: Record<string, unknown> = {}) {
  return {
    id: "uuid-1",
    identifier: "SHI-1",
    title: "Thing",
    url: "https://linear.app/x/SHI-1",
    description: "d",
    priority: 1,
    priorityLabel: "Urgent",
    state: { name: "In Progress", type: "started" },
    assignee: { id: "u1", name: "nik", displayName: "Nik", avatarUrl: "http://a" },
    team: { states: { nodes: [{ id: "s1", name: "Todo", type: "unstarted", position: 0 }] } },
    ...over,
  };
}

const STATES = [
  { id: "s-todo", name: "Todo", type: "unstarted", position: 0 },
  { id: "s-prog", name: "In Progress", type: "started", position: 1 },
  { id: "s-rev", name: "In Review", type: "started", position: 2 },
  { id: "s-done", name: "Done", type: "completed", position: 3 },
];

const TEAM = { id: "team-123", key: "SHI", name: "ShipIt" };

describe("LinearTracker", () => {
  it("reports unconfigured without a token or team", () => {
    expect(new LinearTracker({ token: null, team: null }).isConfigured()).toBe(false);
    expect(new LinearTracker({ token: "t", team: null }).isConfigured()).toBe(false);
    expect(new LinearTracker({ token: null, team: TEAM }).isConfigured()).toBe(false);
    expect(new LinearTracker({ token: "t", team: TEAM }).isConfigured()).toBe(true);
  });

  it("exposes binding info for the sub-tab", () => {
    const info = new LinearTracker({ token: "t", team: TEAM }).info();
    expect(info).toEqual({
      id: "linear",
      label: "Linear",
      configured: true,
      binding: { key: "SHI", name: "ShipIt" },
    });
  });

  it("lists issues, maps fields, and sorts by priority", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        data: {
          team: {
            issues: {
              nodes: [
                {
                  id: "i2",
                  identifier: "SHI-2",
                  title: "Low priority thing",
                  url: "https://linear.app/x/SHI-2",
                  description: "desc 2",
                  priority: 4,
                  priorityLabel: "Low",
                  state: { name: "Todo", type: "unstarted" },
                  assignee: { displayName: "Nik", avatarUrl: "http://a/avatar.png" },
                },
                {
                  id: "i1",
                  identifier: "SHI-1",
                  title: "Urgent thing",
                  url: "https://linear.app/x/SHI-1",
                  description: null,
                  priority: 1,
                  priorityLabel: "Urgent",
                  state: { name: "In Progress", type: "started" },
                  assignee: null,
                },
              ],
            },
          },
        },
      }),
    );

    const tracker = new LinearTracker({ token: "lin_api_x", team: TEAM, fetchImpl });
    const issues = await tracker.listIssues();

    // Urgent sorts before Low.
    expect(issues.map((i) => i.identifier)).toEqual(["SHI-1", "SHI-2"]);
    expect(issues[0].priority).toEqual({ level: "urgent", sortOrder: 0, label: "Urgent" });
    expect(issues[0].status).toEqual({ name: "In Progress", type: "started" });
    expect(issues[0].assignee).toBeUndefined();
    expect(issues[1].priority.level).toBe("low");
    expect(issues[1].assignee).toEqual({ name: "Nik", avatarUrl: "http://a/avatar.png" });
    expect(issues[1].description).toBe("desc 2");

    // Auth header carries the raw token (personal API key form, no Bearer).
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(LINEAR_GRAPHQL_ENDPOINT);
    expect((init?.headers as Record<string, string>).Authorization).toBe("lin_api_x");
  });

  it("throws a helpful error on 401", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));
    const tracker = new LinearTracker({ token: "bad", team: TEAM, fetchImpl });
    await expect(tracker.listIssues()).rejects.toThrow(/rejected the API token/);
  });

  it("surfaces GraphQL errors", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ message: "boom" }] }));
    const tracker = new LinearTracker({ token: "t", team: TEAM, fetchImpl });
    await expect(tracker.listIssues()).rejects.toThrow(/boom/);
  });

  it("throws when listing without configuration", async () => {
    await expect(new LinearTracker({ token: null, team: null }).listIssues()).rejects.toThrow(/not configured/);
  });

  it("excludes completed + canceled by default, only canceled when includeDone", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ data: { team: { issues: { nodes: [] } } } }),
    );
    const tracker = new LinearTracker({ token: "t", team: TEAM, fetchImpl });

    await tracker.listIssues();
    const defaultVars = JSON.parse((fetchImpl.mock.calls[0][1]?.body as string)).variables;
    expect(defaultVars.excludedTypes).toEqual(["completed", "canceled"]);

    await tracker.listIssues({ includeDone: true });
    const doneVars = JSON.parse((fetchImpl.mock.calls[1][1]?.body as string)).variables;
    expect(doneVars.excludedTypes).toEqual(["canceled"]);
  });
});

describe("resolveLinearStateId (docs/177 status mapping)", () => {
  it("matches a native state name case-insensitively", () => {
    expect(resolveLinearStateId("in review", STATES)).toBe("s-rev");
  });

  it("matches a normalized type", () => {
    expect(resolveLinearStateId("completed", STATES)).toBe("s-done");
  });

  it("picks the earliest-by-position state when several share a type", () => {
    // Both In Progress and In Review are `started`; the earlier position wins.
    expect(resolveLinearStateId("started", STATES)).toBe("s-prog");
  });

  it("throws with the valid options on an unknown status", () => {
    try {
      resolveLinearStateId("frobnicate", STATES);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TrackerResolutionError);
      expect((err as TrackerResolutionError).kind).toBe("status");
      expect((err as TrackerResolutionError).options).toContain("In Review");
    }
  });
});

describe("LinearTracker writes (docs/177)", () => {
  it("creates a comment and returns its id for undo", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueId", data: { issue: { id: "uuid-1" } } },
      { match: "commentCreate", data: { commentCreate: { success: true, comment: { id: "c1", url: "http://c", body: "hi" } } } },
    ]);
    const tracker = new LinearTracker({ token: "t", team: TEAM, fetchImpl });
    expect(await tracker.addComment("SHI-1", "hi")).toEqual({ id: "c1", url: "http://c", body: "hi" });
  });

  it("deletes a comment", async () => {
    const fetchImpl = routerFetch([{ match: "commentDelete", data: { commentDelete: { success: true } } }]);
    const tracker = new LinearTracker({ token: "t", team: TEAM, fetchImpl });
    await expect(tracker.deleteComment("c1")).resolves.toBeUndefined();
  });

  it("creates an issue against the bound team (docs/187)", async () => {
    const fetchImpl = routerFetch([
      { match: "issueCreate", data: { issueCreate: { success: true, issue: issueNode({ identifier: "SHI-9", title: "New doc" }) } } },
    ]);
    const tracker = new LinearTracker({ token: "t", team: TEAM, fetchImpl });
    const issue = await tracker.createIssue({ title: "New doc", body: "tracks docs/187" });
    expect(issue.identifier).toBe("SHI-9");
    const input = JSON.parse((fetchImpl.mock.calls[0][1]?.body as string)).variables.input;
    expect(input).toEqual({ teamId: "team-123", title: "New doc", description: "tracks docs/187" });
  });

  it("returns a slug-free issue URL on create (no title leak)", async () => {
    const fetchImpl = routerFetch([
      {
        match: "issueCreate",
        data: {
          issueCreate: {
            success: true,
            issue: issueNode({
              identifier: "SHI-9",
              title: "Redesign the secret auth flow",
              // Linear's API appends a title-derived slug to the URL.
              url: "https://linear.app/shipit/issue/SHI-9/redesign-the-secret-auth-flow",
            }),
          },
        },
      },
    ]);
    const tracker = new LinearTracker({ token: "t", team: TEAM, fetchImpl });
    const issue = await tracker.createIssue({ title: "Redesign the secret auth flow", body: "" });
    expect(issue.url).toBe("https://linear.app/shipit/issue/SHI-9");
  });

  it("throws creating an issue without a team binding", async () => {
    const tracker = new LinearTracker({ token: "t", team: null });
    await expect(tracker.createIssue({ title: "x", body: "" })).rejects.toThrow(/team binding/);
  });

  it("creates with resolved labelIds and a mapped priority (SHI-92)", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueLabels", data: { issueLabels: { nodes: [{ id: "lab-sec", name: "security" }, { id: "lab-be", name: "backend" }] } } },
      { match: "issueCreate", data: { issueCreate: { success: true, issue: issueNode({ identifier: "SHI-9" }) } } },
    ]);
    const tracker = new LinearTracker({ token: "t", team: TEAM, fetchImpl });
    await tracker.createIssue({ title: "New", body: "", labels: ["security"], priority: "high" });
    const input = JSON.parse(
      fetchImpl.mock.calls.find(([, i]) => ((JSON.parse((i?.body as string) ?? "{}").query as string) ?? "").includes("issueCreate"))![1]?.body as string,
    ).variables.input;
    expect(input).toMatchObject({ teamId: "team-123", title: "New", labelIds: ["lab-sec"], priority: 2 });
  });

  it("rejects an unknown label with the candidate list (no create) (SHI-92)", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueLabels", data: { issueLabels: { nodes: [{ id: "lab-sec", name: "security" }] } } },
    ]);
    const tracker = new LinearTracker({ token: "t", team: TEAM, fetchImpl });
    await expect(tracker.createIssue({ title: "New", body: "", labels: ["nope"] })).rejects.toMatchObject({
      kind: "label",
      options: ["security"],
    });
    // Only the labels query ran; issueCreate never fired.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces labels on a read (SHI-92)", async () => {
    const fetchImpl = routerFetch([
      { match: "query Issue", data: { issue: issueNode({ labels: { nodes: [{ name: "security" }, { name: "backend" }] } }) } },
    ]);
    const tracker = new LinearTracker({ token: "t", team: TEAM, fetchImpl });
    const issue = await tracker.getIssue("SHI-1");
    expect(issue?.labels).toEqual(["security", "backend"]);
  });

  it("edits title/description via issueUpdate", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueId", data: { issue: { id: "uuid-1" } } },
      { match: "issueUpdate", data: { issueUpdate: { success: true, issue: issueNode({ title: "New" }) } } },
    ]);
    const tracker = new LinearTracker({ token: "t", team: TEAM, fetchImpl });
    const issue = await tracker.updateIssue("SHI-1", { title: "New", description: "d2" });
    expect(issue.title).toBe("New");
    const input = JSON.parse((fetchImpl.mock.calls[1][1]?.body as string)).variables.input;
    expect(input).toEqual({ title: "New", description: "d2" });
  });

  it("sets status by normalized type → resolved stateId", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueStates", data: { issue: { id: "uuid-1", team: { states: { nodes: STATES } } } } },
      { match: "issueUpdate", data: { issueUpdate: { success: true, issue: issueNode() } } },
    ]);
    const tracker = new LinearTracker({ token: "t", team: TEAM, fetchImpl });
    await tracker.setStatus("SHI-1", "completed");
    const input = JSON.parse((fetchImpl.mock.calls[1][1]?.body as string)).variables.input;
    expect(input).toEqual({ stateId: "s-done" });
  });

  it("rejects an unknown status with the valid options (no write)", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueStates", data: { issue: { id: "uuid-1", team: { states: { nodes: STATES } } } } },
    ]);
    const tracker = new LinearTracker({ token: "t", team: TEAM, fetchImpl });
    await expect(tracker.setStatus("SHI-1", "frobnicate")).rejects.toThrow(TrackerResolutionError);
    // Only the states query ran; the update never fired.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("resolves assignee `me` to the viewer id", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueId", data: { issue: { id: "uuid-1" } } },
      { match: "Viewer", data: { viewer: { id: "me-id" } } },
      { match: "issueUpdate", data: { issueUpdate: { success: true, issue: issueNode() } } },
    ]);
    const tracker = new LinearTracker({ token: "t", team: TEAM, fetchImpl });
    await tracker.setAssignee("SHI-1", "me");
    const input = JSON.parse((fetchImpl.mock.calls[2][1]?.body as string)).variables.input;
    expect(input).toEqual({ assigneeId: "me-id" });
  });

  it("resolves assignee by display name to an assigneeId", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueId", data: { issue: { id: "uuid-1" } } },
      { match: "Users", data: { users: { nodes: [{ id: "u9", name: "nik", displayName: "Nik Z", email: "n@x" }] } } },
      { match: "issueUpdate", data: { issueUpdate: { success: true, issue: issueNode() } } },
    ]);
    const tracker = new LinearTracker({ token: "t", team: TEAM, fetchImpl });
    await tracker.setAssignee("SHI-1", "Nik Z");
    const input = JSON.parse((fetchImpl.mock.calls[2][1]?.body as string)).variables.input;
    expect(input).toEqual({ assigneeId: "u9" });
  });

  it("returns candidates when an assignee name has no match", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueId", data: { issue: { id: "uuid-1" } } },
      { match: "Users", data: { users: { nodes: [{ id: "u9", name: "nik", displayName: "Nik Z", email: "n@x" }] } } },
    ]);
    const tracker = new LinearTracker({ token: "t", team: TEAM, fetchImpl });
    await expect(tracker.setAssignee("SHI-1", "Nobody")).rejects.toMatchObject({
      kind: "assignee",
      options: ["Nik Z"],
    });
  });

  it("unassigns with null (no name resolution)", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueId", data: { issue: { id: "uuid-1" } } },
      { match: "issueUpdate", data: { issueUpdate: { success: true, issue: issueNode() } } },
    ]);
    const tracker = new LinearTracker({ token: "t", team: TEAM, fetchImpl });
    await tracker.setAssignee("SHI-1", null);
    const input = JSON.parse((fetchImpl.mock.calls[1][1]?.body as string)).variables.input;
    expect(input).toEqual({ assigneeId: null });
  });

  it("assigns a raw internal id verbatim (undo replay — no resolution)", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueId", data: { issue: { id: "uuid-1" } } },
      { match: "issueUpdate", data: { issueUpdate: { success: true, issue: issueNode() } } },
    ]);
    const tracker = new LinearTracker({ token: "t", team: TEAM, fetchImpl });
    await tracker.setAssignee("SHI-1", "raw-uuid-7", { raw: true });
    // No Users query — the id is used directly.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const input = JSON.parse((fetchImpl.mock.calls[1][1]?.body as string)).variables.input;
    expect(input).toEqual({ assigneeId: "raw-uuid-7" });
  });

  it("getIssue surfaces assigneeId and availableStatuses for the agent", async () => {
    const fetchImpl = routerFetch([
      { match: "query Issue", data: { issue: issueNode({ team: { states: { nodes: STATES } } }) } },
    ]);
    const tracker = new LinearTracker({ token: "t", team: TEAM, fetchImpl });
    const issue = await tracker.getIssue("SHI-1");
    expect(issue?.assigneeId).toBe("u1");
    expect(issue?.availableStatuses?.map((s) => s.name)).toContain("In Review");
  });
});

describe("resolveLinearPriority (SHI-92)", () => {
  it("maps normalized levels to Linear's numeric field", () => {
    expect(resolveLinearPriority("urgent")).toBe(1);
    expect(resolveLinearPriority("high")).toBe(2);
    expect(resolveLinearPriority("medium")).toBe(3);
    expect(resolveLinearPriority("low")).toBe(4);
    expect(resolveLinearPriority("none")).toBe(0);
  });

  it("accepts native names case-insensitively (incl. 'No priority')", () => {
    expect(resolveLinearPriority("High")).toBe(2);
    expect(resolveLinearPriority("No priority")).toBe(0);
  });

  it("throws with the valid options on an unknown priority", () => {
    try {
      resolveLinearPriority("frobnicate");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TrackerResolutionError);
      expect((err as TrackerResolutionError).kind).toBe("priority");
      expect((err as TrackerResolutionError).options).toContain("high");
    }
  });
});

describe("stripLinearUrlSlug", () => {
  it("strips a title slug, keeping …/issue/<IDENTIFIER>", () => {
    expect(stripLinearUrlSlug("https://linear.app/shipit/issue/SHI-28/redesign-the-auth-flow")).toBe(
      "https://linear.app/shipit/issue/SHI-28",
    );
  });

  it("leaves an already slug-free URL unchanged", () => {
    expect(stripLinearUrlSlug("https://linear.app/shipit/issue/SHI-28")).toBe(
      "https://linear.app/shipit/issue/SHI-28",
    );
  });

  it("drops a trailing slash but keeps the identifier", () => {
    expect(stripLinearUrlSlug("https://linear.app/shipit/issue/SHI-28/")).toBe(
      "https://linear.app/shipit/issue/SHI-28",
    );
  });

  it("returns a non-matching URL untouched", () => {
    expect(stripLinearUrlSlug("https://example.com/whatever")).toBe("https://example.com/whatever");
    expect(stripLinearUrlSlug("https://linear.app/shipit/team/SHI/all")).toBe(
      "https://linear.app/shipit/team/SHI/all",
    );
  });
});

describe("listLinearTeams", () => {
  it("returns the workspace teams", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { teams: { nodes: [TEAM, { id: "t2", key: "ENG", name: "Engineering" }] } } }),
    );
    const teams = await listLinearTeams("tok", fetchImpl);
    expect(teams).toEqual([TEAM, { id: "t2", key: "ENG", name: "Engineering" }]);
  });
});
