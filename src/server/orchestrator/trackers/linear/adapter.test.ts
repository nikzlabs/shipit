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

/**
 * docs/248 — the team key comes from the repository's declaration, so the
 * adapter resolves it to Linear's internal team id lazily on the first call that
 * needs one. Every stub therefore answers `TeamByKey` first; it is prepended
 * rather than declared per test because it is plumbing, not behavior under test.
 */
const TEAM_LOOKUP = { match: "TeamByKey", data: { teams: { nodes: [{ id: "team-123", key: "SHI" }] } } };

/** A fetch stub that routes by a substring of the GraphQL `query`/`mutation`. */
function routerFetch(routes: { match: string; data: unknown }[]) {
  const all = [TEAM_LOOKUP, ...routes];
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const query = (JSON.parse((init?.body as string) ?? "{}").query as string) ?? "";
    const route = all.find((r) => query.includes(r.match));
    if (!route) throw new Error(`routerFetch: no route for query starting "${query.trim().slice(0, 30)}"`);
    return jsonResponse({ data: route.data });
  });
}

/**
 * The GraphQL `variables` of the call whose query matched `match`. Selecting the
 * call by its query rather than by index keeps these assertions stable when the
 * adapter adds a lookup ahead of the operation under test (as the lazy team
 * resolution did).
 */
function varsFor(fetchImpl: { mock: { calls: readonly (readonly unknown[])[] } }, match: string): Record<string, unknown> {
  const bodyOf = (c: readonly unknown[]): string => ((c[1] as RequestInit | undefined)?.body as string) ?? "{}";
  const call = fetchImpl.mock.calls.find((c) =>
    ((JSON.parse(bodyOf(c)) as { query?: string }).query ?? "").includes(match),
  );
  if (!call) throw new Error(`varsFor: no call matched "${match}"`);
  return (JSON.parse(bodyOf(call)) as { variables: Record<string, unknown> }).variables;
}

/** The `input` variable of the call whose query matched `match`. */
function inputFor(fetchImpl: { mock: { calls: readonly (readonly unknown[])[] } }, match: string): Record<string, unknown> {
  return varsFor(fetchImpl, match).input as Record<string, unknown>;
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
    team: { key: "SHI", states: { nodes: [{ id: "s1", name: "Todo", type: "unstarted", position: 0 }] } },
    ...over,
  };
}

const STATES = [
  { id: "s-todo", name: "Todo", type: "unstarted", position: 0 },
  { id: "s-prog", name: "In Progress", type: "started", position: 1 },
  { id: "s-rev", name: "In Review", type: "started", position: 2 },
  { id: "s-done", name: "Done", type: "completed", position: 3 },
];

describe("LinearTracker", () => {
  it("reports unconfigured without a token or team", () => {
    expect(new LinearTracker({ token: null, teamKey: null }).isConfigured()).toBe(false);
    expect(new LinearTracker({ token: "t", teamKey: null }).isConfigured()).toBe(false);
    expect(new LinearTracker({ token: null, teamKey: "SHI" }).isConfigured()).toBe(false);
    expect(new LinearTracker({ token: "t", teamKey: "SHI" }).isConfigured()).toBe(true);
  });

  it("exposes binding info for the sub-tab", () => {
    // docs/248 — the id names the destination (the declared team), the label is
    // the declared name, and the binding is the team key. The workspace comes
    // from the credential (req 23), so nothing here identifies one.
    const info = new LinearTracker({ token: "t", teamKey: "SHI", name: "roadmap" }).info();
    expect(info).toEqual({
      id: "linear:SHI",
      label: "roadmap",
      name: "roadmap",
      kind: "linear",
      configured: true,
      binding: { key: "SHI", name: "SHI" },
    });
  });

  it("lists issues, maps fields, and sorts by priority", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      ((JSON.parse((init?.body as string) ?? "{}") as { query?: string }).query ?? "").includes(
        "TeamByKey",
      )
        ? jsonResponse({ data: TEAM_LOOKUP.data })
        : jsonResponse({
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
                  state: { name: "In Progress", type: "started", color: "#f2c94c" },
                  assignee: null,
                },
              ],
            },
          },
        },
      }),
    );

    const tracker = new LinearTracker({ token: "lin_api_x", teamKey: "SHI", fetchImpl });
    const issues = await tracker.listIssues();

    // Urgent sorts before Low.
    expect(issues.map((i) => i.identifier)).toEqual(["SHI-1", "SHI-2"]);
    expect(issues[0].priority).toEqual({ level: "urgent", sortOrder: 0, label: "Urgent" });
    expect(issues[0].status).toEqual({ name: "In Progress", type: "started", color: "#f2c94c" });
    expect(issues[0].assignee).toBeUndefined();
    expect(issues[1].priority.level).toBe("low");
    expect(issues[1].assignee).toEqual({ name: "Nik", avatarUrl: "http://a/avatar.png" });
    expect(issues[1].description).toBe("desc 2");

    // Auth header carries the raw token (personal API key form, no Bearer).
    const [url, init] = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1];
    expect(url).toBe(LINEAR_GRAPHQL_ENDPOINT);
    expect((init?.headers as Record<string, string>).Authorization).toBe("lin_api_x");
  });

  it("throws a helpful error on 401", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));
    const tracker = new LinearTracker({ token: "bad", teamKey: "SHI", fetchImpl });
    await expect(tracker.listIssues()).rejects.toThrow(/rejected the API token/);
  });

  it("surfaces GraphQL errors", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ message: "boom" }] }));
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await expect(tracker.listIssues()).rejects.toThrow(/boom/);
  });

  // docs/248 reqs 11/17 — Linear's `issue(id:)` is workspace-global, so an id for
  // another team resolves. An operation that named THIS tracker must not act on
  // it: the reference resolver cannot close this, because a raw `tracker=`+`id=`
  // pair over the agent relay never passes through the resolver.
  it("refuses an issue that belongs to a different team than the declared one", async () => {
    const fetchImpl = routerFetch([
      { match: "query Issue", data: { issue: issueNode({ identifier: "ENG-7", team: { key: "ENG" } }) } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await expect(tracker.getIssue("ENG-7")).rejects.toThrow(/belongs to team `ENG`, not to `SHI`/);
  });

  it("refuses a cross-team id on a WRITE, before the mutation runs", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueId", data: { issue: { id: "uuid-eng", team: { key: "ENG" } } } },
      { match: "issueUpdate", data: { issueUpdate: { success: true, issue: issueNode() } } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await expect(tracker.addComment("ENG-7", "hi")).rejects.toThrow(/not to `SHI`/);
    // The mutation never fired — no substitution, and no write to the wrong team.
    const wrote = fetchImpl.mock.calls.some((c) =>
      ((JSON.parse(((c[1] as RequestInit | undefined)?.body as string) ?? "{}") as { query?: string }).query ?? "")
        .includes("AddComment"),
    );
    expect(wrote).toBe(false);
  });

  // A response that carried no team is unverifiable, so it is refused for the
  // same reason rather than waved through.
  it("refuses an issue whose team the response did not carry", async () => {
    const fetchImpl = routerFetch([
      { match: "query Issue", data: { issue: issueNode({ identifier: "SHI-1", team: null }) } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await expect(tracker.getIssue("SHI-1")).rejects.toThrow(/belongs to team `unknown`/);
  });

  it("throws when listing without configuration", async () => {
    await expect(new LinearTracker({ token: null, teamKey: null }).listIssues()).rejects.toThrow(/not configured/);
  });

  it("excludes completed + canceled by default, only canceled when includeDone", async () => {
    const fetchImpl = routerFetch([{ match: "TeamIssues", data: { team: { issues: { nodes: [] } } } }]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });

    await tracker.listIssues();
    expect(varsFor(fetchImpl, "TeamIssues").excludedTypes).toEqual(["completed", "canceled"]);

    fetchImpl.mockClear();
    await tracker.listIssues({ includeDone: true });
    expect(varsFor(fetchImpl, "TeamIssues").excludedTypes).toEqual(["canceled"]);
  });

  // docs/248 req 5 — the declaration carries the team KEY; Linear's own queries
  // want the internal id, so the adapter resolves one to the other lazily and
  // caches it for the request's lifetime.
  it("resolves the declared team key to a team id once, then reuses it", async () => {
    const fetchImpl = routerFetch([{ match: "TeamIssues", data: { team: { issues: { nodes: [] } } } }]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });

    await tracker.listIssues();
    await tracker.listIssues();

    expect(varsFor(fetchImpl, "TeamByKey")).toEqual({ key: "SHI" });
    expect(varsFor(fetchImpl, "TeamIssues").teamId).toBe("team-123");
    const lookups = fetchImpl.mock.calls.filter((c) =>
      ((JSON.parse((c[1]?.body as string) ?? "{}") as { query?: string }).query ?? "").includes("TeamByKey"),
    );
    expect(lookups).toHaveLength(1);
  });

  // The workspace comes from the credential (req 23), so "no such team" and
  // "this token can't see that team" are indistinguishable — the error names both.
  it("fails closed when the declared team is not reachable with the credential", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { teams: { nodes: [] } } }));
    const tracker = new LinearTracker({ token: "t", teamKey: "NOPE", fetchImpl });
    await expect(tracker.listIssues()).rejects.toThrow(/no team `NOPE` reachable/);
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
      { match: "IssueId", data: { issue: { id: "uuid-1", team: { key: "SHI" } } } },
      { match: "commentCreate", data: { commentCreate: { success: true, comment: { id: "c1", url: "http://c", body: "hi" } } } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    expect(await tracker.addComment("SHI-1", "hi")).toEqual({ id: "c1", url: "http://c", body: "hi" });
  });

  it("enriches a created comment with author + timestamp when present", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueId", data: { issue: { id: "uuid-1", team: { key: "SHI" } } } },
      {
        match: "commentCreate",
        data: {
          commentCreate: {
            success: true,
            comment: {
              id: "c2",
              url: "http://c2",
              body: "hi",
              createdAt: "2026-06-01T00:00:00.000Z",
              user: { name: "nik", displayName: "Nik", avatarUrl: "http://a" },
            },
          },
        },
      },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    expect(await tracker.addComment("SHI-1", "hi")).toEqual({
      id: "c2",
      url: "http://c2",
      body: "hi",
      createdAt: "2026-06-01T00:00:00.000Z",
      author: { name: "Nik", avatarUrl: "http://a" },
    });
  });

  it("deletes a comment", async () => {
    const fetchImpl = routerFetch([
      { match: "CommentTeam", data: { comment: { issue: { team: { key: "SHI" } } } } },
      { match: "commentDelete", data: { commentDelete: { success: true } } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await expect(tracker.deleteComment("c1")).resolves.toBeUndefined();
  });

  // docs/248 req 17 — a comment id is workspace-global, and the undo path hands
  // this adapter one recorded before its declared name was re-pointed. Deleting
  // it would mutate a team this adapter does not name.
  it("refuses to delete a comment belonging to another team", async () => {
    const fetchImpl = routerFetch([
      { match: "CommentTeam", data: { comment: { issue: { team: { key: "OPS" } } } } },
      { match: "commentDelete", data: { commentDelete: { success: true } } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await expect(tracker.deleteComment("c1")).rejects.toThrow(/belongs to team `OPS`/);
    expect(
      fetchImpl.mock.calls.some((c) => (c[1] as { body: string }).body.includes("commentDelete")),
    ).toBe(false);
  });

  // Already gone — undo stays idempotent rather than throwing on the guard read.
  it("treats a missing comment as already deleted", async () => {
    const fetchImpl = routerFetch([{ match: "CommentTeam", data: { comment: null } }]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await expect(tracker.deleteComment("gone")).resolves.toBeUndefined();
  });

  // ---- comment edit (planning#88) ----------------------------------------------
  //
  // A comment id is workspace-global, so the adapter reads the comment (plus
  // `viewer`) in one query and checks three things before the mutation: the
  // team, that the comment hangs off the issue the caller named, and that its
  // author is the identity the workspace PAT writes as.

  /** The CommentOwner guard read, overridable per case. */
  const commentOwner = (over: Record<string, unknown> = {}) => ({
    viewer: { id: "u-shipit", displayName: "ShipIt" },
    comment: {
      id: "c1",
      body: "old text",
      user: { id: "u-shipit", displayName: "ShipIt" },
      issue: { id: "uuid-1", identifier: "SHI-1", team: { key: "SHI" } },
      ...over,
    },
  });

  const commentEditRoutes = (over: Record<string, unknown> = {}) => [
    { match: "IssueId", data: { issue: { id: "uuid-1", team: { key: "SHI" } } } },
    { match: "CommentOwner", data: commentOwner(over) },
    {
      match: "commentUpdate",
      data: { commentUpdate: { success: true, comment: { id: "c1", url: "http://c", body: "new text" } } },
    },
  ];

  it("updates a comment and returns the body it replaced (planning#88)", async () => {
    const fetchImpl = routerFetch(commentEditRoutes());
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    expect(await tracker.updateComment("SHI-1", "c1", "new text")).toEqual({
      comment: { id: "c1", url: "http://c", body: "new text" },
      previousBody: "old text",
    });
  });

  it("refuses to edit a comment on a different issue than the one named (planning#88)", async () => {
    const fetchImpl = routerFetch(
      commentEditRoutes({ issue: { id: "uuid-9", identifier: "SHI-9", team: { key: "SHI" } } }),
    );
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await expect(tracker.updateComment("SHI-1", "c1", "new")).rejects.toThrow(/not on SHI-1.*SHI-9/s);
    expect(
      fetchImpl.mock.calls.some((c) => (c[1] as { body: string }).body.includes("commentUpdate")),
    ).toBe(false);
  });

  it("refuses to edit a comment written by someone else (planning#88)", async () => {
    const fetchImpl = routerFetch(
      commentEditRoutes({ user: { id: "u-human", displayName: "Nik Zherebtsov" } }),
    );
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await expect(tracker.updateComment("SHI-1", "c1", "new")).rejects.toMatchObject({
      name: "TrackerPermissionError",
    });
    expect(
      fetchImpl.mock.calls.some((c) => (c[1] as { body: string }).body.includes("commentUpdate")),
    ).toBe(false);
  });

  it("refuses to edit a comment on another team's issue (docs/248 req 17)", async () => {
    // The team guard fires on the issue leg, before the comment is even read.
    const fetchImpl = routerFetch([
      { match: "IssueId", data: { issue: { id: "uuid-1", team: { key: "OPS" } } } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await expect(tracker.updateComment("SHI-1", "c1", "new")).rejects.toThrow(/belongs to team `OPS`/);
  });

  it("lists an issue's comments oldest-first with author + timestamp (docs/189)", async () => {
    const fetchImpl = routerFetch([
      {
        match: "IssueComments",
        data: {
          issue: {
            team: { key: "SHI" },
            comments: {
              nodes: [
                {
                  id: "c1",
                  body: "First",
                  url: "http://c1",
                  createdAt: "2026-06-01T00:00:00.000Z",
                  user: { name: "nik", displayName: "Nik", avatarUrl: "http://a" },
                },
                { id: "c2", body: "Second (no author)", url: null, createdAt: null, user: null },
              ],
            },
          },
        },
      },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    expect(await tracker.listComments("SHI-1")).toEqual([
      {
        id: "c1",
        body: "First",
        url: "http://c1",
        createdAt: "2026-06-01T00:00:00.000Z",
        author: { name: "Nik", avatarUrl: "http://a" },
      },
      { id: "c2", body: "Second (no author)" },
    ]);
  });

  it("throws listComments when no token is configured", async () => {
    await expect(new LinearTracker({ token: null, teamKey: "SHI" }).listComments("SHI-1")).rejects.toThrow(
      /not configured/,
    );
  });

  it("creates an issue against the bound team (docs/187)", async () => {
    const fetchImpl = routerFetch([
      { match: "issueCreate", data: { issueCreate: { success: true, issue: issueNode({ identifier: "SHI-9", title: "New doc" }) } } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    const issue = await tracker.createIssue({ title: "New doc", body: "tracks docs/187" });
    expect(issue.identifier).toBe("SHI-9");
    const input = inputFor(fetchImpl, "IssueCreate");
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
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    const issue = await tracker.createIssue({ title: "Redesign the secret auth flow", body: "" });
    expect(issue.url).toBe("https://linear.app/shipit/issue/SHI-9");
  });

  it("throws creating an issue without a team binding", async () => {
    const tracker = new LinearTracker({ token: "t", teamKey: null });
    await expect(tracker.createIssue({ title: "x", body: "" })).rejects.toThrow(/missing declared team/);
  });

  it("creates with resolved labelIds and a mapped priority (planning#94)", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueLabels", data: { issueLabels: { nodes: [{ id: "lab-sec", name: "security" }, { id: "lab-be", name: "backend" }] } } },
      { match: "issueCreate", data: { issueCreate: { success: true, issue: issueNode({ identifier: "SHI-9" }) } } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await tracker.createIssue({ title: "New", body: "", labels: ["security"], priority: "high" });
    const input = JSON.parse(
      fetchImpl.mock.calls.find(([, i]) => ((JSON.parse((i?.body as string) ?? "{}").query as string) ?? "").includes("issueCreate"))![1]?.body as string,
    ).variables.input;
    expect(input).toMatchObject({ teamId: "team-123", title: "New", labelIds: ["lab-sec"], priority: 2 });
  });

  it("rejects an unknown label with the candidate list (no create) (planning#94)", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueLabels", data: { issueLabels: { nodes: [{ id: "lab-sec", name: "security" }] } } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await expect(tracker.createIssue({ title: "New", body: "", labels: ["nope"] })).rejects.toMatchObject({
      kind: "label",
      options: ["security"],
    });
    // Only the team lookup + labels query ran; issueCreate never fired.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("creates a sub-issue with a resolved parentId (planning#208)", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueId", data: { issue: { id: "uuid-parent", team: { key: "SHI" } } } },
      { match: "issueCreate", data: { issueCreate: { success: true, issue: issueNode({ identifier: "SHI-9" }) } } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await tracker.createIssue({ title: "Child", body: "", parent: "SHI-204" });
    const input = JSON.parse(
      fetchImpl.mock.calls.find(([, i]) => ((JSON.parse((i?.body as string) ?? "{}").query as string) ?? "").includes("issueCreate"))![1]?.body as string,
    ).variables.input;
    expect(input).toMatchObject({ teamId: "team-123", title: "Child", parentId: "uuid-parent" });
  });

  it("reparents via issueUpdate with a resolved parentId (planning#208)", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueId", data: { issue: { id: "uuid-1", team: { key: "SHI" } } } },
      { match: "issueUpdate", data: { issueUpdate: { success: true, issue: issueNode() } } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await tracker.updateIssue("SHI-1", { parent: "SHI-204" });
    // resolveUuid runs for both the target and the parent (both "IssueId"); the
    // mutation input carries the resolved parentId.
    const input = JSON.parse((fetchImpl.mock.calls.at(-1)![1]?.body as string)).variables.input;
    expect(input).toEqual({ parentId: "uuid-1" });
  });

  it("detaches a sub-issue with parentId: null on --parent none (planning#208)", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueId", data: { issue: { id: "uuid-1", team: { key: "SHI" } } } },
      { match: "issueUpdate", data: { issueUpdate: { success: true, issue: issueNode() } } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await tracker.updateIssue("SHI-1", { parent: null });
    const input = inputFor(fetchImpl, "IssueUpdate");
    expect(input).toEqual({ parentId: null });
    // Detach needs no parent resolution — only the target resolveUuid + update.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces labels with their colors on a read (planning#94 + foundation)", async () => {
    const fetchImpl = routerFetch([
      {
        match: "query Issue",
        data: {
          issue: issueNode({
            labels: { nodes: [{ name: "security", color: "#d73a4a" }, { name: "backend" }] },
          }),
        },
      },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    const issue = await tracker.getIssue("SHI-1");
    // Linear's color is already `#`-prefixed; a colorless label omits `color`.
    expect(issue?.labels).toEqual([{ name: "security", color: "#d73a4a" }, { name: "backend" }]);
  });

  it("listLabels returns the workspace labels with their colors", async () => {
    const fetchImpl = routerFetch([
      {
        match: "query IssueLabels",
        data: {
          issueLabels: {
            nodes: [
              { name: "security", color: "#d73a4a" },
              { name: "backend", color: "#0e8a16" },
              { name: "no-color" },
            ],
          },
        },
      },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    expect(await tracker.listLabels()).toEqual([
      { name: "security", color: "#d73a4a" },
      { name: "backend", color: "#0e8a16" },
      { name: "no-color" },
    ]);
  });

  it("creates a team-scoped label and returns its id for undo (planning#232)", async () => {
    const fetchImpl = routerFetch([
      {
        match: "issueLabelCreate",
        data: { issueLabelCreate: { success: true, issueLabel: { id: "lbl-1", name: "t3code", color: "#0ea5e9" } } },
      },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    const label = await tracker.createLabel({ name: "t3code", color: "0ea5e9", description: "T3 code area" });
    expect(label).toEqual({ id: "lbl-1", name: "t3code", color: "#0ea5e9" });
    const input = inputFor(fetchImpl, "LabelCreate");
    // Bound to the adapter's team, and a bare hex is normalized to Linear's `#rrggbb`.
    expect(input).toEqual({ teamId: "team-123", name: "t3code", color: "#0ea5e9", description: "T3 code area" });
  });

  it("throws creating a label without a team binding (planning#232)", async () => {
    const tracker = new LinearTracker({ token: "t", teamKey: null, fetchImpl: routerFetch([]) });
    await expect(tracker.createLabel({ name: "x" })).rejects.toThrow(/missing declared team/);
  });

  it("deletes an unused label on undo (planning#232)", async () => {
    const fetchImpl = routerFetch([
      { match: "LabelUsage", data: { issueLabel: { issues: { nodes: [] } } } },
      { match: "issueLabelDelete", data: { issueLabelDelete: { success: true } } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await tracker.deleteUnusedLabel("lbl-1", "t3code");
    const deleteCall = fetchImpl.mock.calls.find((c) =>
      (JSON.parse(c[1]?.body as string).query as string).includes("issueLabelDelete"),
    );
    expect(deleteCall).toBeDefined();
  });

  it("refuses to delete a label that issues now carry, naming a carrier (planning#232)", async () => {
    const fetchImpl = routerFetch([
      { match: "LabelUsage", data: { issueLabel: { issues: { nodes: [{ identifier: "SHI-9" }] } } } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await expect(tracker.deleteUnusedLabel("lbl-1", "t3code")).rejects.toThrow(/in use.*SHI-9/);
    // No delete mutation was attempted.
    for (const call of fetchImpl.mock.calls) {
      expect(JSON.parse(call[1]?.body as string).query).not.toContain("issueLabelDelete");
    }
  });

  it("treats an already-deleted label as an idempotent undo no-op (planning#232)", async () => {
    const fetchImpl = routerFetch([{ match: "LabelUsage", data: { issueLabel: null } }]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await expect(tracker.deleteUnusedLabel("lbl-gone", "old")).resolves.toBeUndefined();
  });

  it("edits title/description via issueUpdate", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueId", data: { issue: { id: "uuid-1", team: { key: "SHI" } } } },
      { match: "issueUpdate", data: { issueUpdate: { success: true, issue: issueNode({ title: "New" }) } } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    const issue = await tracker.updateIssue("SHI-1", { title: "New", description: "d2" });
    expect(issue.title).toBe("New");
    const input = inputFor(fetchImpl, "IssueUpdate");
    expect(input).toEqual({ title: "New", description: "d2" });
  });

  it("sets status by normalized type → resolved stateId", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueStates", data: { issue: { id: "uuid-1", team: { key: "SHI", states: { nodes: STATES } } } } },
      { match: "issueUpdate", data: { issueUpdate: { success: true, issue: issueNode() } } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await tracker.setStatus("SHI-1", "completed");
    const input = inputFor(fetchImpl, "IssueUpdate");
    expect(input).toEqual({ stateId: "s-done" });
  });

  it("rejects an unknown status with the valid options (no write)", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueStates", data: { issue: { id: "uuid-1", team: { key: "SHI", states: { nodes: STATES } } } } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await expect(tracker.setStatus("SHI-1", "frobnicate")).rejects.toThrow(TrackerResolutionError);
    // Only the states query ran; the update never fired.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("resolves assignee `me` to the viewer id", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueId", data: { issue: { id: "uuid-1", team: { key: "SHI" } } } },
      { match: "Viewer", data: { viewer: { id: "me-id" } } },
      { match: "issueUpdate", data: { issueUpdate: { success: true, issue: issueNode() } } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await tracker.setAssignee("SHI-1", "me");
    const input = inputFor(fetchImpl, "IssueUpdate");
    expect(input).toEqual({ assigneeId: "me-id" });
  });

  it("resolves assignee by display name to an assigneeId", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueId", data: { issue: { id: "uuid-1", team: { key: "SHI" } } } },
      { match: "Users", data: { users: { nodes: [{ id: "u9", name: "nik", displayName: "Nik Z", email: "n@x" }] } } },
      { match: "issueUpdate", data: { issueUpdate: { success: true, issue: issueNode() } } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await tracker.setAssignee("SHI-1", "Nik Z");
    const input = inputFor(fetchImpl, "IssueUpdate");
    expect(input).toEqual({ assigneeId: "u9" });
  });

  it("returns candidates when an assignee name has no match", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueId", data: { issue: { id: "uuid-1", team: { key: "SHI" } } } },
      { match: "Users", data: { users: { nodes: [{ id: "u9", name: "nik", displayName: "Nik Z", email: "n@x" }] } } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await expect(tracker.setAssignee("SHI-1", "Nobody")).rejects.toMatchObject({
      kind: "assignee",
      options: ["Nik Z"],
    });
  });

  it("unassigns with null (no name resolution)", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueId", data: { issue: { id: "uuid-1", team: { key: "SHI" } } } },
      { match: "issueUpdate", data: { issueUpdate: { success: true, issue: issueNode() } } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await tracker.setAssignee("SHI-1", null);
    const input = inputFor(fetchImpl, "IssueUpdate");
    expect(input).toEqual({ assigneeId: null });
  });

  it("assigns a raw internal id verbatim (undo replay — no resolution)", async () => {
    const fetchImpl = routerFetch([
      { match: "IssueId", data: { issue: { id: "uuid-1", team: { key: "SHI" } } } },
      { match: "issueUpdate", data: { issueUpdate: { success: true, issue: issueNode() } } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    await tracker.setAssignee("SHI-1", "raw-uuid-7", { raw: true });
    // No Users query — the id is used directly.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const input = inputFor(fetchImpl, "IssueUpdate");
    expect(input).toEqual({ assigneeId: "raw-uuid-7" });
  });

  it("getIssue surfaces assigneeId and availableStatuses for the agent", async () => {
    const fetchImpl = routerFetch([
      { match: "query Issue", data: { issue: issueNode({ team: { key: "SHI", states: { nodes: STATES } } }) } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    const issue = await tracker.getIssue("SHI-1");
    expect(issue?.assigneeId).toBe("u1");
    expect(issue?.availableStatuses?.map((s) => s.name)).toContain("In Review");
  });

  it("getIssue selects and surfaces the issue's createdAt (docs/247 req 9)", async () => {
    const fetchImpl = routerFetch([
      { match: "query Issue", data: { issue: issueNode({ createdAt: "2025-11-02T09:15:00.000Z" }) } },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    const issue = await tracker.getIssue("SHI-1");
    expect(issue?.createdAt).toBe("2025-11-02T09:15:00.000Z");
    // The field has to be in the selection set, not just mapped — Linear returns
    // only what is asked for, so a missing selection reads as a missing date.
    const queries = fetchImpl.mock.calls.map(
      (c) =>
        (JSON.parse(((c[1] as RequestInit | undefined)?.body as string) || "{}") as { query?: string }).query ?? "",
    );
    expect(queries.find((q) => q.includes("query Issue"))).toContain("createdAt");
  });

  it("omits createdAt when the tracker returns none", async () => {
    const fetchImpl = routerFetch([{ match: "query Issue", data: { issue: issueNode() } }]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    expect(await tracker.getIssue("SHI-1")).not.toHaveProperty("createdAt");
  });

  it("listStatuses returns the team's workflow states in board order (docs/191)", async () => {
    const fetchImpl = routerFetch([
      // Deliberately out of position order — listStatuses sorts by position.
      {
        match: "TeamStates",
        data: {
          team: {
            states: {
              nodes: [
                { id: "s-done", name: "Done", type: "completed", position: 3 },
                { id: "s-todo", name: "Todo", type: "unstarted", position: 0 },
              ],
            },
          },
        },
      },
    ]);
    const tracker = new LinearTracker({ token: "t", teamKey: "SHI", fetchImpl });
    expect(await tracker.listStatuses()).toEqual([
      { name: "Todo", type: "unstarted" },
      { name: "Done", type: "completed" },
    ]);
  });

  it("listStatuses throws when unconfigured", async () => {
    await expect(new LinearTracker({ token: null, teamKey: null }).listStatuses()).rejects.toThrow();
  });
});

describe("resolveLinearPriority (planning#94)", () => {
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
      jsonResponse({ data: { teams: { nodes: [{ id: "team-123", key: "SHI", name: "ShipIt" }, { id: "t2", key: "ENG", name: "Engineering" }] } } }),
    );
    const teams = await listLinearTeams("tok", fetchImpl);
    expect(teams).toEqual([{ id: "team-123", key: "SHI", name: "ShipIt" }, { id: "t2", key: "ENG", name: "Engineering" }]);
  });
});
