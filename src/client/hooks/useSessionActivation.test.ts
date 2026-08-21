import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSessionActivation } from "./useSessionActivation.js";
import { usePreviewStore } from "../stores/preview-store.js";
import { findPresetById } from "../components/device-presets.js";

/**
 * Landing directly on a session URL — a reload, or following a link — never
 * passes through `resumeSessionInternal`, so this hook's mount effect is the
 * only thing that brings the session's remembered preview viewport back
 * (docs/278-preview-viewport-resize req 9).
 */
function mount(urlSessionId: string | undefined) {
  return renderHook(() =>
    useSessionActivation({
      urlSessionId,
      sessionId: urlSessionId,
      isNewSessionRoute: false,
      newSessionRepoSlug: undefined,
      newSessionRepoUrl: undefined,
      bootstrapLoaded: false,
      reposLength: 0,
      disableAutoFix: vi.fn(),
      navigate: vi.fn(),
    }),
  );
}

describe("useSessionActivation — remembered preview viewport", () => {
  beforeEach(() => {
    localStorage.clear();
    usePreviewStore.getState().reset();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("restores the viewport chosen for the session in the URL", () => {
    usePreviewStore.getState().restoreViewport("session-a");
    usePreviewStore.getState().setDevicePreset(findPresetById("ipad-mini"));
    usePreviewStore.getState().toggleLandscape();

    // A reload leaves only localStorage behind.
    usePreviewStore.getState().reset();
    expect(usePreviewStore.getState().devicePreset).toBeNull();

    mount("session-a");

    expect(usePreviewStore.getState().devicePreset?.id).toBe("ipad-mini");
    expect(usePreviewStore.getState().isLandscape).toBe(true);
    expect(usePreviewStore.getState().viewportSessionId).toBe("session-a");
  });

  it("starts on Responsive for a session that never chose one", () => {
    mount("session-never-seen");
    expect(usePreviewStore.getState().devicePreset).toBeNull();
    expect(usePreviewStore.getState().viewportSessionId).toBe("session-never-seen");
  });

  it("claims no session when the URL names none", () => {
    mount(undefined);
    expect(usePreviewStore.getState().viewportSessionId).toBeNull();
  });
});
