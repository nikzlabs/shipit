import { describe, it, expect, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useIframePool, MAX_IFRAME_SLOTS, type IframeSlot } from "./useIframePool.js";

afterEach(() => {
  cleanup();
});

const slot = (overrides: Partial<IframeSlot> = {}): IframeSlot => ({
  url: "http://session-a--3000.localhost:3001/",
  containerMode: true,
  generation: 0,
  ...overrides,
});

/**
 * Fill a pool the way `usePreviewSlot` does: mark the key created, add the
 * slot, promote it. The iframe ref is seeded separately because only the
 * real DOM (PreviewFrame's render) populates that one.
 */
function createSlot(
  pool: ReturnType<typeof useIframePool>,
  key: string,
  s: IframeSlot = slot(),
): void {
  act(() => {
    pool.createdSlotsRef.current.add(key);
    pool.iframeRefs.current.set(key, null);
    pool.setSlot(key, s);
    pool.promoteSlot(key);
  });
}

describe("useIframePool", () => {
  it("retains a created slot in slots, slotOrder, and the shared refs", () => {
    const { result } = renderHook(() => useIframePool());
    createSlot(result.current, "session-a:3000");
    expect(result.current.slots.get("session-a:3000")).toEqual(slot());
    expect(result.current.slotOrder).toContain("session-a:3000");
    expect(result.current.createdSlotsRef.current.has("session-a:3000")).toBe(true);
  });

  it("dropSlot removes the slot from everything the pool tracks", () => {
    // planning#394: the ownership drop must clean exactly what LRU eviction

    const { result } = renderHook(() => useIframePool());
    createSlot(result.current, "session-a:3000");
    createSlot(result.current, "session-a:5173");

    act(() => result.current.dropSlot("session-a:3000"));

    expect(result.current.slots.has("session-a:3000")).toBe(false);
    expect(result.current.slotOrder).not.toContain("session-a:3000");
    expect(result.current.iframeRefs.current.has("session-a:3000")).toBe(false);
    expect(result.current.createdSlotsRef.current.has("session-a:3000")).toBe(false);

    expect(result.current.slots.has("session-a:5173")).toBe(true);
  });

  it("stamps a rebuilt slot with a new generation, so its iframe is a fresh element", () => {

    const { result } = renderHook(() => useIframePool());
    createSlot(result.current, "session-a:3000");
    expect(result.current.slots.get("session-a:3000")?.generation).toBe(0);

    act(() => result.current.dropSlot("session-a:3000"));
    createSlot(result.current, "session-a:3000");

    expect(result.current.slots.get("session-a:3000")?.generation).toBe(1);
  });

  it("dropSlot on a key the pool doesn't hold is a no-op", () => {
    const { result } = renderHook(() => useIframePool());
    createSlot(result.current, "session-a:3000");
    act(() => result.current.dropSlot("session-b:9999"));
    expect(result.current.slots.size).toBe(1);
    expect(result.current.slotOrder).toEqual(["session-a:3000"]);
  });

  it("promotes the most recent slot to the front without dropping anything", () => {
    const { result } = renderHook(() => useIframePool());
    createSlot(result.current, "a:1");
    createSlot(result.current, "a:2");
    createSlot(result.current, "a:3");
    expect(result.current.slotOrder).toEqual(["a:3", "a:2", "a:1"]);
    act(() => result.current.promoteSlot("a:1"));
    expect(result.current.slotOrder).toEqual(["a:1", "a:3", "a:2"]);
    expect(result.current.slots.size).toBe(3);
  });

  it("evicts past the cap, oldest first, cleaning up everything the evicted slots had", () => {
    const { result } = renderHook(() => useIframePool());
    for (let i = 0; i <= MAX_IFRAME_SLOTS + 1; i++) {
      createSlot(result.current, `a:${i}`);
    }

    expect(result.current.slots.size).toBe(MAX_IFRAME_SLOTS);
    expect(result.current.slots.has("a:0")).toBe(false);
    expect(result.current.slots.has("a:1")).toBe(false);
    expect(result.current.slots.has("a:2")).toBe(true);
    expect(result.current.slots.has(`a:${MAX_IFRAME_SLOTS + 1}`)).toBe(true);
    expect(result.current.slotOrder[0]).toBe(`a:${MAX_IFRAME_SLOTS + 1}`);
    expect(result.current.slotOrder).toHaveLength(MAX_IFRAME_SLOTS);

    expect(result.current.createdSlotsRef.current.has("a:0")).toBe(false);
    expect(result.current.iframeRefs.current.has("a:1")).toBe(false);
  });
});

describe("dropSessionSlots", () => {
  it("drops every port of the named session and leaves other sessions alone", () => {

    const { result } = renderHook(() => useIframePool());
    createSlot(result.current, "session-a:3000");
    createSlot(result.current, "session-a:5173");
    createSlot(result.current, "session-b:3000");

    let dropped: string[] = [];
    act(() => {
      dropped = result.current.dropSessionSlots("session-a");
    });

    expect(dropped.sort()).toEqual(["session-a:3000", "session-a:5173"]);
    expect([...result.current.slots.keys()]).toEqual(["session-b:3000"]);
    expect(result.current.slotOrder).toEqual(["session-b:3000"]);
  });

  it("cleans up everything dropSlot cleans up, so a revisit rebuilds the iframe", () => {

    // and the iframe is never actually recreated — planning#394).
    const { result } = renderHook(() => useIframePool());
    createSlot(result.current, "session-a:3000");

    act(() => { result.current.dropSessionSlots("session-a"); });

    expect(result.current.createdSlotsRef.current.has("session-a:3000")).toBe(false);
    expect(result.current.iframeRefs.current.has("session-a:3000")).toBe(false);

    createSlot(result.current, "session-a:3000");
    expect(result.current.slots.get("session-a:3000")?.generation).toBe(1);
  });

  it("does not match a session whose id merely starts the same", () => {

    const { result } = renderHook(() => useIframePool());
    createSlot(result.current, "session-a:3000");
    createSlot(result.current, "session-ab:3000");

    act(() => { result.current.dropSessionSlots("session-a"); });

    expect([...result.current.slots.keys()]).toEqual(["session-ab:3000"]);
  });

  it("is a no-op for a session the pool holds nothing for", () => {
    const { result } = renderHook(() => useIframePool());
    createSlot(result.current, "session-a:3000");

    let dropped: string[] = [];
    act(() => { dropped = result.current.dropSessionSlots("session-zzz"); });

    expect(dropped).toEqual([]);
    expect([...result.current.slots.keys()]).toEqual(["session-a:3000"]);
  });
});
