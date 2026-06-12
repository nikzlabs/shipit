import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useIssuesStore, issueLookupId } from "./issues-store.js";
import type { TrackerIssue } from "../../server/shared/types.js";

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

  it("openIssue carries an anchorCommentId onto the selection (SHI-103)", async () => {
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

  it("fetchLabels caches the tracker's available label set (SHI-92 foundation)", async () => {
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
