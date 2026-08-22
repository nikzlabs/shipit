import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { usePreviewStore } from "./preview-store.js";
import { customPreset, findPresetById } from "../components/device-presets.js";

describe("preview-store device viewport", () => {
  beforeEach(() => {
    localStorage.clear();
    usePreviewStore.getState().reset();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe("setDevicePreset", () => {
    it("updates the active preset in store state", () => {
      const preset = findPresetById("iphone-16")!;
      usePreviewStore.getState().setDevicePreset(preset);
      expect(usePreviewStore.getState().devicePreset?.id).toBe("iphone-16");
    });

    it("clears the preset when called with null", () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16"));
      usePreviewStore.getState().setDevicePreset(null);
      expect(usePreviewStore.getState().devicePreset).toBeNull();
    });

    it("clears customSize when switching to a non-custom preset", () => {
      usePreviewStore.getState().setCustomSize({ width: 500, height: 900 });
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16"));
      expect(usePreviewStore.getState().customSize).toBeNull();
    });
  });

  describe("toggleLandscape", () => {
    it("flips the isLandscape flag", () => {
      expect(usePreviewStore.getState().isLandscape).toBe(false);
      usePreviewStore.getState().toggleLandscape();
      expect(usePreviewStore.getState().isLandscape).toBe(true);
      usePreviewStore.getState().toggleLandscape();
      expect(usePreviewStore.getState().isLandscape).toBe(false);
    });
  });

  describe("setCustomSize", () => {
    it("stores a width/height pair", () => {
      usePreviewStore.getState().setCustomSize({ width: 500, height: 900 });
      expect(usePreviewStore.getState().customSize).toEqual({ width: 500, height: 900 });
    });

    it("clears when called with null", () => {
      usePreviewStore.getState().setCustomSize({ width: 500, height: 900 });
      usePreviewStore.getState().setCustomSize(null);
      expect(usePreviewStore.getState().customSize).toBeNull();
    });
  });

  describe("viewport persistence across a reload", () => {
    // A reload is a fresh module graph over the same localStorage: wipe the
    // module registry and re-import the store, then ask the NEW instance what
    // the Preview tab would open with.
    async function reloadedStore() {
      vi.resetModules();
      const { usePreviewStore: fresh } = await import("./preview-store.js");
      return fresh;
    }

    it("brings back a picked preset", async () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16")!);
      const fresh = await reloadedStore();
      expect(fresh.getState().devicePreset?.id).toBe("iphone-16");
      expect(fresh.getState().isLandscape).toBe(false);
      expect(fresh.getState().customSize).toBeNull();
    });

    it("brings back orientation and a custom size together", async () => {
      usePreviewStore.getState().setCustomSize({ width: 500, height: 900 });
      usePreviewStore.getState().setDevicePreset(customPreset(500, 900));
      usePreviewStore.getState().toggleLandscape();
      const fresh = await reloadedStore();
      expect(fresh.getState().devicePreset).toEqual(customPreset(500, 900));
      expect(fresh.getState().isLandscape).toBe(true);
      expect(fresh.getState().customSize).toEqual({ width: 500, height: 900 });
    });

    it("brings back Responsive when that was the last pick", async () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("ipad-air")!);
      usePreviewStore.getState().setDevicePreset(null);
      const fresh = await reloadedStore();
      expect(fresh.getState().devicePreset).toBeNull();
      expect(fresh.getState().isLandscape).toBe(false);
    });

    it("a session with no snapshot still opens at the persisted viewport", () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-se")!);
      // The no-snapshot branch of restoreSession is also what every post-reload
      // resume runs, so falling back to bare defaults here would undo req 1.
      usePreviewStore.getState().restoreSession("never-seen");
      expect(usePreviewStore.getState().devicePreset?.id).toBe("iphone-se");
    });

    it("a session with a snapshot restores its own viewport instead", () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-se")!);
      usePreviewStore.getState().snapshotSession("a");
      usePreviewStore.getState().setDevicePreset(findPresetById("ipad-air")!);
      usePreviewStore.getState().restoreSession("a");
      expect(usePreviewStore.getState().devicePreset?.id).toBe("iphone-se");
    });

    it.each([
      ["truncated JSON", "{not json"],
      ["a non-object", "[1,2]"],
      ["an unknown preset id", JSON.stringify({ presetId: "pixel-99", landscape: true, custom: null })],
      ["a custom preset with no dimensions", JSON.stringify({ presetId: "custom", landscape: false, custom: null })],
      ["dimensions out of range", JSON.stringify({ presetId: "custom", landscape: false, custom: { width: 50, height: 99_999 } })],
      ["non-numeric dimensions", JSON.stringify({ presetId: "custom", landscape: false, custom: { width: "wide", height: 900 } })],
      ["a non-string preset id", JSON.stringify({ presetId: 42, landscape: false, custom: null })],
    ])("falls back to Responsive on %s", async (_name, stored) => {
      localStorage.setItem("shipit:preview-viewport", stored as string);
      const fresh = await reloadedStore();
      expect(fresh.getState().devicePreset).toBeNull();
      expect(fresh.getState().customSize).toBeNull();
    });
  });

  describe("session snapshots", () => {
    it("findPresetById returns null for unknown id", () => {
      expect(findPresetById("nonexistent")).toBeNull();
      expect(findPresetById(null)).toBeNull();
      expect(findPresetById(undefined)).toBeNull();
    });

    it("persists device viewport state per session snapshot", () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16"));
      usePreviewStore.getState().toggleLandscape();
      usePreviewStore.getState().snapshotSession("session-a");

      usePreviewStore.getState().setDevicePreset(findPresetById("ipad-mini"));
      usePreviewStore.getState().toggleLandscape();
      usePreviewStore.getState().snapshotSession("session-b");

      usePreviewStore.getState().restoreSession("session-a");
      expect(usePreviewStore.getState().devicePreset?.id).toBe("iphone-16");
      expect(usePreviewStore.getState().isLandscape).toBe(true);
      expect(usePreviewStore.getState().customSize).toBeNull();

      usePreviewStore.getState().restoreSession("session-b");
      expect(usePreviewStore.getState().devicePreset?.id).toBe("ipad-mini");
      expect(usePreviewStore.getState().isLandscape).toBe(false);
    });

    it("persists custom viewport state per session snapshot", () => {
      usePreviewStore.getState().setCustomSize({ width: 500, height: 900 });
      usePreviewStore.getState().setDevicePreset({
        id: "custom",
        label: "500×900",
        width: 500,
        height: 900,
        category: "custom",
      });
      usePreviewStore.getState().snapshotSession("session-a");

      // A session with no snapshot opens at the last-picked viewport
      // (docs/280) — this branch is also what every post-reload resume runs.
      usePreviewStore.getState().restoreSession("session-b");
      expect(usePreviewStore.getState().devicePreset).toEqual(customPreset(500, 900));
      expect(usePreviewStore.getState().customSize).toEqual({ width: 500, height: 900 });

      usePreviewStore.getState().restoreSession("session-a");
      expect(usePreviewStore.getState().devicePreset?.id).toBe("custom");
      expect(usePreviewStore.getState().customSize).toEqual({ width: 500, height: 900 });
    });
  });

  describe("reset()", () => {
    it("clears device state and session snapshots", () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16"));
      usePreviewStore.getState().toggleLandscape();
      usePreviewStore.getState().setCustomSize({ width: 500, height: 900 });
      usePreviewStore.getState().snapshotSession("session-a");

      usePreviewStore.getState().reset();

      expect(usePreviewStore.getState().devicePreset).toBeNull();
      expect(usePreviewStore.getState().isLandscape).toBe(false);
      expect(usePreviewStore.getState().customSize).toBeNull();
      expect(usePreviewStore.getState().getSnapshot("session-a")).toBeUndefined();
    });
  });
});

describe("preview-store startup steps", () => {
  beforeEach(() => {
    usePreviewStore.getState().reset();
  });

  describe("appendStartupStepLog", () => {
    it("no-ops when the target step does not exist", () => {
      // No initStartupSteps() call — appending should not crash.
      usePreviewStore.getState().appendStartupStepLog("install", "hello\n");
      expect(usePreviewStore.getState().startupSteps).toEqual([]);
    });

    it("appends each newline-separated chunk as its own line", () => {
      usePreviewStore.getState().initStartupSteps();
      usePreviewStore.getState().appendStartupStepLog("install", "added 50 packages\nfound 0 vulns\n");
      const step = usePreviewStore.getState().startupSteps.find((s) => s.stepId === "install");
      expect(step?.logLines).toEqual(["added 50 packages", "found 0 vulns"]);
    });

    it("strips trailing newlines but preserves blank intermediate lines", () => {
      usePreviewStore.getState().initStartupSteps();
      usePreviewStore.getState().appendStartupStepLog("install", "line a\n\nline b\n\n\n");
      const step = usePreviewStore.getState().startupSteps.find((s) => s.stepId === "install");
      // Blank line between line a and line b is intentional progress noise; keep it.
      expect(step?.logLines).toEqual(["line a", "", "line b"]);
    });

    it("keeps only the most recent 50 lines for chatty installs", () => {
      usePreviewStore.getState().initStartupSteps();
      // Pump in 200 distinct lines.
      for (let i = 0; i < 200; i++) {
        usePreviewStore.getState().appendStartupStepLog("install", `line ${i}\n`);
      }
      const step = usePreviewStore.getState().startupSteps.find((s) => s.stepId === "install");
      expect(step?.logLines.length).toBe(50);
      // Last appended line wins.
      expect(step?.logLines[49]).toBe("line 199");
      // Trimmed from the front, so anything older than line 150 is gone.
      expect(step?.logLines[0]).toBe("line 150");
    });

    it("does not affect sibling steps", () => {
      usePreviewStore.getState().initStartupSteps();
      usePreviewStore.getState().appendStartupStepLog("install", "only install\n");
      const fetchStep = usePreviewStore.getState().startupSteps.find((s) => s.stepId === "fetch");
      const devStep = usePreviewStore.getState().startupSteps.find((s) => s.stepId === "dev_server");
      expect(fetchStep?.logLines).toEqual([]);
      expect(devStep?.logLines).toEqual([]);
    });
  });

  describe("setStartupStep", () => {
    it("merges a status update into the existing step", () => {
      usePreviewStore.getState().initStartupSteps();
      usePreviewStore.getState().setStartupStep({ stepId: "install", status: "running" });
      const step = usePreviewStore.getState().startupSteps.find((s) => s.stepId === "install");
      expect(step?.status).toBe("running");
    });

    it("preserves logLines when no logLines field is included in the update", () => {
      usePreviewStore.getState().initStartupSteps();
      usePreviewStore.getState().appendStartupStepLog("install", "preserved\n");
      usePreviewStore.getState().setStartupStep({ stepId: "install", status: "complete" });
      const step = usePreviewStore.getState().startupSteps.find((s) => s.stepId === "install");
      expect(step?.logLines).toEqual(["preserved"]);
    });
  });
});

describe("preview-store remembered paths", () => {
  beforeEach(() => {
    localStorage.clear();
    usePreviewStore.getState().reset();
    usePreviewStore.getState().clearPreviewPaths();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("survives the session-scoped reset", () => {
    // `resetSessionState()` calls `reset()` when the route leaves a session for
    // home — the same moment the desktop layout unmounts the iframe pool. If
    // reset wiped these, the pool would be recreated at the front page, which
    // is the one thing this map exists to prevent.
    usePreviewStore.getState().setPreviewPath("s1:5173", "/orders/8842");
    usePreviewStore.getState().reset();
    expect(usePreviewStore.getState().previewPaths["s1:5173"]).toBe("/orders/8842");
  });

  it("is cleared by clearPreviewPaths, in state and in storage", () => {
    usePreviewStore.getState().setPreviewPath("s1:5173", "/orders/8842");
    usePreviewStore.getState().clearPreviewPaths();
    expect(usePreviewStore.getState().previewPaths).toEqual({});
    expect(localStorage.getItem("shipit:preview-paths")).toBe("{}");
  });

  it("rejects paths that the URL parser would resolve to a foreign origin", () => {
    // WHATWG parsing treats `\` as `/` for http(s) and strips tab/CR/LF
    // anywhere in the input, so each of these resolves off-origin despite
    // starting with a single slash. The value is authored by the previewed
    // page, and it reaches an iframe `src` and the user's clipboard.
    for (const path of [
      "//evil.example/x",
      "/\\evil.example/x",
      "/\t/evil.example/x",
      "/\n/evil.example/x",
      "/\r/evil.example/x",
      "http://evil.example/x",
      "javascript:alert(1)",
      42,
    ]) {
      usePreviewStore.getState().setPreviewPath("s1:5173", path);
      expect(usePreviewStore.getState().previewPaths["s1:5173"]).toBeUndefined();
    }
  });

  it("evicts the least-recently-written entry past the cap", () => {
    for (let i = 0; i < 100; i++) usePreviewStore.getState().setPreviewPath(`s${i}:3000`, `/p${i}`);
    // Re-writing the oldest key makes it most recent, so the *next* one ages out.
    usePreviewStore.getState().setPreviewPath("s0:3000", "/refreshed");
    usePreviewStore.getState().setPreviewPath("s100:3000", "/p100");

    const paths = usePreviewStore.getState().previewPaths;
    expect(Object.keys(paths)).toHaveLength(100);
    expect(paths["s0:3000"]).toBe("/refreshed");
    expect(paths["s1:3000"]).toBeUndefined();
    expect(paths["s100:3000"]).toBe("/p100");
  });
});
