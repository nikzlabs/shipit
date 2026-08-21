import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { usePreviewStore } from "./preview-store.js";
import { findPresetById } from "../components/device-presets.js";

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

    it("keeps customSize when selecting the custom category (docs/279 D2)", () => {
      usePreviewStore.getState().setCustomSize({ width: 500, height: 900 });
      // Re-applying a size must not wipe the value it just installed.
      expect(usePreviewStore.getState().customSize).toEqual({ width: 500, height: 900 });
      expect(usePreviewStore.getState().devicePreset?.category).toBe("custom");
    });

    it("resets isLandscape when switching from a rotated preset to a custom size (docs/279 D1)", () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16"));
      usePreviewStore.getState().toggleLandscape();
      expect(usePreviewStore.getState().isLandscape).toBe(true);
      usePreviewStore.getState().setCustomSize({ width: 800, height: 600 });
      expect(usePreviewStore.getState().isLandscape).toBe(false);
    });

    it("resets isLandscape when returning to Responsive (docs/279 D1)", () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16"));
      usePreviewStore.getState().toggleLandscape();
      usePreviewStore.getState().setDevicePreset(null);
      expect(usePreviewStore.getState().isLandscape).toBe(false);
    });

    it("re-enters portrait when switching between named presets (docs/279 D1)", () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16"));
      usePreviewStore.getState().toggleLandscape();
      usePreviewStore.getState().setDevicePreset(findPresetById("ipad-mini"));
      expect(usePreviewStore.getState().isLandscape).toBe(false);
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

    it("installs the synthetic custom preset (docs/279 D2)", () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16"));
      usePreviewStore.getState().setCustomSize({ width: 500, height: 900 });
      const preset = usePreviewStore.getState().devicePreset;
      expect(preset?.id).toBe("custom");
      expect(preset?.category).toBe("custom");
      expect(preset?.width).toBe(500);
      expect(preset?.height).toBe(900);
      // The label mirrors the applied size so the collapsed toolbar's
      // tooltip stays truthful.
      expect(preset?.label).toBe("500×900");
    });

    it("refreshes dimensions when a custom size is re-applied (docs/279 D2)", () => {
      usePreviewStore.getState().setCustomSize({ width: 500, height: 900 });
      usePreviewStore.getState().setCustomSize({ width: 640, height: 480 });
      const preset = usePreviewStore.getState().devicePreset;
      expect(preset?.width).toBe(640);
      expect(preset?.height).toBe(480);
      expect(preset?.label).toBe("640×480");
    });

    it("clears when called with null, dropping the synthetic preset too (docs/279 D2)", () => {
      usePreviewStore.getState().setCustomSize({ width: 500, height: 900 });
      usePreviewStore.getState().setCustomSize(null);
      expect(usePreviewStore.getState().customSize).toBeNull();
      expect(usePreviewStore.getState().devicePreset).toBeNull();
    });

    it("null does not clobber an unrelated named preset", () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16"));
      usePreviewStore.getState().setCustomSize(null);
      expect(usePreviewStore.getState().devicePreset?.id).toBe("iphone-16");
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

      // Switching presets re-enters portrait (docs/279 D1) — the landscape
      // flag is per-selection, not carried across.
      usePreviewStore.getState().setDevicePreset(findPresetById("ipad-mini"));
      expect(usePreviewStore.getState().isLandscape).toBe(false);
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
      // setCustomSize installs the synthetic custom preset itself (docs/279 D2).
      usePreviewStore.getState().setCustomSize({ width: 500, height: 900 });
      usePreviewStore.getState().snapshotSession("session-a");

      usePreviewStore.getState().restoreSession("session-b");
      expect(usePreviewStore.getState().devicePreset).toBeNull();
      expect(usePreviewStore.getState().customSize).toBeNull();

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
