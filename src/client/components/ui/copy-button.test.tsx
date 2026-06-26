import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { CopyButton } from "./copy-button.js";

/**
 * Install a stub `navigator.clipboard.writeText` and return the spy. jsdom does
 * not provide a usable clipboard, so each test defines one fresh.
 */
function stubClipboard(impl: () => Promise<void> = () => Promise.resolve()) {
  const writeText = vi.fn(impl);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

// Flush the microtasks queued by the awaited clipboard write so the `copied`
// state update lands before we assert.
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("CopyButton", () => {
  it("renders the idle label and a Copy affordance", () => {
    stubClipboard();
    render(<CopyButton text="hello" />);
    const btn = screen.getByRole("button");
    expect(btn).toHaveTextContent("Copy");
    expect(btn).toHaveAttribute("aria-label", "Copy");
  });

  it("writes the text to the clipboard and shows the copied state on click", async () => {
    const writeText = stubClipboard();
    render(<CopyButton text="payload-123" />);

    fireEvent.click(screen.getByRole("button"));
    await flush();

    expect(writeText).toHaveBeenCalledWith("payload-123");
    expect(screen.getByText("Copied")).toBeInTheDocument();
  });

  it("computes the text lazily when passed a function", async () => {
    const writeText = stubClipboard();
    let counter = 0;
    render(<CopyButton text={() => `v${(counter += 1)}`} />);

    fireEvent.click(screen.getByRole("button"));
    await flush();

    // Called at click time (not render time), so the counter has incremented.
    expect(writeText).toHaveBeenCalledWith("v1");
  });

  it("reverts to the idle label after the timeout elapses", async () => {
    vi.useFakeTimers();
    stubClipboard();
    render(<CopyButton text="hello" timeout={1500} />);

    fireEvent.click(screen.getByRole("button"));
    // Flush the clipboard write microtask without the real event loop.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Copied")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByText("Copy")).toBeInTheDocument();
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
  });

  it("swallows a clipboard rejection without crashing", async () => {
    stubClipboard(() => Promise.reject(new Error("denied")));
    render(<CopyButton text="hello" />);

    fireEvent.click(screen.getByRole("button"));
    await flush();

    // Stayed in the idle state; no throw bubbled out.
    expect(screen.getByText("Copy")).toBeInTheDocument();
  });
});
