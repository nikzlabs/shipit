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
});
