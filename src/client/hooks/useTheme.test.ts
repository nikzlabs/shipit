import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import { useTheme, THEME_OPTIONS } from "./useTheme.js";

const ALL_THEME_CLASSES = ["dark", "midnight", "forest", "rose", "claude", "codex", "warm-light", "cool-light", "solarized", "solarized-light", "claude-light", "codex-light", "high-contrast"];

afterEach(() => {
  cleanup();
  localStorage.clear();
  // Remove all theme classes that tests may have applied
  document.documentElement.classList.remove(...ALL_THEME_CLASSES);
});

describe("useTheme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove(...ALL_THEME_CLASSES);
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

  it("accepts custom stored theme name (extensible themes)", () => {
    localStorage.setItem("shipit-theme", "solarized");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("solarized");
    // Custom theme class is applied to <html>
    expect(document.documentElement.classList.contains("solarized")).toBe(true);
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

  it("setTheme applies midnight theme class", () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setTheme("midnight"));

    expect(result.current.theme).toBe("midnight");
    expect(document.documentElement.classList.contains("midnight")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("shipit-theme")).toBe("midnight");
  });

  it("setTheme applies forest theme class", () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setTheme("forest"));

    expect(result.current.theme).toBe("forest");
    expect(document.documentElement.classList.contains("forest")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("shipit-theme")).toBe("forest");
  });

  it("setTheme applies rose theme class", () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setTheme("rose"));

    expect(result.current.theme).toBe("rose");
    expect(document.documentElement.classList.contains("rose")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("shipit-theme")).toBe("rose");
  });

  it("setTheme applies claude theme class", () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setTheme("claude"));

    expect(result.current.theme).toBe("claude");
    expect(document.documentElement.classList.contains("claude")).toBe(true);
    expect(localStorage.getItem("shipit-theme")).toBe("claude");
  });

  it("setTheme applies codex theme class", () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setTheme("codex"));

    expect(result.current.theme).toBe("codex");
    expect(document.documentElement.classList.contains("codex")).toBe(true);
    expect(localStorage.getItem("shipit-theme")).toBe("codex");
  });

  it("setTheme applies warm-light as class (light variant)", () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setTheme("warm-light"));

    expect(result.current.theme).toBe("warm-light");
    expect(document.documentElement.classList.contains("warm-light")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("setTheme applies solarized theme class", () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setTheme("solarized"));

    expect(result.current.theme).toBe("solarized");
    expect(document.documentElement.classList.contains("solarized")).toBe(true);
  });

  it("setTheme applies high-contrast theme class", () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setTheme("high-contrast"));

    expect(result.current.theme).toBe("high-contrast");
    expect(document.documentElement.classList.contains("high-contrast")).toBe(true);
  });

  it("switching from one custom theme to another removes old class", () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setTheme("midnight"));
    expect(document.documentElement.classList.contains("midnight")).toBe(true);

    act(() => result.current.setTheme("forest"));
    expect(document.documentElement.classList.contains("forest")).toBe(true);
    expect(document.documentElement.classList.contains("midnight")).toBe(false);
  });

  it("THEME_OPTIONS includes all fourteen themes", () => {
    const ids = THEME_OPTIONS.map((t) => t.id);
    expect(ids).toEqual([
      "light", "warm-light", "cool-light", "solarized-light", "claude-light", "codex-light",
      "dark", "midnight", "forest", "rose",
      "claude", "codex", "solarized", "high-contrast",
    ]);
  });
});
