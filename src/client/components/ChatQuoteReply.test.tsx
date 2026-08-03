import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { useRef } from "react";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { ChatQuoteReply } from "./ChatQuoteReply.js";
import { MessageInput } from "./MessageInput.js";
import { useSessionStore } from "../stores/session-store.js";

const JSDOM_INNER_HEIGHT = window.innerHeight;

afterEach(() => {
  cleanup();
  // One placement test shrinks the viewport; put it back for the others.
  Object.defineProperty(window, "innerHeight", {
    writable: true,
    value: JSDOM_INNER_HEIGHT,
  });
});

/**
 * Stub matchMedia so `useIsMobile()` (in this component and in MessageInput)
 * resolves deterministically. Defaults to desktop; pass `true` to simulate the
 * narrow/touch layout.
 */
function mockMatchMedia(isMobile = false) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: isMobile,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

beforeEach(() => {
  mockMatchMedia();
  useSessionStore.setState({ quoteReplyText: undefined, prefillText: undefined });
});

/**
 * Fake a non-collapsed selection anchored at `node` returning `text`. The
 * component reads `window.getSelection()` in its selectionchange handler, so
 * spying on it lets us drive the whole flow without a real browser selection
 * (jsdom has no layout / live selection).
 */
function mockSelection(node: Node, text: string, rect?: Partial<DOMRect>) {
  const removeAllRanges = vi.fn();
  const range = {
    commonAncestorContainer: node,
    getBoundingClientRect: () =>
      ({
        top: 120, bottom: 140, left: 60, right: 260, width: 200, height: 20, x: 60, y: 120,
        toJSON: () => ({}),
        ...rect,
      }) as DOMRect,
  };
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => range as unknown as Range,
    removeAllRanges,
  } as unknown as Selection);
  return { removeAllRanges };
}

function fireSelectionChange() {
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

/** Message-list container holding a quotable passage + the floating button. */
function ListHarness() {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={ref} data-testid="msglist">
        <p>This is a quotable passage.</p>
      </div>
      <ChatQuoteReply containerRef={ref} />
    </div>
  );
}

/** Full flow: message list + the real composer, sharing the session store. */
function ChatHarness() {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={ref} data-testid="msglist">
        <p>This is a quotable passage.</p>
      </div>
      <ChatQuoteReply containerRef={ref} />
      <MessageInput onSend={vi.fn()} disabled={false} focusKey="s1" />
    </div>
  );
}

const PASSAGE = "This is a quotable passage.";

describe("ChatQuoteReply", () => {
  it("shows the Reply button when text inside the message list is selected", () => {
    render(<ListHarness />);
    expect(screen.queryByTestId("chat-quote-reply")).not.toBeInTheDocument();

    const passage = screen.getByText(PASSAGE);
    mockSelection(passage, PASSAGE);
    fireSelectionChange();

    expect(screen.getByTestId("chat-quote-reply")).toBeInTheDocument();
  });

  it("does NOT show the button for a selection outside the message list", () => {
    render(<ListHarness />);
    // Anchor the selection on a detached node — not contained by the list ref.
    const outside = document.createElement("div");
    outside.textContent = "composer text";
    mockSelection(outside, "composer text");
    fireSelectionChange();

    expect(screen.queryByTestId("chat-quote-reply")).not.toBeInTheDocument();
  });

  it("hides the button when the selection collapses", () => {
    render(<ListHarness />);
    const passage = screen.getByText(PASSAGE);
    mockSelection(passage, PASSAGE);
    fireSelectionChange();
    expect(screen.getByTestId("chat-quote-reply")).toBeInTheDocument();

    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: true,
      rangeCount: 0,
      toString: () => "",
      getRangeAt: () => { throw new Error("no range"); },
      removeAllRanges: vi.fn(),
    } as unknown as Selection);
    fireSelectionChange();

    expect(screen.queryByTestId("chat-quote-reply")).not.toBeInTheDocument();
  });

  it("sets the formatted blockquote on the store when Reply is clicked", () => {
    render(<ListHarness />);
    const passage = screen.getByText(PASSAGE);
    const { removeAllRanges } = mockSelection(passage, PASSAGE);
    fireSelectionChange();

    fireEvent.mouseDown(screen.getByTestId("chat-quote-reply"));

    expect(useSessionStore.getState().quoteReplyText).toBe(`> ${PASSAGE}`);
    // The native selection is cleared so the button disappears.
    expect(removeAllRanges).toHaveBeenCalled();
    expect(screen.queryByTestId("chat-quote-reply")).not.toBeInTheDocument();
  });

  it("inserts the blockquote into the composer draft on Reply", () => {
    render(<ChatHarness />);
    const passage = screen.getByText(PASSAGE);
    mockSelection(passage, PASSAGE);
    fireSelectionChange();

    fireEvent.mouseDown(screen.getByTestId("chat-quote-reply"));

    const textarea = screen.getByPlaceholderText(
      "Describe what to build... (type @ to attach files)",
    ) as HTMLTextAreaElement;
    // Blockquote followed by a blank line so the user can type their reply.
    expect(textarea.value).toBe(`> ${PASSAGE}\n\n`);
    // The relay field is cleared once consumed.
    expect(useSessionStore.getState().quoteReplyText).toBeUndefined();
  });

  // Placement. jsdom reports offsetWidth/offsetHeight as 0, so the button
  // measures as a zero-size box — the assertions below check which side of the
  // selection rect it lands on and that it stays inside the viewport, not exact
  // pixel offsets of a laid-out button.
  describe("placement", () => {
    it("places the button above the selection on desktop", () => {
      render(<ListHarness />);
      const passage = screen.getByText(PASSAGE);
      mockSelection(passage, PASSAGE, { top: 120, bottom: 140 });
      fireSelectionChange();

      // 120 (selection top) - 0 (button height) - 6 (margin)
      expect(screen.getByTestId("chat-quote-reply").style.top).toBe("114px");
    });

    it("places the button BELOW the selection on mobile, clear of the native selection callout", () => {
      mockMatchMedia(true);
      render(<ListHarness />);
      const passage = screen.getByText(PASSAGE);
      mockSelection(passage, PASSAGE, { top: 120, bottom: 140 });
      fireSelectionChange();

      // 140 (selection bottom) + 6 (margin) — the native Copy/Cut bar sits above.
      expect(screen.getByTestId("chat-quote-reply").style.top).toBe("146px");
    });

    it("keeps the button on screen for a selection at the bottom of the conversation", () => {
      mockMatchMedia(true);
      // Short viewport so a below-placement would otherwise run off-screen.
      Object.defineProperty(window, "innerHeight", { writable: true, value: 600 });
      render(<ListHarness />);
      const passage = screen.getByText(PASSAGE);
      mockSelection(passage, PASSAGE, { top: 570, bottom: 596 });
      fireSelectionChange();

      // Wanted 602; clamped to viewportH - buttonH - pad = 600 - 0 - 4.
      expect(screen.getByTestId("chat-quote-reply").style.top).toBe("596px");
    });
  });

  it("appends to existing draft text rather than replacing it", () => {
    render(<ChatHarness />);
    const textarea = screen.getByPlaceholderText(
      "Describe what to build... (type @ to attach files)",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "my thoughts" } });

    const passage = screen.getByText(PASSAGE);
    mockSelection(passage, PASSAGE);
    fireSelectionChange();
    fireEvent.mouseDown(screen.getByTestId("chat-quote-reply"));

    expect(textarea.value).toBe(`my thoughts\n\n> ${PASSAGE}\n\n`);
  });
});
