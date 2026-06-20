/**
 * Unit tests for the present-store reducer (docs/093).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { usePresentStore } from "./present-store.js";

function makePresent(overrides: Partial<Parameters<ReturnType<typeof usePresentStore.getState>["addOrReplace"]>[0]> = {}) {
  return {
    presentId: "p1",
    mimeType: "text/html",
    title: "Hi",
    filePath: "/tmp/hi.html",
    createdAt: "2026-05-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("present-store", () => {
  beforeEach(() => {
    usePresentStore.getState().reset();
  });

  it("appends a new presentation and activates it", () => {
    usePresentStore.getState().addOrReplace(makePresent());
    const { presentations, activePresentIndex, unseenCount } = usePresentStore.getState();
    expect(presentations).toHaveLength(1);
    expect(presentations[0].presentId).toBe("p1");
    expect(activePresentIndex).toBe(0);
    expect(unseenCount).toBe(1);
  });

  it("carries filePath through onto the stored entry", () => {
    usePresentStore.getState().addOrReplace(makePresent({ filePath: "docs/mockups/landing.html" }));
    expect(usePresentStore.getState().presentations[0].filePath).toBe("docs/mockups/landing.html");
  });

  it("re-presenting the same id refreshes in place and keeps the carousel slot", () => {
    usePresentStore.getState().addOrReplace(makePresent());
    // Same file re-presented (presentId is content-addressed by path) with a
    // newer timestamp = an edit during the iteration loop.
    usePresentStore.getState().addOrReplace(
      makePresent({ title: "Hi v2", createdAt: "2026-05-29T00:01:00.000Z" }),
    );
    const { presentations, activePresentIndex } = usePresentStore.getState();
    expect(presentations).toHaveLength(1);
    expect(presentations[0].presentId).toBe("p1");
    expect(presentations[0].title).toBe("Hi v2");
    expect(activePresentIndex).toBe(0);
  });

  it("a genuine re-present (newer createdAt) drops cached bytes so the pane refetches", () => {
    usePresentStore.getState().addOrReplace(makePresent());
    usePresentStore.getState().setContent("p1", "<p>old</p>");
    usePresentStore.getState().addOrReplace(
      makePresent({ createdAt: "2026-05-29T00:01:00.000Z" }),
    );
    expect(usePresentStore.getState().presentations[0].content).toBeUndefined();
  });

  it("a true re-delivery (identical createdAt) preserves cached bytes — no needless refetch", () => {
    usePresentStore.getState().addOrReplace(makePresent());
    usePresentStore.getState().setContent("p1", "<p>cached</p>");
    // Same event replayed (e.g. a WS reconnect) — same id AND same timestamp.
    usePresentStore.getState().addOrReplace(makePresent());
    expect(usePresentStore.getState().presentations[0].content).toBe("<p>cached</p>");
  });

  it("distinct ids (distinct files) append as separate entries", () => {
    usePresentStore.getState().addOrReplace(makePresent());
    usePresentStore.getState().addOrReplace(makePresent({ presentId: "p2", filePath: "/tmp/b.html" }));
    const { presentations } = usePresentStore.getState();
    expect(presentations).toHaveLength(2);
    expect(presentations[1].presentId).toBe("p2");
  });

  it("hydrate replaces the whole list without bumping the unseen count", () => {
    usePresentStore.getState().hydrate([
      { presentId: "p1", mimeType: "text/html", filePath: "/tmp/a.html", createdAt: "2026-05-29T00:00:00.000Z" },
      { presentId: "p2", mimeType: "text/html", filePath: "/tmp/b.html", createdAt: "2026-05-29T00:00:01.000Z" },
    ]);
    const { presentations, unseenCount } = usePresentStore.getState();
    expect(presentations.map((p) => p.presentId)).toEqual(["p1", "p2"]);
    expect(unseenCount).toBe(0);
  });

  it("setContent caches fetched bytes onto the matching entry", () => {
    usePresentStore.getState().addOrReplace(makePresent());
    expect(usePresentStore.getState().presentations[0].content).toBeUndefined();
    usePresentStore.getState().setContent("p1", "<p>hi</p>");
    expect(usePresentStore.getState().presentations[0].content).toBe("<p>hi</p>");
    // No-op for an unknown id.
    usePresentStore.getState().setContent("missing", "x");
    expect(usePresentStore.getState().presentations).toHaveLength(1);
  });

  it("hydrate preserves already-fetched content for surviving ids (no refetch on reconnect)", () => {
    usePresentStore.getState().addOrReplace(makePresent());
    usePresentStore.getState().setContent("p1", "<p>cached</p>");
    usePresentStore.getState().hydrate([
      { presentId: "p1", mimeType: "text/html", filePath: "/tmp/hi.html", createdAt: "2026-05-29T00:00:00.000Z" },
      { presentId: "p2", mimeType: "text/html", filePath: "/tmp/b.html", createdAt: "2026-05-29T00:00:01.000Z" },
    ]);
    const { presentations } = usePresentStore.getState();
    expect(presentations[0].content).toBe("<p>cached</p>");
    expect(presentations[1].content).toBeUndefined();
  });

  it("hydrate clamps the active index into the new bounds", () => {
    usePresentStore.getState().addOrReplace(makePresent());
    usePresentStore.getState().addOrReplace(makePresent({ presentId: "p2" }));
    usePresentStore.getState().setActiveIndex(1);
    // Hydrate to a shorter list — active index must clamp.
    usePresentStore.getState().hydrate([
      { presentId: "p1", mimeType: "text/html", filePath: "/tmp/a.html", createdAt: "2026-05-29T00:00:00.000Z" },
    ]);
    expect(usePresentStore.getState().activePresentIndex).toBe(0);
  });

  it("clear with presentId drops just that entry", () => {
    usePresentStore.getState().addOrReplace(makePresent());
    usePresentStore.getState().addOrReplace(makePresent({ presentId: "p2" }));
    usePresentStore.getState().clear("p1");
    const { presentations, activePresentIndex } = usePresentStore.getState();
    expect(presentations.map((p) => p.presentId)).toEqual(["p2"]);
    // Active index falls back to a valid index after eviction.
    expect(activePresentIndex).toBe(0);
  });

  it("clear without presentId wipes everything", () => {
    usePresentStore.getState().addOrReplace(makePresent());
    usePresentStore.getState().addOrReplace(makePresent({ presentId: "p2" }));
    usePresentStore.getState().clear();
    expect(usePresentStore.getState().presentations).toHaveLength(0);
    expect(usePresentStore.getState().unseenCount).toBe(0);
  });

  it("setActiveIndex clamps to valid bounds", () => {
    usePresentStore.getState().addOrReplace(makePresent());
    usePresentStore.getState().addOrReplace(makePresent({ presentId: "p2" }));
    usePresentStore.getState().setActiveIndex(99);
    expect(usePresentStore.getState().activePresentIndex).toBe(1);
    usePresentStore.getState().setActiveIndex(-5);
    expect(usePresentStore.getState().activePresentIndex).toBe(0);
  });

  it("focusById activates a matching presentation and clears unseen count", () => {
    usePresentStore.getState().addOrReplace(makePresent());
    usePresentStore.getState().addOrReplace(makePresent({ presentId: "p2" }));
    expect(usePresentStore.getState().focusById("p1")).toBe(true);
    const { activePresentIndex, unseenCount } = usePresentStore.getState();
    expect(activePresentIndex).toBe(0);
    expect(unseenCount).toBe(0);
  });

  it("focusById returns false when the presentation is not loaded", () => {
    usePresentStore.getState().addOrReplace(makePresent());
    expect(usePresentStore.getState().focusById("missing")).toBe(false);
    expect(usePresentStore.getState().activePresentIndex).toBe(0);
  });

  it("markSeen clears the unseen count", () => {
    usePresentStore.getState().addOrReplace(makePresent());
    usePresentStore.getState().addOrReplace(makePresent({ presentId: "p2" }));
    expect(usePresentStore.getState().unseenCount).toBe(2);
    usePresentStore.getState().markSeen();
    expect(usePresentStore.getState().unseenCount).toBe(0);
  });

  it("rehydrates an empty store from persisted metadata then dedupes a live re-delivery (docs/093 restart)", () => {
    // After a container restart the store starts empty; session load hydrates it
    // from durable metadata (the /history payload), and the WS present_state
    // replay may re-deliver the same id. Neither should double-render.
    usePresentStore.getState().hydrate([
      { presentId: "p1", mimeType: "text/html", filePath: "docs/m.html", createdAt: "2026-06-15T00:00:00.000Z" },
    ]);
    expect(usePresentStore.getState().presentations.map((p) => p.presentId)).toEqual(["p1"]);
    // A live present_content for the SAME id replaces in place, not appends.
    usePresentStore.getState().addOrReplace(makePresent({ presentId: "p1", filePath: "docs/m.html" }));
    expect(usePresentStore.getState().presentations).toHaveLength(1);
    // A second hydrate (e.g. another reload) stays idempotent.
    usePresentStore.getState().hydrate([
      { presentId: "p1", mimeType: "text/html", filePath: "docs/m.html", createdAt: "2026-06-15T00:00:00.000Z" },
    ]);
    expect(usePresentStore.getState().presentations).toHaveLength(1);
  });

  it("reset returns to initial state", () => {
    usePresentStore.getState().addOrReplace(makePresent());
    usePresentStore.getState().reset();
    const s = usePresentStore.getState();
    expect(s.presentations).toEqual([]);
    expect(s.activePresentIndex).toBe(0);
    expect(s.unseenCount).toBe(0);
  });
});
