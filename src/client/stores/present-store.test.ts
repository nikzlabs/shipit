/**
 * Unit tests for the present-store reducer (docs/093).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { usePresentStore } from "./present-store.js";

function makePresent(overrides: Partial<Parameters<ReturnType<typeof usePresentStore.getState>["addOrReplace"]>[0]> = {}) {
  return {
    presentId: "p1",
    content: "<p>hi</p>",
    mimeType: "text/html",
    title: "Hi",
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

  it("replaces in-place when replaceId matches an existing entry", () => {
    usePresentStore.getState().addOrReplace(makePresent());
    usePresentStore.getState().addOrReplace(
      makePresent({ presentId: "p2", title: "Hi v2", replaceId: "p1" }),
    );
    const { presentations, activePresentIndex } = usePresentStore.getState();
    expect(presentations).toHaveLength(1);
    expect(presentations[0].presentId).toBe("p2");
    expect(presentations[0].title).toBe("Hi v2");
    expect(activePresentIndex).toBe(0);
  });

  it("appends when replaceId does not match any entry", () => {
    usePresentStore.getState().addOrReplace(makePresent());
    usePresentStore.getState().addOrReplace(
      makePresent({ presentId: "p2", replaceId: "missing" }),
    );
    const { presentations } = usePresentStore.getState();
    expect(presentations).toHaveLength(2);
    expect(presentations[1].presentId).toBe("p2");
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

  it("markSeen clears the unseen count", () => {
    usePresentStore.getState().addOrReplace(makePresent());
    usePresentStore.getState().addOrReplace(makePresent({ presentId: "p2" }));
    expect(usePresentStore.getState().unseenCount).toBe(2);
    usePresentStore.getState().markSeen();
    expect(usePresentStore.getState().unseenCount).toBe(0);
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
