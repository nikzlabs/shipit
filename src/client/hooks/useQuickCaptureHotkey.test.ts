import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { isValidQuickCaptureHotkey, useQuickCaptureHotkey } from "./useQuickCaptureHotkey.js";

afterEach(cleanup);

describe("useQuickCaptureHotkey", () => {
  it("validates hotkeys with a key plus Ctrl/Cmd and a second modifier", () => {
    expect(isValidQuickCaptureHotkey("mod+alt+n")).toBe(true);
    expect(isValidQuickCaptureHotkey("ctrl+shift+k")).toBe(true);
    expect(isValidQuickCaptureHotkey("n")).toBe(false);
    expect(isValidQuickCaptureHotkey("ctrl+n")).toBe(false);
  });

  it("opens quick capture for the configured hotkey", () => {
    const onOpen = vi.fn();
    renderHook(() => useQuickCaptureHotkey("mod+alt+n", onOpen));

    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "n",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
    }));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("removes the listener on unmount", () => {
    const onOpen = vi.fn();
    const { unmount } = renderHook(() => useQuickCaptureHotkey("mod+alt+n", onOpen));
    unmount();

    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "n",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
    }));

    expect(onOpen).not.toHaveBeenCalled();
  });
});
