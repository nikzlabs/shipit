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
