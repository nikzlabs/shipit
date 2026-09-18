import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAppModals } from "./useAppModals.js";

describe("useAppModals", () => {
  it("opens the search bar", () => {
    const { result } = renderHook(() => useAppModals());
    expect(result.current.searchOpen).toBe(false);

    act(() => result.current.openSearch());

    expect(result.current.searchOpen).toBe(true);
  });

  it("changes the search focus key on every open, including while already open", () => {
    const { result } = renderHook(() => useAppModals());
    const first = result.current.searchFocusKey;

    act(() => result.current.openSearch());
    const second = result.current.searchFocusKey;
    expect(second).not.toBe(first);

    // Re-opening an already-open bar must still remount it, or the cursor stays
    // in the composer and the query is typed into the message draft.
    act(() => result.current.openSearch());
    expect(result.current.searchFocusKey).not.toBe(second);
    expect(result.current.searchOpen).toBe(true);
  });
});
