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
      kind: "github",
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

  it("maps created_at onto the tracker-neutral createdAt (docs/247-shipit-private-planning req 9)", async () => {
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
          created_at: "2025-11-02T09:15:00Z",
        }),
      ),
    });
    expect((await tracker.getIssue("42"))?.createdAt).toBe("2025-11-02T09:15:00Z");
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

  it("creates with labels validated against the repo's labels (planning#94)", async () => {
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

  it("rejects an unknown label with the repo's candidate list (planning#94)", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      (url as string).includes("/labels") ? jsonResponse([{ name: "security" }]) : issueResponse(),
    );
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    await expect(tracker.createIssue({ title: "New", body: "", labels: ["nope"] })).rejects.toMatchObject({
      kind: "label",
      options: ["security"],
    });
  });

  it("rejects --priority on GitHub (no native priority field) (planning#94)", async () => {
    const fetchImpl = vi.fn(async () => issueResponse());
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    await expect(tracker.createIssue({ title: "New", body: "", priority: "high" })).rejects.toMatchObject({
      kind: "priority",
    });
    // Rejected before any network call.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects --parent on GitHub (issues are flat, no sub-issues) (planning#208)", async () => {
    const fetchImpl = vi.fn(async () => issueResponse());
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    await expect(tracker.createIssue({ title: "New", body: "", parent: "octo/repo#1" })).rejects.toMatchObject({
      kind: "parent",
    });
    // Backstop also rejects a detach (null) on an edit, before any network call.
    await expect(tracker.updateIssue("42", { parent: null })).rejects.toMatchObject({ kind: "parent" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces labels with normalized colors on a read (planning#94 + foundation)", async () => {
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

  it("creates a repo label with a #-stripped color and name-as-id (planning#232)", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ name: "t3code", color: "0ea5e9" }),
    );
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    const label = await tracker.createLabel({ name: "t3code", color: "#0ea5e9", description: "T3 code area" });
    // GitHub deletes labels by name, so the name doubles as the undo id; the
    // returned color is normalized back to CSS-ready `#rrggbb`.
    expect(label).toEqual({ id: "t3code", name: "t3code", color: "#0ea5e9" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/repos/octocat/hello-world/labels");
    expect(init?.method).toBe("POST");
    // GitHub's API wants the hex WITHOUT '#'.
    expect(JSON.parse(init?.body as string)).toEqual({ name: "t3code", color: "0ea5e9", description: "T3 code area" });
  });

  it("finds a label by name case-insensitively, carrying its description (planning#88)", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse([{ name: "Bug", color: "d73a4a", description: "Something broken" }]),
    );
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    // Matching ignores casing precisely so a label whose CASING is wrong is
    // reachable — that is the thing `label edit` exists to fix.
    expect(await tracker.findLabel("bug")).toEqual({
      id: "Bug",
      name: "Bug",
      color: "#d73a4a",
      description: "Something broken",
    });
    expect(await tracker.findLabel("nope")).toBeNull();
  });

  it("renames a label in place via new_name, with a #-stripped color (planning#88)", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ name: "Bug", color: "d73a4a", description: "Broken" }),
    );
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    const label = await tracker.updateLabel("bug", { name: "Bug", color: "#d73a4a", description: "Broken" });
    // The name IS the id on GitHub, so a rename moves it — the returned id is
    // the post-rename address the undo snapshot has to carry.
    expect(label).toEqual({ id: "Bug", name: "Bug", color: "#d73a4a", description: "Broken" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/repos/octocat/hello-world/labels/bug");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({ new_name: "Bug", color: "d73a4a", description: "Broken" });
  });

  it("sends only the fields a label edit touched (planning#88)", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ name: "Feature", color: "8b5cf6" }),
    );
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    await tracker.updateLabel("Feature", { color: "8b5cf6" });
    // No `new_name` — a recolor must not restate (and so risk rewriting) the name.
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toEqual({ color: "8b5cf6" });
  });

  it("deletes an unused label on undo (planning#232)", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        expect(url as string).toContain("issues?labels=t3code&state=all&per_page=1");
        return jsonResponse([]);
      }
      return new Response(null, { status: 204 });
    });
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    await tracker.deleteUnusedLabel("t3code", "t3code");
    const del = fetchImpl.mock.calls.find((c) => c[1]?.method === "DELETE")!;
    expect(del[0]).toContain("/labels/t3code");
  });

  it("refuses to delete a label that issues now carry, naming a carrier (planning#232)", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse([{ number: 42 }]),
    );
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    await expect(tracker.deleteUnusedLabel("t3code", "t3code")).rejects.toThrow(/in use.*#42/);
    // Only the usage check ran — no DELETE.
    expect(fetchImpl.mock.calls.every((c) => (c[1]?.method ?? "GET") === "GET")).toBe(true);
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

  // ---- comment edit (planning#88) ----------------------------------------------
  //
  // A comment id is repository-global, so the adapter reads the comment by id
  // first and checks two things before writing: that it hangs off the issue the
  // caller named, and that it was authored by the identity ShipIt writes as.

  /** The by-id comment endpoint's response (author + owning issue + body). */
  const commentResponse = (over: Record<string, unknown> = {}) =>
    jsonResponse({
      id: 555,
      body: "old text",
      html_url: "https://github.com/octocat/hello-world/issues/42#c",
      issue_url: "https://api.github.com/repos/octocat/hello-world/issues/42",
      user: { login: "octocat" },
      ...over,
    });

  /** Routes the three calls a comment edit makes: GET comment, GET user, PATCH. */
  const commentEditFetch = (over: { comment?: Record<string, unknown>; viewer?: string } = {}) =>
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = url as string;
      if (u.endsWith("/user")) return jsonResponse({ login: over.viewer ?? "octocat" });
      if (u.includes("/issues/comments/") && (init?.method ?? "GET") === "GET") {
        return commentResponse(over.comment);
      }
      return jsonResponse({ id: 555, body: JSON.parse(init?.body as string).body, html_url: "http://c" });
    });

  it("edits a comment via PATCH and returns the body it replaced (planning#88)", async () => {
    const fetchImpl = commentEditFetch();
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    const { comment, previousBody } = await tracker.updateComment("42", "555", "new text");
    expect(comment).toMatchObject({ id: "555", body: "new text" });
    // The prior body is the undo snapshot — taken from the same read the guards
    // ran against, so it costs no extra round-trip.
    expect(previousBody).toBe("old text");
    const patch = fetchImpl.mock.calls.find((c) => c[1]?.method === "PATCH")!;
    expect(patch[0]).toContain("/repos/octocat/hello-world/issues/comments/555");
    expect(JSON.parse(patch[1]?.body as string)).toEqual({ body: "new text" });
  });

  it("refuses to edit a comment on a different issue than the one named (planning#88)", async () => {
    const fetchImpl = commentEditFetch({
      comment: { issue_url: "https://api.github.com/repos/octocat/hello-world/issues/99" },
    });
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    await expect(tracker.updateComment("42", "555", "new")).rejects.toThrow(/not on issue #42.*#99/s);
    expect(fetchImpl.mock.calls.some((c) => c[1]?.method === "PATCH")).toBe(false);
  });

  it("refuses to edit a comment written by someone else (planning#88)", async () => {
    const fetchImpl = commentEditFetch({ comment: { user: { login: "some-human" } } });
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    await expect(tracker.updateComment("42", "555", "new")).rejects.toMatchObject({
      name: "TrackerPermissionError",
    });
    // Nothing was rewritten — the refusal happens before the PATCH.
    expect(fetchImpl.mock.calls.some((c) => c[1]?.method === "PATCH")).toBe(false);
  });

  it("matches the author case-insensitively (GitHub logins are case-preserving)", async () => {
    const fetchImpl = commentEditFetch({ comment: { user: { login: "OctoCat" } }, viewer: "octocat" });
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    await expect(tracker.updateComment("42", "555", "new")).resolves.toMatchObject({ previousBody: "old text" });
  });

  it("reports a missing comment as missing, not as an unreachable repo (planning#88)", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
    const tracker = new GitHubTracker({ token: "t", repo: REPO, fetchImpl });
    await expect(tracker.updateComment("42", "555", "new")).rejects.toThrow(
      /Comment 555 not found in octocat\/hello-world/,
    );
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

/**
 * docs/247 — a rate limit is not an access failure. The migration replayed ~1,390
 * comments through this adapter; at ~870 writes in 15 minutes GitHub applied a
 * secondary rate limit, and every write after that was reported as "the
 * repository either does not exist or the connected GitHub credential cannot
 * access it". Nothing about that was true, and it named the two fixes that could
 * not possibly help. Both directions are pinned here: a throttle 403 must say
 * throttle, and a plain access 403 must keep its existing message.
 */
describe("GitHubTracker rate limits (docs/247)", () => {
  function errorResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  }

  /** The message of the rejection, failing the test if the call resolves. */
  async function rejection(call: Promise<unknown>): Promise<string> {
    try {
      await call;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error("expected the call to reject, but it resolved");
  }

  const SECONDARY_BODY = {
    message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
    documentation_url: "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api",
  };

  function trackerReturning(res: () => Response): GitHubTracker {
    return new GitHubTracker({ token: "t", repo: REPO, fetchImpl: vi.fn(async () => res()) });
  }

  it("names a secondary rate limit as a throttle, with how long to wait", async () => {
    const tracker = trackerReturning(() =>
      errorResponse(SECONDARY_BODY, 403, { "Retry-After": "60", "x-ratelimit-remaining": "4287" }),
    );
    const message = await rejection(tracker.listIssues());
    expect(message).toMatch(/secondary rate limit/);
    expect(message).toMatch(/60 seconds/);
    // The point of the fix: it must NOT send you to check the slug or the grant.
    expect(message).not.toMatch(/does not exist/);
  });

  it("classifies a throttle on the write path too — the one the migration hit", async () => {
    const tracker = trackerReturning(() => errorResponse(SECONDARY_BODY, 403, { "Retry-After": "900" }));
    const message = await rejection(tracker.addComment("42", "hi"));
    expect(message).toMatch(/secondary rate limit/);
    expect(message).toMatch(/15 minutes/);
    expect(message).not.toMatch(/does not exist/);
  });

  it("treats a Retry-After on an otherwise unrecognized 403 as a throttle", async () => {
    // GitHub does not send Retry-After on an authorization failure, so the
    // header alone is enough even when the body says nothing we match.
    const tracker = trackerReturning(() => errorResponse({ message: "Forbidden" }, 403, { "Retry-After": "30" }));
    const message = await rejection(tracker.listIssues());
    expect(message).toMatch(/throttling requests/);
    expect(message).toMatch(/30 seconds/);
  });

  it("reports a spent primary quota as a quota, with the reset time", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 600);
    const tracker = trackerReturning(() =>
      errorResponse({ message: "API rate limit exceeded for user ID 1." }, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": reset,
      }),
    );
    const message = await rejection(tracker.listIssues());
    expect(message).toMatch(/quota for the connected credential is exhausted/);
    expect(message).toMatch(/resets in 10 minutes/);
    expect(message).not.toMatch(/does not exist/);
  });

  it("treats a bare 429 as a throttle even with no corroborating signal", async () => {
    const tracker = trackerReturning(() => errorResponse({ message: "Too Many Requests" }, 429));
    const message = await rejection(tracker.listIssues());
    expect(message).toMatch(/throttling requests/);
    expect(message).toMatch(/a few minutes/);
  });

  it("REGRESSION: a plain access 403 keeps the repository-missing-or-inaccessible message", async () => {
    // No Retry-After, a non-zero remaining, and a body about permissions — the
    // shape of a real access failure. Mislabelling this as a throttle would tell
    // the user to wait for something that never clears.
    const accessDenied = () =>
      errorResponse(
        {
          message: "Resource not accessible by integration",
          documentation_url: "https://docs.github.com/rest/issues/issues#create-an-issue",
        },
        403,
        { "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "9999999999" },
      );
    const read = await rejection(trackerReturning(accessDenied).listIssues());
    expect(read).toMatch(/either does not exist or/);
    expect(read).not.toMatch(/rate limit/);
    // Same on the write path.
    expect(await rejection(trackerReturning(accessDenied).addComment("42", "hi"))).toMatch(
      /either does not exist or/,
    );
  });

  it("REGRESSION: 401 and 404 are untouched by the throttle classification", async () => {
    expect(await rejection(trackerReturning(() => errorResponse({}, 401)).listIssues())).toMatch(
      /rejected the token/,
    );
    expect(await rejection(trackerReturning(() => errorResponse({}, 404)).listIssues())).toMatch(
      /either does not exist or/,
    );
  });

  it("leaves a non-throttle failed write on GitHub's own message", async () => {
    // A 422 never enters the throttle path at all — pinned so the classification
    // added above cannot start swallowing GitHub's own validation messages.
    const tracker = trackerReturning(() => errorResponse({ message: "Validation Failed: bad label" }, 422));
    expect(await rejection(tracker.addComment("42", "hi"))).toMatch(/Validation Failed: bad label/);
  });

  it("classifies on the body alone, with no rate-limit headers at all", async () => {
    const tracker = trackerReturning(() => errorResponse(SECONDARY_BODY, 403));
    const message = await rejection(tracker.listIssues());
    expect(message).toMatch(/secondary rate limit/);
    expect(message).toMatch(/a few minutes/);
    expect(message).not.toMatch(/does not exist/);
  });

  it("classifies on the headers alone, with no message it recognizes", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 1800);
    const tracker = trackerReturning(() =>
      errorResponse({ message: "Forbidden" }, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": reset,
      }),
    );
    const message = await rejection(tracker.listIssues());
    expect(message).toMatch(/quota for the connected credential is exhausted/);
    expect(message).toMatch(/resets in 30 minutes/);
  });

  it("reads a non-JSON body rather than giving up on it", async () => {
    const tracker = trackerReturning(
      () =>
        new Response("You have exceeded a secondary rate limit. Please wait a few minutes.", {
          status: 403,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    expect(await rejection(tracker.listIssues())).toMatch(/secondary rate limit/);
  });

  it("reports the LONGER wait when Retry-After and a spent quota disagree", async () => {
    // A secondary limit hit while the hourly quota is also spent: retrying after
    // the 60s Retry-After would just hit the quota, so the wait must satisfy both.
    const reset = String(Math.floor(Date.now() / 1000) + 1200);
    const tracker = trackerReturning(() =>
      errorResponse(SECONDARY_BODY, 403, {
        "Retry-After": "60",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": reset,
      }),
    );
    const message = await rejection(tracker.listIssues());
    expect(message).toMatch(/secondary rate limit/); // the body still names the kind
    expect(message).toMatch(/20 minutes/);
    expect(message).not.toMatch(/60 seconds/);
  });

  it("does not read x-ratelimit-reset while the quota still has requests left", async () => {
    // `reset` is the end of the current window and rides on every response —
    // treating it as a wait would inflate a 60-second throttle to 40 minutes.
    const reset = String(Math.floor(Date.now() / 1000) + 2400);
    const tracker = trackerReturning(() =>
      errorResponse(SECONDARY_BODY, 403, {
        "Retry-After": "60",
        "x-ratelimit-remaining": "4287",
        "x-ratelimit-reset": reset,
      }),
    );
    expect(await rejection(tracker.listIssues())).toMatch(/60 seconds/);
  });

  it("does not claim access is healthy when a spent quota accompanies a permission body", async () => {
    // A spent quota proves the credential is out of requests and NOTHING about
    // whether it may touch the repository — the two can coincide. The message
    // must say retry-then-check, not "the credential is fine".
    const tracker = trackerReturning(() =>
      errorResponse({ message: "Resource not accessible by integration" }, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 300),
      }),
    );
    const message = await rejection(tracker.listIssues());
    expect(message).toMatch(/quota for the connected credential is exhausted/);
    expect(message).toMatch(/only if it still fails check that the credential can access/);
    expect(message).not.toMatch(/credential are fine|nothing to fix/);
  });
});
