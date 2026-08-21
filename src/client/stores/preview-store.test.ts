import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { usePreviewStore, VIEWPORT_FLUSH_DEBOUNCE_MS } from "./preview-store.js";
import { useSessionStore } from "./session-store.js";
import { findPresetById } from "../components/device-presets.js";
import { VIEWPORT_MEMORY_KEY } from "./viewport-memory.js";

describe("preview-store device viewport", () => {
  beforeEach(() => {
    // clearViewportMemory before localStorage.clear(): it writes "{}" to
    // storage, and these tests want a genuinely empty storage baseline.
    usePreviewStore.getState().clearViewportMemory();
    localStorage.clear();
    usePreviewStore.getState().reset();
    useSessionStore.setState({ sessionId: "session-a" });
  });

  afterEach(() => {
    localStorage.clear();
    useSessionStore.setState({ sessionId: undefined });
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
      usePreviewStore.getState().setFreeformSize(500, 900);
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16"));
      expect(usePreviewStore.getState().customSize).toBeNull();
    });
  });

  describe("toggleLandscape", () => {
    it("flips the isLandscape flag for named presets", () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16"));
      expect(usePreviewStore.getState().isLandscape).toBe(false);
      usePreviewStore.getState().toggleLandscape();
      expect(usePreviewStore.getState().isLandscape).toBe(true);
      usePreviewStore.getState().toggleLandscape();
      expect(usePreviewStore.getState().isLandscape).toBe(false);
    });

    it("swaps the stored dims for a custom size instead of flipping the flag", () => {
      usePreviewStore.getState().setFreeformSize(500, 900);
      usePreviewStore.getState().toggleLandscape();
      const s = usePreviewStore.getState();
      expect(s.customSize).toEqual({ width: 900, height: 500 });
      expect(s.isLandscape).toBe(false);
      expect(s.devicePreset).toMatchObject({ id: "custom", label: "Custom", width: 900, height: 500 });
    });
  });

  describe("setFreeformSize", () => {
    it("activates a Custom preset, size, and portrait flag atomically", () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16"));
      usePreviewStore.getState().toggleLandscape();
      usePreviewStore.getState().setFreeformSize(500, 900);
      const s = usePreviewStore.getState();
      expect(s.devicePreset).toMatchObject({ id: "custom", label: "Custom", category: "custom" });
      expect(s.customSize).toEqual({ width: 500, height: 900 });
      // A freeform size is stored as rendered — a leftover landscape flag from
      // the preset it detached from would render it swapped.
      expect(s.isLandscape).toBe(false);
    });
  });

  describe("per-session viewport memory", () => {
    it("findPresetById returns null for unknown id", () => {
      expect(findPresetById("nonexistent")).toBeNull();
      expect(findPresetById(null)).toBeNull();
      expect(findPresetById(undefined)).toBeNull();
    });

    it("restores each session's viewport when switching between sessions", () => {
      // Mirrors resumeSessionInternal's order: mutate under A, snapshot A,
      // move the session id, restore B.
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16"));
      usePreviewStore.getState().toggleLandscape();
      usePreviewStore.getState().snapshotSession("session-a");

      useSessionStore.setState({ sessionId: "session-b" });
      usePreviewStore.getState().restoreSession("session-b");
      expect(usePreviewStore.getState().devicePreset).toBeNull();
      usePreviewStore.getState().setFreeformSize(500, 900);
      usePreviewStore.getState().snapshotSession("session-b");

      useSessionStore.setState({ sessionId: "session-a" });
      usePreviewStore.getState().restoreSession("session-a");
      expect(usePreviewStore.getState().devicePreset?.id).toBe("iphone-16");
      expect(usePreviewStore.getState().isLandscape).toBe(true);
      expect(usePreviewStore.getState().customSize).toBeNull();

      useSessionStore.setState({ sessionId: "session-b" });
      usePreviewStore.getState().restoreSession("session-b");
      expect(usePreviewStore.getState().devicePreset?.id).toBe("custom");
      expect(usePreviewStore.getState().customSize).toEqual({ width: 500, height: 900 });
      expect(usePreviewStore.getState().isLandscape).toBe(false);
    });

    it("restores from memory even when an accidental defaults snapshot exists (cold load)", () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("pixel-9"));
      // Cold load: the URL→store sync effect calls resumeSessionInternal while
      // the store still holds defaults, so a defaults snapshot for the incoming
      // session exists by the time restoreSession runs. The memory must win.
      usePreviewStore.setState({ devicePreset: null, isLandscape: false, customSize: null });
      usePreviewStore.getState().snapshotSession("session-a");
      usePreviewStore.getState().restoreSession("session-a");
      expect(usePreviewStore.getState().devicePreset?.id).toBe("pixel-9");
    });

    it("remembers nothing without an active session", () => {
      useSessionStore.setState({ sessionId: undefined });
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16"));
      expect(usePreviewStore.getState().viewportMemory).toEqual({});
    });

    it("survives the session-scoped reset", () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16"));
      usePreviewStore.getState().reset();
      expect(usePreviewStore.getState().viewportMemory["session-a"]).toEqual({ preset: "iphone-16" });
    });

    it("flushes to localStorage debounced, and stores landscape with the preset", () => {
      vi.useFakeTimers();
      try {
        usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16"));
        usePreviewStore.getState().toggleLandscape();
        expect(localStorage.getItem(VIEWPORT_MEMORY_KEY)).toBeNull();
        vi.advanceTimersByTime(VIEWPORT_FLUSH_DEBOUNCE_MS);
        expect(JSON.parse(localStorage.getItem(VIEWPORT_MEMORY_KEY)!)).toEqual({
          "session-a": { preset: "iphone-16", landscape: true },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("returning to Responsive deletes the session's entry", () => {
      vi.useFakeTimers();
      try {
        usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16"));
        usePreviewStore.getState().setDevicePreset(null);
        vi.advanceTimersByTime(VIEWPORT_FLUSH_DEBOUNCE_MS);
        expect(JSON.parse(localStorage.getItem(VIEWPORT_MEMORY_KEY)!)).toEqual({});
        expect(usePreviewStore.getState().viewportMemory).toEqual({});
      } finally {
        vi.useRealTimers();
      }
    });

    it("is cleared by clearViewportMemory, in state and in storage", () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16"));
      usePreviewStore.getState().clearViewportMemory();
      expect(usePreviewStore.getState().viewportMemory).toEqual({});
      expect(localStorage.getItem(VIEWPORT_MEMORY_KEY)).toBe("{}");
    });
  });

  describe("reset()", () => {
    it("clears live device state and session snapshots", () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16"));
      usePreviewStore.getState().toggleLandscape();
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
