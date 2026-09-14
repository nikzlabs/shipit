import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, renderHook, cleanup, screen } from "@testing-library/react";
import { MessageList } from "./MessageList.js";
import { useChatSearchHotkey } from "../../hooks/useChatSearchHotkey.js";
import type { ChatMessage } from "./types.js";

/**
 * `useChatSearchHotkey` tests the chord against a synthetic transcript, so it
 * cannot see the marker or the `tabIndex` leaving the real component. This
 * runs the real hook against the real `MessageList`.
 */
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

const messages: ChatMessage[] = [{ role: "user", text: "needle in the transcript" }];

describe("MessageList — the transcript is an entry point for chat search", () => {
  it("carries the marker the chat-search chord matches", () => {
    const onOpen = vi.fn();
    renderHook(() => useChatSearchHotkey(onOpen));
    render(<MessageList messages={messages} isLoading={false} />);

    const bubble = screen.getByText("needle in the transcript");
    const e = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
    bubble.dispatchEvent(e);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("is focusable by click but stays out of the tab order", () => {
    const { container } = render(<MessageList messages={messages} isLoading={false} />);
    const scroller = container.querySelector<HTMLElement>("[data-chat-transcript]");

    expect(scroller).not.toBeNull();
    // Without this a click on message text leaves focus on `<body>`, where the
    // chord cannot tell the transcript from any other panel. -1 rather than 0:
    // the click is the way in, and the tab order is unchanged.
    expect(scroller?.tabIndex).toBe(-1);
    scroller?.focus();
    expect(document.activeElement).toBe(scroller);
  });
});
