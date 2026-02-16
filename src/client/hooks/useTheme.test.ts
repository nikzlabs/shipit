import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import { useTheme } from "./useTheme.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("useTheme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  it("defaults to dark theme when no stored preference", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("reads stored theme from localStorage", () => {
    localStorage.setItem("shipit-theme", "light");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("reads stored dark theme from localStorage", () => {
    localStorage.setItem("shipit-theme", "dark");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("ignores invalid stored value and defaults to dark", () => {
    localStorage.setItem("shipit-theme", "invalid");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
  });

  it("toggles from dark to light", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");

    act(() => result.current.toggle());

    expect(result.current.theme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("shipit-theme")).toBe("light");
  });

  it("toggles from light to dark", () => {
    localStorage.setItem("shipit-theme", "light");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");

    act(() => result.current.toggle());

    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("shipit-theme")).toBe("dark");
  });

  it("persists theme to localStorage on change", () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.toggle());
    expect(localStorage.getItem("shipit-theme")).toBe("light");

    act(() => result.current.toggle());
    expect(localStorage.getItem("shipit-theme")).toBe("dark");
  });

  it("handles localStorage being unavailable", () => {
    const getItemSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("localStorage unavailable");
    });
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("localStorage unavailable");
    });

    const { result } = renderHook(() => useTheme());
    // Should default to dark and not throw
    expect(result.current.theme).toBe("dark");

    act(() => result.current.toggle());
    // Should toggle without throwing
    expect(result.current.theme).toBe("light");

    getItemSpy.mockRestore();
    setItemSpy.mockRestore();
  });

  it("toggle function identity is stable across renders", () => {
    const { result, rerender } = renderHook(() => useTheme());
    const firstToggle = result.current.toggle;

    rerender();
    expect(result.current.toggle).toBe(firstToggle);
  });
});
