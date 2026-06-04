import { describe, it, expect, vi } from "vitest";
import { GitHubTracker, mapGitHubPriority } from "./adapter.js";

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
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));
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
      fetchImpl: vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)),
    });
    expect(await notFound.getIssue("999")).toBeNull();

    const prNumber = new GitHubTracker({
      token: "t",
      repo: REPO,
      fetchImpl: vi.fn(async () =>
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
});
