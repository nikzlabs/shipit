import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useIssuesStore, issueLookupId } from "./issues-store.js";
import { useSessionStore } from "./session-store.js";
import type { TrackerInfo, TrackerIssue } from "../../server/shared/types.js";

/**
 * Tests for the issues-store master-detail layer (docs/189): the lookup-id
 * derivation a chat card needs, and the openIssue → fetchDetail → closeIssue
 * flow that drives the inline single-issue view.
 */

function makeIssue(over: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    id: "node-1",
    identifier: "SHI-1",
    title: "Hydrated title",
    url: "https://linear.app/x/issue/SHI-1",
    description: "Full body",
    priority: { level: "urgent", sortOrder: 0, label: "Urgent" },
    status: { name: "In Progress", type: "started" },
    ...over,
  };
}

const originalFetch = globalThis.fetch;

describe("issueLookupId", () => {
  it("returns the bare number for a GitHub identifier", () => {
    expect(issueLookupId("octocat/hello#42")).toBe("42");
  });
  it("passes a Linear identifier through unchanged", () => {
    expect(issueLookupId("SHI-28")).toBe("SHI-28");
  });
});

describe("issues-store sort + collapse (docs/206)", () => {
  afterEach(() => {
    localStorage.clear();
    useIssuesStore.setState({ sortPrefs: { primary: "priority", primaryDir: 1, secondary: "status", secondaryDir: 1, group: "none" }, collapseById: {} });
  });

  it("setSortPrefs updates state and persists to localStorage", () => {
    useIssuesStore.getState().setSortPrefs({ primary: "title", primaryDir: -1, secondary: "none", secondaryDir: 1, group: "status" });
    expect(useIssuesStore.getState().sortPrefs.primary).toBe("title");
    expect(JSON.parse(localStorage.getItem("shipit-issue-sort") ?? "{}")).toMatchObject({ primary: "title", group: "status" });
  });

  it("setCollapsed records an explicit override and persists it", () => {
    useIssuesStore.getState().setCollapsed("node-7", true);
    expect(useIssuesStore.getState().collapseById["node-7"]).toBe(true);
    expect(JSON.parse(localStorage.getItem("shipit-issue-collapsed") ?? "{}")).toMatchObject({ "node-7": true });
    // Re-recording with the opposite value overwrites the override.
    useIssuesStore.getState().setCollapsed("node-7", false);
    expect(useIssuesStore.getState().collapseById["node-7"]).toBe(false);
    expect(JSON.parse(localStorage.getItem("shipit-issue-collapsed") ?? "{}")).toMatchObject({ "node-7": false });
  });
});

describe("issues-store detail view (docs/189)", () => {
  beforeEach(() => {
    useIssuesStore.getState().reset();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("openIssue seeds the view, aligns the tracker, and hydrates from fetch", async () => {
    const hydrated = makeIssue({ title: "Hydrated title", description: "Full body" });
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ tracker: { id: "linear", label: "Linear", configured: true }, issue: hydrated }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as typeof fetch;

    const seed = makeIssue({ title: "Seed title", description: undefined });
    await useIssuesStore.getState().openIssue({
      tracker: "linear",
      id: seed.id,
      identifier: seed.identifier,
      title: seed.title,
      url: seed.url,
      seed,
    });

    const s = useIssuesStore.getState();
    expect(s.activeTracker).toBe("linear");
    expect(s.selected).toMatchObject({ tracker: "linear", id: "node-1", identifier: "SHI-1" });
    expect(s.detail?.title).toBe("Hydrated title");
    expect(s.detail?.description).toBe("Full body");
    expect(s.detailLoading).toBe(false);
    expect(s.detailError).toBeNull();

    // The fetch hits the public single-issue endpoint with the lookup id.
    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("/api/issue?tracker=linear&id=node-1");
  });

  it("derives the lookup id from a card identifier when no native id is given", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ tracker: {}, issue: makeIssue() }), { status: 200 }),
    ) as typeof fetch;

    await useIssuesStore.getState().openIssue({ tracker: "github", identifier: "octocat/hello#42" });
    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("tracker=github&id=42");
  });

  it("records a detailError when the fetch fails", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Issue not found: SHI-9" }), { status: 404 }),
    ) as typeof fetch;

    await useIssuesStore.getState().openIssue({ tracker: "linear", identifier: "SHI-9" });
    const s = useIssuesStore.getState();
    expect(s.detailError).toBe("Issue not found: SHI-9");
    expect(s.detailLoading).toBe(false);
  });

  it("closeIssue clears the selection and detail", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ tracker: {}, issue: makeIssue() }), { status: 200 }),
    ) as typeof fetch;
    await useIssuesStore.getState().openIssue({ tracker: "linear", identifier: "SHI-1", seed: makeIssue() });
    expect(useIssuesStore.getState().selected).not.toBeNull();

    useIssuesStore.getState().closeIssue();
    const s = useIssuesStore.getState();
    expect(s.selected).toBeNull();
    expect(s.detail).toBeNull();
    expect(s.detailError).toBeNull();
  });
});

describe("issues-store comments (docs/189 follow-up)", () => {
  const COMMENT = { id: "c1", body: "First", author: { name: "Nik" }, createdAt: "2026-06-01T00:00:00Z" };

  /** Routes fetches: the single-issue detail, the comment thread, and the post. */
  function routeFetch(overrides: { comments?: unknown; postStatus?: number; postBody?: unknown } = {}) {
    return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = url as string;
      if (init?.method === "POST" && u === "/api/issue/comments") {
        return new Response(JSON.stringify(overrides.postBody ?? { comment: { id: "c2", body: "Posted", author: { name: "Nik" } } }), {
          status: overrides.postStatus ?? 200,
        });
      }
      if (u.startsWith("/api/issue/comments")) {
        return new Response(JSON.stringify({ comments: overrides.comments ?? [COMMENT] }), { status: 200 });
      }
      return new Response(JSON.stringify({ tracker: {}, issue: makeIssue() }), { status: 200 });
    }) as typeof fetch;
  }

  beforeEach(() => useIssuesStore.getState().reset());
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("openIssue fetches the comment thread alongside the detail", async () => {
    globalThis.fetch = routeFetch();
    await useIssuesStore.getState().openIssue({ tracker: "linear", identifier: "SHI-1", seed: makeIssue() });
    const s = useIssuesStore.getState();
    expect(s.comments).toEqual([COMMENT]);
    expect(s.commentsLoading).toBe(false);
    expect(s.commentsError).toBeNull();
  });

  it("postComment appends the created comment to the open thread", async () => {
    globalThis.fetch = routeFetch({ comments: [] });
    await useIssuesStore.getState().openIssue({ tracker: "linear", identifier: "SHI-1", seed: makeIssue() });
    const err = await useIssuesStore.getState().postComment("Posted");
    expect(err).toBeNull();
    expect(useIssuesStore.getState().comments).toEqual([{ id: "c2", body: "Posted", author: { name: "Nik" } }]);
  });

  it("postComment returns an error message and leaves the thread untouched on failure", async () => {
    globalThis.fetch = routeFetch({ comments: [COMMENT], postStatus: 502, postBody: { error: "Linear rejected the comment" } });
    await useIssuesStore.getState().openIssue({ tracker: "linear", identifier: "SHI-1", seed: makeIssue() });
    const err = await useIssuesStore.getState().postComment("nope");
    expect(err).toBe("Linear rejected the comment");
    expect(useIssuesStore.getState().comments).toEqual([COMMENT]);
  });

  it("postComment refuses an empty body without hitting the network", async () => {
    globalThis.fetch = routeFetch();
    await useIssuesStore.getState().openIssue({ tracker: "linear", identifier: "SHI-1", seed: makeIssue() });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockClear();
    const err = await useIssuesStore.getState().postComment("   ");
    expect(err).toBe("A comment can't be empty");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("closeIssue clears the comment thread", async () => {
    globalThis.fetch = routeFetch();
    await useIssuesStore.getState().openIssue({ tracker: "linear", identifier: "SHI-1", seed: makeIssue() });
    useIssuesStore.getState().closeIssue();
    expect(useIssuesStore.getState().comments).toBeNull();
  });

  it("openIssue carries an anchorCommentId onto the selection (planning#105)", async () => {
    globalThis.fetch = routeFetch();
    await useIssuesStore.getState().openIssue({
      tracker: "linear",
      identifier: "SHI-1",
      seed: makeIssue(),
      anchorCommentId: "c-2",
    });
    expect(useIssuesStore.getState().selected?.anchorCommentId).toBe("c-2");
  });

  it("clearAnchorComment drops the anchor while keeping the rest of the selection", async () => {
    globalThis.fetch = routeFetch();
    await useIssuesStore.getState().openIssue({
      tracker: "linear",
      identifier: "SHI-1",
      seed: makeIssue(),
      anchorCommentId: "c-2",
    });
    useIssuesStore.getState().clearAnchorComment();
    const sel = useIssuesStore.getState().selected;
    expect(sel?.anchorCommentId).toBeUndefined();
    expect(sel?.identifier).toBe("SHI-1");
  });
});

describe("issues-store status/priority writes (docs/191)", () => {
  const originalFetchLocal = globalThis.fetch;
  beforeEach(() => useIssuesStore.getState().reset());
  afterEach(() => {
    globalThis.fetch = originalFetchLocal;
    vi.restoreAllMocks();
  });

  it("fetchIssues caches the tracker's availableStatuses", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          tracker: { id: "linear", label: "Linear", configured: true },
          issues: [makeIssue()],
          availableStatuses: [
            { name: "Todo", type: "unstarted" },
            { name: "Done", type: "completed" },
          ],
        }),
        { status: 200 },
      ),
    ) as typeof fetch;
    await useIssuesStore.getState().fetchIssues("linear");
    expect(useIssuesStore.getState().statusesByTracker.linear).toEqual([
      { name: "Todo", type: "unstarted" },
      { name: "Done", type: "completed" },
    ]);
  });

  it("fetchLabels caches the tracker's available label set (planning#94 foundation)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          labels: [
            { name: "bug", color: "#d73a4a" },
            { name: "design" },
          ],
        }),
        { status: 200 },
      ),
    ) as typeof fetch;
    await useIssuesStore.getState().fetchLabels("linear");
    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("/api/issue/labels?tracker=linear");
    expect(useIssuesStore.getState().labelsByTracker.linear).toEqual([
      { name: "bug", color: "#d73a4a" },
      { name: "design" },
    ]);
  });

  it("setIssueStatus patches the list row + open detail and posts the native id", async () => {
    const issue = makeIssue({ id: "node-1", status: { name: "In Progress", type: "started" } });
    const updated = makeIssue({ id: "node-1", status: { name: "Done", type: "completed" } });
    useIssuesStore.setState({
      issuesByTracker: { linear: [issue] },
      detail: issue,
      selected: { tracker: "linear", id: "node-1", identifier: "SHI-1" },
    });
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ issue: updated }), { status: 200 }),
    ) as typeof fetch;

    const err = await useIssuesStore.getState().setIssueStatus("linear", issue, "Done");
    expect(err).toBeNull();
    const s = useIssuesStore.getState();
    expect(s.issuesByTracker.linear[0].status?.name).toBe("Done");
    expect(s.detail?.status?.name).toBe("Done");

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/issue/status");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      tracker: "linear",
      id: "node-1",
      status: "Done",
    });
  });

  it("setIssuePriority patches priority in place and posts the level", async () => {
    const issue = makeIssue({ id: "node-1", priority: { level: "low", sortOrder: 3, label: "Low" } });
    const updated = makeIssue({ id: "node-1", priority: { level: "high", sortOrder: 1, label: "High" } });
    useIssuesStore.setState({ issuesByTracker: { linear: [issue] } });
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ issue: updated }), { status: 200 }),
    ) as typeof fetch;

    const err = await useIssuesStore.getState().setIssuePriority("linear", issue, "high");
    expect(err).toBeNull();
    expect(useIssuesStore.getState().issuesByTracker.linear[0].priority.level).toBe("high");

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/issue/priority");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ priority: "high" });
  });

  it("setIssueStatus returns the error and leaves state untouched on failure", async () => {
    const issue = makeIssue({ id: "node-1" });
    useIssuesStore.setState({ issuesByTracker: { linear: [issue] } });
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Unknown status" }), { status: 422 }),
    ) as typeof fetch;

    const err = await useIssuesStore.getState().setIssueStatus("linear", issue, "Bogus");
    expect(err).toBe("Unknown status");
    // The row object is unchanged (same reference).
    expect(useIssuesStore.getState().issuesByTracker.linear[0]).toBe(issue);
  });
});

/**
 * planning#323 — `fetchTrackers` reports whether the declared set actually changed,
 * so a caller refreshing on a `shipit.yaml` edit can skip the issue-list fetch
 * (a real tracker-API round-trip) when the edit touched something else.
 */
describe("issues-store fetchTrackers change reporting (planning#323)", () => {
  const originalFetchLocal = globalThis.fetch;

  function stub(trackers: TrackerInfo[]): void {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ trackers }), { status: 200 }),
    ) as typeof fetch;
  }

  const gh: TrackerInfo = { id: "github", label: "GitHub", configured: true, kind: "github" };

  beforeEach(() => {
    useIssuesStore.setState({ trackers: [], infoByTracker: {} });
  });

  afterEach(() => {
    globalThis.fetch = originalFetchLocal;
    vi.restoreAllMocks();
  });

  it("reports a change when a declaration is added", async () => {
    useIssuesStore.setState({ trackers: [gh] });
    stub([gh, { id: "github:acme/planning", label: "planning", configured: true, kind: "github", name: "planning", binding: { key: "acme/planning", name: "acme/planning" } }]);
    await expect(useIssuesStore.getState().fetchTrackers()).resolves.toBe(true);
  });

  it("reports a change when a name is re-pointed at another destination", async () => {
    useIssuesStore.setState({
      trackers: [{ id: "linear:SHI", label: "roadmap", configured: true, kind: "linear", name: "roadmap", binding: { key: "SHI", name: "ShipIt" } }],
    });
    stub([{ id: "linear:PLAT", label: "roadmap", configured: true, kind: "linear", name: "roadmap", binding: { key: "PLAT", name: "Platform" } }]);
    await expect(useIssuesStore.getState().fetchTrackers()).resolves.toBe(true);
  });

  it("reports no change when the same declarations come back", async () => {
    useIssuesStore.setState({ trackers: [gh] });
    stub([gh]);
    await expect(useIssuesStore.getState().fetchTrackers()).resolves.toBe(false);
  });

  it("reports no change when the request fails", async () => {
    useIssuesStore.setState({ trackers: [gh] });
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(useIssuesStore.getState().fetchTrackers()).resolves.toBe(false);
    // A failed refresh leaves the previous view in place rather than blanking it.
    expect(useIssuesStore.getState().trackers).toEqual([gh]);
  });
});

/**
 * `warmTrackers` — the retry that distinguishes "this repository declares
 * nothing" from "we can't read its declarations yet".
 *
 * A switch to a session on a *different* repository clears the declared set
 * (`setRepoScope`), and the single refill that follows can land while the
 * incoming session's checkout is still being re-cloned by activation. That
 * answer is empty, and nothing refetched until the user opened the Issues tab —
 * so every inline `planning#147` badge in the transcript rendered as plain text
 * in the meantime.
 */
describe("issues-store warmTrackers retries while declarations are unreadable", () => {
  const originalFetchLocal = globalThis.fetch;
  const gh: TrackerInfo = { id: "github", label: "GitHub", configured: true, kind: "github" };
  const planning: TrackerInfo = {
    id: "github:acme/planning",
    label: "planning",
    configured: true,
    kind: "github",
    name: "planning",
    binding: { key: "acme/planning", name: "acme/planning" },
  };

  /** Answers `pending` for the first `pendingResponses` calls, then declares. */
  function stubPendingThenDeclared(pendingResponses: number): ReturnType<typeof vi.fn> {
    let call = 0;
    const impl = vi.fn(async () => {
      const pending = call++ < pendingResponses;
      return new Response(
        JSON.stringify(pending ? { trackers: [gh], declarationsPending: true } : { trackers: [gh, planning] }),
        { status: 200 },
      );
    });
    globalThis.fetch = impl as unknown as typeof fetch;
    return impl;
  }

  beforeEach(() => {
    useIssuesStore.setState({ trackers: [], infoByTracker: {}, declarationsPending: false });
    useSessionStore.setState({ sessionId: "sess-a" });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetchLocal;
    vi.restoreAllMocks();
  });

  it("keeps asking until the checkout is readable, then stops", async () => {
    const fetchMock = stubPendingThenDeclared(2);
    await useIssuesStore.getState().warmTrackers();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(useIssuesStore.getState().trackers.map((t) => t.id)).toEqual(["github", "github:acme/planning"]);
    expect(useIssuesStore.getState().declarationsPending).toBe(false);
  });

  it("resolves on the first answer rather than blocking on the retries", async () => {
    const fetchMock = stubPendingThenDeclared(Number.MAX_SAFE_INTEGER);
    await useIssuesStore.getState().warmTrackers();
    // The caller is already free to fetch the issue list; only one request has
    // gone out so far.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks exactly once when the answer is available immediately", async () => {
    const fetchMock = stubPendingThenDeclared(0);
    await useIssuesStore.getState().warmTrackers();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up rather than retrying forever", async () => {
    const fetchMock = stubPendingThenDeclared(Number.MAX_SAFE_INTEGER);
    await useIssuesStore.getState().warmTrackers();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // The first answer plus one per backoff step — bounded, and the store is
    // left honest about why it has nothing.
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(useIssuesStore.getState().declarationsPending).toBe(true);
  });

  it("stops when the session changes under it, instead of writing another repository's declarations", async () => {
    const fetchMock = stubPendingThenDeclared(Number.MAX_SAFE_INTEGER);
    await useIssuesStore.getState().warmTrackers();
    useSessionStore.setState({ sessionId: "sess-b" });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a newer warm-up supersedes the one in flight", async () => {
    const fetchMock = stubPendingThenDeclared(Number.MAX_SAFE_INTEGER);
    await useIssuesStore.getState().warmTrackers();
    await useIssuesStore.getState().warmTrackers();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // Two first-answer fetches + only the surviving loop's 7 retries.
    expect(fetchMock).toHaveBeenCalledTimes(9);
  });
});

/**
 * planning#327 — an open issue must not survive into a repository that doesn't
 * declare its tracker (docs/248 req 11: an undeclared destination fails
 * closed). Two halves: `setRepoScope` covers the switch itself (synchronous,
 * before the new declarations are known), `fetchTrackers` is the authoritative
 * check once they land.
 */
describe("issues-store repo scoping (planning#327)", () => {
  const roadmap: TrackerInfo = {
    id: "linear:SHI",
    label: "roadmap",
    configured: true,
    kind: "linear",
    name: "roadmap",
    binding: { key: "SHI", name: "ShipIt" },
  };
  const gh: TrackerInfo = { id: "github", label: "GitHub", configured: true, kind: "github" };

  /** An open detail on `roadmap`, with both trackers' lists cached. */
  function openOnRoadmap(repoUrl: string | null = "https://github.com/acme/app.git"): void {
    useIssuesStore.setState({
      repoScope: repoUrl,
      trackers: [roadmap, gh],
      infoByTracker: { "linear:SHI": roadmap, github: gh },
      activeTracker: "linear:SHI",
      issuesByTracker: { "linear:SHI": [makeIssue()], github: [makeIssue({ id: "gh-1" })] },
      statusesByTracker: { "linear:SHI": [{ name: "Todo" }] },
      labelsByTracker: { "linear:SHI": [{ name: "bug" }] },
      selected: { tracker: "linear:SHI", id: "SHI-1", identifier: "SHI-1" },
      detail: makeIssue(),
      comments: [],
    });
  }

  function stubTrackers(trackers: TrackerInfo[]): void {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ trackers }), { status: 200 }),
    ) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    useIssuesStore.getState().reset();
    useIssuesStore.setState({ repoScope: null, trackers: [], infoByTracker: {}, activeTracker: "github" });
  });

  it("drops the open issue and the declarations when the repository changes", () => {
    openOnRoadmap();
    useIssuesStore.getState().setRepoScope("https://github.com/acme/other.git");

    const s = useIssuesStore.getState();
    expect(s.selected).toBeNull();
    expect(s.detail).toBeNull();
    expect(s.comments).toBeNull();
    // The new repository's declarations are unknown until fetchTrackers lands —
    // rendering the previous repository's is exactly the fail-open req 11 bars.
    expect(s.trackers).toEqual([]);
    // Every cached list goes: the caches are keyed by tracker id but their
    // contents are repo-scoped (the GitHub tracker resolves per session repo).
    expect(s.issuesByTracker).toEqual({});
    expect(s.statusesByTracker).toEqual({});
    expect(s.labelsByTracker).toEqual({});
    // The gap renders as "loading", not as "not connected".
    expect(s.loading).toBe(true);
  });

  it("keeps the open issue when switching between sessions of the same repository", () => {
    openOnRoadmap("https://github.com/acme/app.git");
    useIssuesStore.getState().setRepoScope("https://github.com/acme/app.git");

    const s = useIssuesStore.getState();
    expect(s.selected?.identifier).toBe("SHI-1");
    expect(s.detail).not.toBeNull();
    expect(s.issuesByTracker["linear:SHI"]).toHaveLength(1);
    expect(s.trackers).toHaveLength(2);
  });

  it("fetchTrackers closes the open issue when its tracker is no longer declared", async () => {
    openOnRoadmap();
    stubTrackers([gh]);

    await useIssuesStore.getState().fetchTrackers();

    const s = useIssuesStore.getState();
    expect(s.selected).toBeNull();
    expect(s.detail).toBeNull();
    // Unreachable entries go; the still-declared tracker's cache stays, because
    // it's the same repository and that destination is still reachable.
    expect(s.issuesByTracker["linear:SHI"]).toBeUndefined();
    expect(s.statusesByTracker["linear:SHI"]).toBeUndefined();
    expect(s.labelsByTracker["linear:SHI"]).toBeUndefined();
    expect(s.infoByTracker["linear:SHI"]).toBeUndefined();
    expect(s.issuesByTracker.github).toHaveLength(1);
    // The sub-tab follows the surviving declaration.
    expect(s.activeTracker).toBe("github");
  });

  /**
   * The case the id-presence check misses, and the one the live repro hit: the
   * session's own repository's GitHub Issues are the bare `github` id in EVERY
   * repository (docs/248 req 12), so a cross-repo switch changes the
   * destination without changing the id.
   */
  it("fetchTrackers closes the open issue when its tracker id now names another destination", async () => {
    const ownRepoA: TrackerInfo = {
      id: "github",
      label: "GitHub",
      configured: true,
      kind: "github",
      binding: { key: "octocat/Hello-World", name: "octocat/Hello-World" },
    };
    const ownRepoB: TrackerInfo = { ...ownRepoA, binding: { key: "acme/todo-list", name: "acme/todo-list" } };
    useIssuesStore.setState({
      repoScope: "https://github.com/octocat/Hello-World",
      trackers: [ownRepoA],
      infoByTracker: { github: ownRepoA },
      activeTracker: "github",
      issuesByTracker: { github: [makeIssue()] },
      selected: { tracker: "github", id: "10756", identifier: "octocat/Hello-World#10756" },
      detail: makeIssue(),
    });
    stubTrackers([ownRepoB]);

    await useIssuesStore.getState().fetchTrackers();

    const s = useIssuesStore.getState();
    expect(s.selected).toBeNull();
    expect(s.detail).toBeNull();
    // The old repo's issue list would have been repo B's list under repo A's
    // rows — the cache goes with the destination that produced it.
    expect(s.issuesByTracker.github).toBeUndefined();
    // The declaration itself is the new one, so the sub-tab still works.
    expect(s.infoByTracker.github).toEqual(ownRepoB);
  });

  it("fetchTrackers leaves the open issue alone while its tracker is still declared", async () => {
    openOnRoadmap();
    stubTrackers([roadmap, gh]);

    await useIssuesStore.getState().fetchTrackers();

    const s = useIssuesStore.getState();
    expect(s.selected?.identifier).toBe("SHI-1");
    expect(s.detail).not.toBeNull();
    expect(s.issuesByTracker["linear:SHI"]).toHaveLength(1);
  });
});
