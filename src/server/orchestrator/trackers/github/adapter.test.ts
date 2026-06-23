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
    expect(issues[0].status).toEqual({ name: "Open", type: "started", color: "#3fb950" });
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
      { name: "Open", type: "started", color: "#3fb950" },
      { name: "Closed", type: "completed", color: "#8957e5" },
    ]);
  });

  it("listStatuses returns the fixed Open/Closed pair without a request (docs/191)", async () => {
    const fetchImpl = vi.fn();
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    expect(await tracker.listStatuses()).toEqual([
      { name: "Open", type: "started", color: "#3fb950" },
      { name: "Closed", type: "completed", color: "#8957e5" },
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("listStatuses throws when unconfigured (no repo)", async () => {
    await expect(new GitHubTracker({ token: "t", repo: null }).listStatuses()).rejects.toThrow();
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

  it("creates an issue on the session repo (POST issues) (docs/187)", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      issueResponse({ number: 7, title: "New doc", html_url: "https://github.com/octocat/hello-world/issues/7" }),
    );
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    const issue = await tracker.createIssue({ title: "New doc", body: "tracks docs/187" });
    expect(issue.identifier).toBe("octocat/hello-world#7");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/repos/octocat/hello-world/issues");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ title: "New doc", body: "tracks docs/187" });
  });

  it("creates with labels validated against the repo's labels (SHI-92)", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = url as string;
      if ((init?.method ?? "GET") === "GET" && u.includes("/labels")) {
        return jsonResponse([{ name: "security" }, { name: "backend" }]);
      }
      return issueResponse({ number: 7, ...JSON.parse(init?.body as string) });
    });
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    await tracker.createIssue({ title: "New", body: "", labels: ["Security"] });
    const post = fetchImpl.mock.calls.find((c) => c[1]?.method === "POST")!;
    // Case-insensitive match resolves to the repo's canonical casing.
    expect(JSON.parse(post[1]?.body as string).labels).toEqual(["security"]);
  });

  it("rejects an unknown label with the repo's candidate list (SHI-92)", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      (url as string).includes("/labels") ? jsonResponse([{ name: "security" }]) : issueResponse(),
    );
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    await expect(tracker.createIssue({ title: "New", body: "", labels: ["nope"] })).rejects.toMatchObject({
      kind: "label",
      options: ["security"],
    });
  });

  it("rejects --priority on GitHub (no native priority field) (SHI-92)", async () => {
    const fetchImpl = vi.fn(async () => issueResponse());
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    await expect(tracker.createIssue({ title: "New", body: "", priority: "high" })).rejects.toMatchObject({
      kind: "priority",
    });
    // Rejected before any network call.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects --parent on GitHub (issues are flat, no sub-issues) (SHI-206)", async () => {
    const fetchImpl = vi.fn(async () => issueResponse());
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    await expect(tracker.createIssue({ title: "New", body: "", parent: "octo/repo#1" })).rejects.toMatchObject({
      kind: "parent",
    });
    // Backstop also rejects a detach (null) on an edit, before any network call.
    await expect(tracker.updateIssue("42", { parent: null })).rejects.toMatchObject({ kind: "parent" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces labels with normalized colors on a read (SHI-92 + foundation)", async () => {
    const tracker = new GitHubTracker({
      token: "t",
      repo: REPO,
      fetchImpl: vi.fn(async () =>
        jsonResponse({
          id: 1,
          number: 42,
          title: "Bug",
          html_url: "https://github.com/octocat/hello-world/issues/42",
          state: "open",
          // A colored object label, a colorless one, and a bare string label.
          labels: [{ name: "security", color: "d73a4a" }, { name: "backend" }, "infra"],
        }),
      ),
    });
    const issue = await tracker.getIssue("42");
    // GitHub's bare hex is normalized to a CSS-ready `#rrggbb`; colorless labels
    // omit `color` (the client then hash-derives a dot).
    expect(issue?.labels).toEqual([
      { name: "security", color: "#d73a4a" },
      { name: "backend" },
      { name: "infra" },
    ]);
  });

  it("listLabels returns the repo's labels with normalized colors", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse([
        { name: "bug", color: "d73a4a" },
        { name: "design", color: "#a2eeef" },
        { name: "no-color" },
      ]),
    );
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    expect(await tracker.listLabels()).toEqual([
      { name: "bug", color: "#d73a4a" },
      { name: "design", color: "#a2eeef" },
      { name: "no-color" },
    ]);
    expect(fetchImpl.mock.calls[0][0] as string).toContain("/repos/octocat/hello-world/labels");
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

  it("enriches a created comment with author + timestamp when present", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        id: 556,
        html_url: "https://github.com/octocat/hello-world/issues/42#c2",
        body: "hi",
        created_at: "2026-06-01T00:00:00Z",
        user: { login: "octocat", avatar_url: "http://a" },
      }),
    );
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    expect(await tracker.addComment("42", "hi")).toEqual({
      id: "556",
      url: "https://github.com/octocat/hello-world/issues/42#c2",
      body: "hi",
      createdAt: "2026-06-01T00:00:00Z",
      author: { name: "octocat", avatarUrl: "http://a" },
    });
  });

  it("lists an issue's comments with author + timestamp (docs/189)", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse([
        {
          id: 1,
          body: "First",
          html_url: "http://c1",
          created_at: "2026-06-01T00:00:00Z",
          user: { login: "octocat", avatar_url: "http://a" },
        },
        { id: 2, body: "Second", html_url: "http://c2", created_at: "2026-06-02T00:00:00Z", user: null },
      ]),
    );
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    expect(await tracker.listComments("42")).toEqual([
      {
        id: "1",
        body: "First",
        url: "http://c1",
        createdAt: "2026-06-01T00:00:00Z",
        author: { name: "octocat", avatarUrl: "http://a" },
      },
      { id: "2", body: "Second", url: "http://c2", createdAt: "2026-06-02T00:00:00Z" },
    ]);
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain("/repos/octocat/hello-world/issues/42/comments");
  });

  it("throws listComments when unconfigured", async () => {
    await expect(new GitHubTracker({ token: null, repo: null }).listComments("42")).rejects.toThrow(
      /not configured/,
    );
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
