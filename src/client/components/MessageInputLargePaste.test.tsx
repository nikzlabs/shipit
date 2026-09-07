/**
 * docs/292-paste-large-text-as-file — a paste of 2,000 characters or more is
 * attached as an uploaded text file instead of being inserted into the composer.
 *
 * The `overlay` surface is used throughout because it buffers attachments
 * locally instead of POSTing them, so these tests exercise the paste rule
 * without a fetch stub.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MessageInput } from "./MessageInput.js";
import { LARGE_PASTE_THRESHOLD_CHARS, PASTED_TEXT_FILENAME } from "./MessageInput/large-paste.js";

afterEach(cleanup);

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

/** Paste plain text into the composer's textarea. */
function pasteText(text: string) {
  const textarea = screen.getByRole("textbox");
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { items: [], getData: (type: string) => (type === "text/plain" ? text : "") },
  });
  fireEvent(textarea, event);
  return event;
}

describe("MessageInput — large paste becomes a file", () => {
  it("attaches a paste at the threshold as pasted-text.txt", () => {
    render(<MessageInput surface="overlay" onSend={vi.fn()} disabled={false} />);
    pasteText("x".repeat(LARGE_PASTE_THRESHOLD_CHARS));
    expect(screen.getByTestId("file-upload-chips")).toBeInTheDocument();
    expect(screen.getByTestId("upload-chip-name")).toHaveTextContent(PASTED_TEXT_FILENAME);
  });

  it("cancels the browser's own insert so the text does not also land in the input", () => {
    // jsdom never inserts pasted text, so an "input is empty" assertion would
    // pass with the feature removed. preventDefault is the observable that
    // actually distinguishes the two.
    render(<MessageInput surface="overlay" onSend={vi.fn()} disabled={false} />);
    const event = pasteText("x".repeat(LARGE_PASTE_THRESHOLD_CHARS));
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves a paste below the threshold to the input", () => {
    // docs/292 req 3.
    render(<MessageInput surface="overlay" onSend={vi.fn()} disabled={false} />);
    const event = pasteText("x".repeat(LARGE_PASTE_THRESHOLD_CHARS - 1));
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByTestId("file-upload-chips")).toBeNull();
  });

  it("does not convert a paste on a composer that cannot send", () => {
    // docs/257 req 3 — attaching to a dead input is the same dead input.
    render(
      <MessageInput
        surface="overlay"
        onSend={vi.fn()}
        disabled={false}
        disabledReason="Session is starting"
      />,
    );
    pasteText("x".repeat(LARGE_PASTE_THRESHOLD_CHARS));
    expect(screen.queryByTestId("file-upload-chips")).toBeNull();
  });

  it("attaches a pasted image rather than the text that came with it", () => {
    // A copy from a web page carries both text/html+text/plain and an image.
    // The image branch runs first and the text must not produce a second chip.
    render(<MessageInput surface="overlay" onSend={vi.fn()} disabled={false} />);
    const textarea = screen.getByRole("textbox");
    const png = new File(["x"], "shot.png", { type: "image/png" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: [{ type: "image/png", getAsFile: () => png }],
        getData: () => "x".repeat(LARGE_PASTE_THRESHOLD_CHARS),
      },
    });
    fireEvent(textarea, event);
    // The image lands as an image chip...
    expect(screen.getByAltText("shot.png")).toBeInTheDocument();
    // ...and the text that rode along with it produced no second, text chip.
    expect(screen.queryByTestId("upload-chip-name")).toBeNull();
  });
});
