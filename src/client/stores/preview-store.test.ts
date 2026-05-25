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
      const preset = findPresetById("iphone-14")!;
      usePreviewStore.getState().setDevicePreset(preset);
      expect(usePreviewStore.getState().devicePreset?.id).toBe("iphone-14");
    });

    it("clears the preset when called with null", () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-14"));
      usePreviewStore.getState().setDevicePreset(null);
      expect(usePreviewStore.getState().devicePreset).toBeNull();
    });

    it("clears customSize when switching to a non-custom preset", () => {
      usePreviewStore.getState().setCustomSize({ width: 500, height: 900 });
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-14"));
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

  describe("session snapshots", () => {
    it("findPresetById returns null for unknown id", () => {
      expect(findPresetById("nonexistent")).toBeNull();
      expect(findPresetById(null)).toBeNull();
      expect(findPresetById(undefined)).toBeNull();
    });

    it("persists device viewport state per session snapshot", () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-14"));
      usePreviewStore.getState().toggleLandscape();
      usePreviewStore.getState().snapshotSession("session-a");

      usePreviewStore.getState().setDevicePreset(findPresetById("ipad-mini"));
      usePreviewStore.getState().toggleLandscape();
      usePreviewStore.getState().snapshotSession("session-b");

      usePreviewStore.getState().restoreSession("session-a");
      expect(usePreviewStore.getState().devicePreset?.id).toBe("iphone-14");
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
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-14"));
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
