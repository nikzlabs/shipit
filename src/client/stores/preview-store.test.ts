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

  describe("setViewportSize", () => {
    it("sets the size and switches to Custom in one step", () => {
      usePreviewStore.getState().setViewportSize(500, 900);
      expect(usePreviewStore.getState().customSize).toEqual({ width: 500, height: 900 });
      expect(usePreviewStore.getState().devicePreset?.category).toBe("custom");
    });

    it("keeps the size when moving from a named preset to a freeform one", () => {
      // Doing this as setCustomSize + setDevicePreset has an order that works
      // and an order that throws the size away, which is why it is one action.
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16"));
      usePreviewStore.getState().setViewportSize(500, 900);
      expect(usePreviewStore.getState().customSize).toEqual({ width: 500, height: 900 });
    });

    it("labels the custom preset 'Custom' rather than its dimensions", () => {
      // The toolbar prints W×H right beside this label, and a rotate leaves
      // dimensions baked into a label stale.
      usePreviewStore.getState().setViewportSize(500, 900);
      expect(usePreviewStore.getState().devicePreset?.label).toBe("Custom");
    });

    it("holds a size from outside the allowed range at the bound", () => {
      usePreviewStore.getState().setViewportSize(10, 99999);
      expect(usePreviewStore.getState().customSize).toEqual({ width: 100, height: 2560 });
    });
  });

  describe("remembering the viewport across a reload", () => {
    it("brings a preset back for the same session", () => {
      usePreviewStore.getState().restoreViewport("session-a");
      usePreviewStore.getState().setDevicePreset(findPresetById("ipad-mini"));
      usePreviewStore.getState().toggleLandscape();

      // A reload: the store is new, only localStorage survived.
      usePreviewStore.getState().reset();
      expect(usePreviewStore.getState().devicePreset).toBeNull();

      usePreviewStore.getState().restoreViewport("session-a");
      expect(usePreviewStore.getState().devicePreset?.id).toBe("ipad-mini");
      expect(usePreviewStore.getState().isLandscape).toBe(true);
    });

    it("brings a freeform size back for the same session", () => {
      usePreviewStore.getState().restoreViewport("session-a");
      usePreviewStore.getState().setViewportSize(512, 768);

      usePreviewStore.getState().reset();
      usePreviewStore.getState().restoreViewport("session-a");

      expect(usePreviewStore.getState().customSize).toEqual({ width: 512, height: 768 });
      expect(usePreviewStore.getState().devicePreset?.category).toBe("custom");
    });

    it("keeps two sessions' choices apart", () => {
      usePreviewStore.getState().restoreViewport("session-a");
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-se"));
      usePreviewStore.getState().restoreViewport("session-b");
      usePreviewStore.getState().setDevicePreset(findPresetById("ipad-air"));

      usePreviewStore.getState().reset();

      usePreviewStore.getState().restoreViewport("session-a");
      expect(usePreviewStore.getState().devicePreset?.id).toBe("iphone-se");
      usePreviewStore.getState().restoreViewport("session-b");
      expect(usePreviewStore.getState().devicePreset?.id).toBe("ipad-air");
    });

    it("starts a session that has never chosen on Responsive", () => {
      usePreviewStore.getState().restoreViewport("session-a");
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-se"));
      usePreviewStore.getState().restoreViewport("never-seen");
      expect(usePreviewStore.getState().devicePreset).toBeNull();
      expect(usePreviewStore.getState().isLandscape).toBe(false);
    });

    it("forgets a session that goes back to Responsive", () => {
      usePreviewStore.getState().restoreViewport("session-a");
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-se"));
      usePreviewStore.getState().setDevicePreset(null);

      usePreviewStore.getState().reset();
      usePreviewStore.getState().restoreViewport("session-a");
      expect(usePreviewStore.getState().devicePreset).toBeNull();
      // Storing the default would grow the map for no information.
      expect(localStorage.getItem("shipit:preview-viewports")).toBe("{}");
    });

    it("degrades to Responsive when the remembered preset no longer exists", () => {
      // A preset we rename or drop must not restore dimensions nothing offers.
      localStorage.setItem(
        "shipit:preview-viewports",
        JSON.stringify({ "session-a": { presetId: "nokia-3310", landscape: true } }),
      );
      usePreviewStore.getState().restoreViewport("session-a");
      expect(usePreviewStore.getState().devicePreset).toBeNull();
      expect(usePreviewStore.getState().isLandscape).toBe(false);
    });

    it("survives a corrupt stored value", () => {
      localStorage.setItem("shipit:preview-viewports", "{ not json");
      expect(() => usePreviewStore.getState().restoreViewport("session-a")).not.toThrow();
      expect(usePreviewStore.getState().devicePreset).toBeNull();
    });

    it("clamps a stored size that is out of range", () => {
      localStorage.setItem(
        "shipit:preview-viewports",
        JSON.stringify({ "session-a": { presetId: "custom", landscape: false, width: 5, height: 99999 } }),
      );
      usePreviewStore.getState().restoreViewport("session-a");
      expect(usePreviewStore.getState().customSize).toEqual({ width: 100, height: 2560 });
    });

    it("writes nothing before a session is known", () => {
      // Component tests poke the store directly; that must not create an entry
      // under some other session's name.
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-se"));
      expect(localStorage.getItem("shipit:preview-viewports")).toBeNull();
    });

    it("restores the remembered choice when switching to a session this tab has not shown", () => {
      usePreviewStore.getState().restoreViewport("session-a");
      usePreviewStore.getState().setDevicePreset(findPresetById("pixel-9"));
      usePreviewStore.getState().reset();

      // `restoreSession` is the session-switch path; with no in-memory snapshot
      // it has to fall back to what was remembered.
      usePreviewStore.getState().restoreSession("session-a");
      expect(usePreviewStore.getState().devicePreset?.id).toBe("pixel-9");
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
