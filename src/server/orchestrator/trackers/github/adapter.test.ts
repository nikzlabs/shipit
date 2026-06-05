import { describe, it, expect, vi } from "vitest";
import { GitHubTracker, mapGitHubPriority, resolveGitHubState } from "./adapter.js";
import { TrackerResolutionError } from "../tracker.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const REPO = { owner: "octocat", repo: "hello-world" };

describe("mapGitHubPriority", () => {
  it("recognizes priority: prefixes, P0–P3 shorthand, and bare severity words", () => {
    expect(mapGitHubPriority(["priority: high"]).level).toBe("high");
    expect(mapGitHubPriority(["priority/medium"]).level).toBe("medium");
    expect(mapGitHubPriority(["P1"]).level).toBe("high");
    expect(mapGitHubPriority(["critical"]).level).toBe("urgent");
    expect(mapGitHubPriority(["low"]).level).toBe("low");
  });

  it("picks the highest-priority label and falls back to none", () => {
    expect(mapGitHubPriority(["low", "P0", "medium"]).level).toBe("urgent");
    expect(mapGitHubPriority(["bug", "docs"]).level).toBe("none");
    expect(mapGitHubPriority([])).toEqual({ level: "none", sortOrder: 4, label: "No priority" });
  });
});

describe("GitHubTracker", () => {
  it("reports unconfigured without a token or repo", () => {
    expect(new GitHubTracker({ token: null, repo: null }).isConfigured()).toBe(false);
    expect(new GitHubTracker({ token: "t", repo: null }).isConfigured()).toBe(false);
    expect(new GitHubTracker({ token: null, repo: REPO }).isConfigured()).toBe(false);
    expect(new GitHubTracker({ token: "t", repo: REPO }).isConfigured()).toBe(true);
  });

  it("exposes the repo slug as binding info for the sub-tab", () => {
    const info = new GitHubTracker({ token: "t", repo: REPO }).info();
    expect(info).toEqual({
      id: "github",
      label: "GitHub",
      configured: true,
      binding: { key: "octocat/hello-world", name: "octocat/hello-world" },
    });
  });

  it("lists issues, derives priority from labels, drops PRs, and sorts by priority", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse([
        {
          id: 1001,
          number: 7,
          title: "Low priority chore",
          html_url: "https://github.com/octocat/hello-world/issues/7",
          body: "details",
          state: "open",
          labels: [{ name: "priority: low" }],
          assignee: { login: "nik", avatar_url: "http://a/avatar.png" },
        },
        {
          id: 1002,
          number: 9,
          title: "Critical bug",
          html_url: "https://github.com/octocat/hello-world/issues/9",
          body: null,
          state: "open",
          labels: ["critical"],
          assignee: null,
        },
        {
          id: 1003,
          number: 11,
          title: "A pull request, not an issue",
          html_url: "https://github.com/octocat/hello-world/pull/11",
          state: "open",
          labels: [],
          pull_request: { url: "…" },
        },
      ]),
    );

    const tracker = new GitHubTracker({ token: "ghp_x", repo: REPO, fetchImpl });
    const issues = await tracker.listIssues();

    // PR #11 is dropped; Critical (urgent) sorts before Low.
    expect(issues.map((i) => i.identifier)).toEqual([
      "octocat/hello-world#9",
      "octocat/hello-world#7",
    ]);
    expect(issues[0].priority.level).toBe("urgent");
    expect(issues[0].status).toEqual({ name: "Open", type: "started" });
    expect(issues[0].assignee).toBeUndefined();
    expect(issues[0].id).toBe("9");
    expect(issues[1].priority.level).toBe("low");
    expect(issues[1].assignee).toEqual({ name: "nik", avatarUrl: "http://a/avatar.png" });
    expect(issues[1].description).toBe("details");

    // Bearer auth header on the REST endpoint.
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/repos/octocat/hello-world/issues");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer ghp_x");
  });

  it("throws a helpful error on 401", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => jsonResponse({}, 401));
    const tracker = new GitHubTracker({ token: "bad", repo: REPO, fetchImpl });
    await expect(tracker.listIssues()).rejects.toThrow(/rejected the token/);
  });

  it("throws when listing without configuration", async () => {
    await expect(new GitHubTracker({ token: null, repo: null }).listIssues()).rejects.toThrow(
      /not configured/,
    );
  });

  it("getIssue returns null on 404 and null for a PR number", async () => {
    const notFound = new GitHubTracker({
      token: "t",
      repo: REPO,
      fetchImpl: vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ message: "Not Found" }, 404)),
    });
    expect(await notFound.getIssue("999")).toBeNull();

    const prNumber = new GitHubTracker({
      token: "t",
      repo: REPO,
      fetchImpl: vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({
          id: 1,
          number: 11,
          title: "PR",
          html_url: "https://github.com/octocat/hello-world/pull/11",
          state: "open",
          pull_request: {},
        }),
      ),
    });
    expect(await prNumber.getIssue("11")).toBeNull();
  });

  it("getIssue surfaces the fixed Open/Closed availableStatuses + login as assigneeId", async () => {
    const tracker = new GitHubTracker({
      token: "t",
      repo: REPO,
      fetchImpl: vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({
          id: 1,
          number: 42,
          title: "Bug",
          html_url: "https://github.com/octocat/hello-world/issues/42",
          state: "open",
          assignee: { login: "nik" },
        }),
      ),
    });
    const issue = await tracker.getIssue("42");
    expect(issue?.assigneeId).toBe("nik");
    expect(issue?.availableStatuses).toEqual([
      { name: "Open", type: "started" },
      { name: "Closed", type: "completed" },
    ]);
  });
});

describe("resolveGitHubState (docs/177 status mapping)", () => {
  it("maps native names", () => {
    expect(resolveGitHubState("open")).toEqual({ state: "open" });
    expect(resolveGitHubState("closed")).toEqual({ state: "closed", state_reason: "completed" });
  });

  it("maps normalized types (completed → done, canceled → not_planned)", () => {
    expect(resolveGitHubState("completed")).toEqual({ state: "closed", state_reason: "completed" });
    expect(resolveGitHubState("canceled")).toEqual({ state: "closed", state_reason: "not_planned" });
    expect(resolveGitHubState("started")).toEqual({ state: "open" });
  });

  it("throws with valid options on an unknown status", () => {
    try {
      resolveGitHubState("in review");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TrackerResolutionError);
      expect((err as TrackerResolutionError).options).toEqual(["open", "closed", "completed", "canceled"]);
    }
  });
});

describe("GitHubTracker writes (docs/177)", () => {
  const issueResponse = (over: Record<string, unknown> = {}) =>
    jsonResponse({
      id: 1,
      number: 42,
      title: "Bug",
      html_url: "https://github.com/octocat/hello-world/issues/42",
      state: "open",
      ...over,
    });

  it("adds a comment and returns its id for undo", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ id: 555, html_url: "https://github.com/octocat/hello-world/issues/42#c", body: "hi" }),
    );
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    const comment = await tracker.addComment("42", "hi");
    expect(comment).toEqual({ id: "555", url: "https://github.com/octocat/hello-world/issues/42#c", body: "hi" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/repos/octocat/hello-world/issues/42/comments");
    expect(init?.method).toBe("POST");
  });

  it("deletes a comment (DELETE issues/comments/:id, 204)", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    await expect(tracker.deleteComment("555")).resolves.toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/repos/octocat/hello-world/issues/comments/555");
    expect(init?.method).toBe("DELETE");
  });

  it("edits title/body via PATCH", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => issueResponse({ title: "New" }));
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    const issue = await tracker.updateIssue("42", { title: "New", description: "body" });
    expect(issue.title).toBe("New");
    const [, init] = fetchImpl.mock.calls[0];
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({ title: "New", body: "body" });
  });

  it("sets status by closing with a state_reason", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => issueResponse({ state: "closed" }));
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    await tracker.setStatus("42", "completed");
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toEqual({
      state: "closed",
      state_reason: "completed",
    });
  });

  it("resolves assignee `me` via GET /user then PATCHes the login", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) =>
      (url as string).endsWith("/user") ? jsonResponse({ login: "octo" }) : issueResponse(),
    );
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    await tracker.setAssignee("42", "me");
    const patchCall = fetchImpl.mock.calls.find((c) => c[1]?.method === "PATCH")!;
    expect(JSON.parse(patchCall[1]?.body as string)).toEqual({ assignees: ["octo"] });
  });

  it("assigns a login directly and unassigns with null", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => issueResponse());
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    await tracker.setAssignee("42", "nik");
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toEqual({ assignees: ["nik"] });
    await tracker.setAssignee("42", null);
    expect(JSON.parse(fetchImpl.mock.calls[1][1]?.body as string)).toEqual({ assignees: [] });
  });

  it("surfaces GitHub's error message on a failed write", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ message: "Validation Failed: not a collaborator" }, 422));
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    await expect(tracker.setAssignee("42", "stranger")).rejects.toThrow(/not a collaborator/);
  });
});
