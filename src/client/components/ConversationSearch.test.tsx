import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ConversationSearch } from "./ConversationSearch.js";

afterEach(cleanup);

function composer(): HTMLTextAreaElement {
  const el = document.createElement("textarea");
  el.setAttribute("data-chat-input", "chat");
  document.body.appendChild(el);
  return el;
}

function renderSearch(focusKey: number, onClose = vi.fn()) {
  const props = {
    query: "needle",
    onQueryChange: vi.fn(),
    matches: [],
    currentMatchIndex: 0,
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onClose,
  };
  const view = render(<ConversationSearch focusKey={focusKey} {...props} />);
  return {
    onClose,
    rerenderWith: (next: number) =>
      view.rerender(<ConversationSearch focusKey={next} {...props} />),
    input: () => screen.getByPlaceholderText("Search messages...") as HTMLInputElement,
  };
}

describe("ConversationSearch", () => {
  it("re-focuses the bar when the hotkey fires again, keeping the query", () => {
    const chat = composer();
    const { rerenderWith, input } = renderSearch(1);
    expect(document.activeElement).toBe(input());

    // The user clicks back into the composer and presses the chord again.
    chat.focus();
    expect(document.activeElement).toBe(chat);
    rerenderWith(2);

    expect(document.activeElement).toBe(input());
    expect(input().value).toBe("needle");
    chat.remove();
  });

  it("does not steal focus back while the user types in the composer", () => {
    const chat = composer();
    const { rerenderWith } = renderSearch(1);
    chat.focus();

    rerenderWith(1);

    expect(document.activeElement).toBe(chat);
    chat.remove();
  });

  it("hands the cursor back to the composer on close, so the hotkey can reopen it", () => {
    const chat = composer();
    const { onClose, input } = renderSearch(1);

    fireEvent.keyDown(input(), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(chat);
    chat.remove();
  });

  it("closes without error when there is no composer to return to", () => {
    const { onClose, input } = renderSearch(1);

    fireEvent.keyDown(input(), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
