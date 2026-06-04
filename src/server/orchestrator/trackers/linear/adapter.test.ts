import { describe, it, expect, vi } from "vitest";
import { LinearTracker, listLinearTeams, LINEAR_GRAPHQL_ENDPOINT } from "./adapter.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

describe("listLinearTeams", () => {
  it("returns the workspace teams", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { teams: { nodes: [TEAM, { id: "t2", key: "ENG", name: "Engineering" }] } } }),
    );
    const teams = await listLinearTeams("tok", fetchImpl);
    expect(teams).toEqual([TEAM, { id: "t2", key: "ENG", name: "Engineering" }]);
  });
});
