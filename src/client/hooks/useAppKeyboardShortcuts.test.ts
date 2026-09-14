import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { useAppKeyboardShortcuts } from "./useAppKeyboardShortcuts.js";

afterEach(cleanup);

function render(openChatSearch: () => void) {
  return renderHook(() =>
    useAppKeyboardShortcuts({
      setShortcutsOpen: vi.fn(),
      handleNewSessionShortcut: vi.fn(),
      quickCaptureHotkey: "mod+alt+n",
      voiceInputEnabled: false,
      voiceHotkeyModeB: "ctrl+shift+m",
      openChatSearch,
    }),
  );
}

describe("useAppKeyboardShortcuts", () => {
  it("wires the declared chat-search chord to the search bar", () => {
    const openChatSearch = vi.fn();
    render(openChatSearch);
    const composer = document.createElement("textarea");
    composer.setAttribute("data-chat-input", "");
    document.body.appendChild(composer);

    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }),
    );

    expect(openChatSearch).toHaveBeenCalledTimes(1);
    composer.remove();
  });

  it("does not open chat search from outside the composer", () => {
    const openChatSearch = vi.fn();
    render(openChatSearch);

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }),
    );

    expect(openChatSearch).not.toHaveBeenCalled();
  });
});
