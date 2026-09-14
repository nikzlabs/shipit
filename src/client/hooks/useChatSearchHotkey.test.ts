import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { useChatSearchHotkey } from "./useChatSearchHotkey.js";

afterEach(cleanup);

function pressFindIn(el: Element, init: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

function chatInput(): HTMLTextAreaElement {
  const el = document.createElement("textarea");
  el.setAttribute("data-chat-input", "");
  document.body.appendChild(el);
  return el;
}

describe("useChatSearchHotkey", () => {
  it("opens chat search and takes the key from the browser when the composer is focused", () => {
    const onOpen = vi.fn();
    renderHook(() => useChatSearchHotkey(onOpen));
    const el = chatInput();

    const e = pressFindIn(el);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    el.remove();
  });

  it("opens for Cmd+F too, so the chord works on macOS", () => {
    const onOpen = vi.fn();
    renderHook(() => useChatSearchHotkey(onOpen));
    const el = chatInput();

    pressFindIn(el, { ctrlKey: false, metaKey: true });

    expect(onOpen).toHaveBeenCalledTimes(1);
    el.remove();
  });

  it("leaves the key to the browser's own Find outside the composer", () => {
    const onOpen = vi.fn();
    renderHook(() => useChatSearchHotkey(onOpen));
    const other = document.createElement("textarea");
    document.body.appendChild(other);

    const e = pressFindIn(other);

    expect(onOpen).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
    other.remove();
  });

  it("ignores other chords on the composer", () => {
    const onOpen = vi.fn();
    renderHook(() => useChatSearchHotkey(onOpen));
    const el = chatInput();

    pressFindIn(el, { shiftKey: true });
    pressFindIn(el, { ctrlKey: false });

    expect(onOpen).not.toHaveBeenCalled();
    el.remove();
  });

  it("removes the listener on unmount", () => {
    const onOpen = vi.fn();
    const { unmount } = renderHook(() => useChatSearchHotkey(onOpen));
    const el = chatInput();
    unmount();

    pressFindIn(el);

    expect(onOpen).not.toHaveBeenCalled();
    el.remove();
  });
});
