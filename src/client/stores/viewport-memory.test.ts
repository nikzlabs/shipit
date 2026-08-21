import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadViewportMemory,
  saveViewportMemory,
  sanitizeViewportEntry,
  viewportEntryFromState,
  viewportStateFromEntry,
  withViewportEntry,
  MAX_REMEMBERED_VIEWPORTS,
  VIEWPORT_MEMORY_KEY,
  type PersistedViewport,
} from "./viewport-memory.js";
import { customPreset, findPresetById } from "../components/device-presets.js";

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("sanitizeViewportEntry", () => {
  it("accepts a known preset id, with and without landscape", () => {
    expect(sanitizeViewportEntry({ preset: "iphone-16" })).toEqual({ preset: "iphone-16" });
    expect(sanitizeViewportEntry({ preset: "ipad-air", landscape: true })).toEqual({
      preset: "ipad-air",
      landscape: true,
    });
  });

  it("drops unknown preset ids — presets renamed by an update restore as Responsive", () => {
    expect(sanitizeViewportEntry({ preset: "iphone-4" })).toBeNull();
    // "custom" is never a persisted preset id; custom sizes persist dims.
    expect(sanitizeViewportEntry({ preset: "custom" })).toBeNull();
  });

  it("accepts in-bounds custom dims and drops everything else", () => {
    expect(sanitizeViewportEntry({ custom: { width: 500, height: 900 } })).toEqual({
      custom: { width: 500, height: 900 },
    });
    for (const bad of [
      { custom: { width: 99, height: 900 } },
      { custom: { width: 500, height: 9999 } },
      { custom: { width: 500.5, height: 900 } },
      { custom: { width: "500", height: 900 } },
      { custom: { width: 500 } },
      { custom: null },
      "iphone-16",
      42,
      null,
      [],
    ]) {
      expect(sanitizeViewportEntry(bad)).toBeNull();
    }
  });

  it("drops a non-boolean landscape rather than guessing", () => {
    expect(sanitizeViewportEntry({ preset: "iphone-16", landscape: "yes" })).toEqual({
      preset: "iphone-16",
    });
  });
});

describe("load/save round-trip", () => {
  it("round-trips a mixed map", () => {
    const map: Record<string, PersistedViewport> = {
      a: { preset: "iphone-16", landscape: true },
      b: { custom: { width: 500, height: 900 } },
    };
    saveViewportMemory(map);
    expect(loadViewportMemory()).toEqual(map);
  });

  it("returns {} for absent, corrupt, or non-object storage", () => {
    expect(loadViewportMemory()).toEqual({});
    localStorage.setItem(VIEWPORT_MEMORY_KEY, "not json");
    expect(loadViewportMemory()).toEqual({});
    localStorage.setItem(VIEWPORT_MEMORY_KEY, JSON.stringify([1, 2]));
    expect(loadViewportMemory()).toEqual({});
  });

  it("drops invalid entries and keeps valid ones", () => {
    localStorage.setItem(
      VIEWPORT_MEMORY_KEY,
      JSON.stringify({
        good: { preset: "pixel-9" },
        stale: { preset: "retired-device" },
        broken: { custom: { width: -1, height: 1e9 } },
      }),
    );
    expect(loadViewportMemory()).toEqual({ good: { preset: "pixel-9" } });
  });

  it("truncates an oversized blob from the front (oldest first)", () => {
    const big: Record<string, PersistedViewport> = {};
    for (let i = 0; i < MAX_REMEMBERED_VIEWPORTS + 10; i++) {
      big[`s${i}`] = { preset: "iphone-se" };
    }
    localStorage.setItem(VIEWPORT_MEMORY_KEY, JSON.stringify(big));
    const loaded = loadViewportMemory();
    expect(Object.keys(loaded)).toHaveLength(MAX_REMEMBERED_VIEWPORTS);
    expect(loaded.s0).toBeUndefined();
    expect(loaded[`s${MAX_REMEMBERED_VIEWPORTS + 9}`]).toBeDefined();
  });
});

describe("withViewportEntry", () => {
  it("inserts, replaces, and deletes (null entry = Responsive)", () => {
    let map = withViewportEntry({}, "a", { preset: "iphone-16" });
    expect(map).toEqual({ a: { preset: "iphone-16" } });
    map = withViewportEntry(map, "a", { custom: { width: 500, height: 900 } });
    expect(map).toEqual({ a: { custom: { width: 500, height: 900 } } });
    map = withViewportEntry(map, "a", null);
    expect(map).toEqual({});
  });

  it("evicts the least-recently-written entry past the cap", () => {
    let map: Record<string, PersistedViewport> = {};
    for (let i = 0; i < MAX_REMEMBERED_VIEWPORTS; i++) {
      map = withViewportEntry(map, `s${i}`, { preset: "iphone-se" });
    }
    // Re-writing the oldest key makes it most recent, so the *next* one ages out.
    map = withViewportEntry(map, "s0", { preset: "pixel-9" });
    map = withViewportEntry(map, "s-new", { preset: "ipad-mini" });
    expect(Object.keys(map)).toHaveLength(MAX_REMEMBERED_VIEWPORTS);
    expect(map.s0).toEqual({ preset: "pixel-9" });
    expect(map.s1).toBeUndefined();
    expect(map["s-new"]).toEqual({ preset: "ipad-mini" });
  });
});

describe("state ↔ entry mapping", () => {
  it("maps Responsive to absence", () => {
    expect(
      viewportEntryFromState({ devicePreset: null, isLandscape: false, customSize: null }),
    ).toBeNull();
  });

  it("maps a named preset with orientation, and back", () => {
    const entry = viewportEntryFromState({
      devicePreset: findPresetById("iphone-16"),
      isLandscape: true,
      customSize: null,
    });
    expect(entry).toEqual({ preset: "iphone-16", landscape: true });
    expect(viewportStateFromEntry(entry!)).toEqual({
      devicePreset: findPresetById("iphone-16"),
      isLandscape: true,
      customSize: null,
    });
  });

  it("maps a custom size, and back to a 'Custom'-labelled synthetic preset", () => {
    const entry = viewportEntryFromState({
      devicePreset: customPreset(500, 900),
      isLandscape: false,
      customSize: { width: 500, height: 900 },
    });
    expect(entry).toEqual({ custom: { width: 500, height: 900 } });
    const state = viewportStateFromEntry(entry!);
    expect(state.devicePreset).toMatchObject({ id: "custom", label: "Custom", width: 500, height: 900 });
    expect(state.customSize).toEqual({ width: 500, height: 900 });
    expect(state.isLandscape).toBe(false);
  });

  it("expands absence (and a stale entry) to Responsive", () => {
    expect(viewportStateFromEntry(undefined)).toEqual({
      devicePreset: null,
      isLandscape: false,
      customSize: null,
    });
  });
});
