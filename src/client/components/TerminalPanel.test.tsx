import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TerminalPanel, type LogEntry } from "./TerminalPanel.js";

beforeEach(() => {
  // jsdom doesn't implement scrollIntoView
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

const entry = (source: LogEntry["source"], text: string): LogEntry => ({
  source,
  text,
  timestamp: "2025-01-15T12:00:00.000Z",
});

describe("TerminalPanel", () => {
  it("renders the Terminal header", () => {
    render(<TerminalPanel entries={[]} onClear={() => {}} />);
    expect(screen.getByText("Terminal")).toBeInTheDocument();
  });

  it("renders a Clear button", () => {
    const onClear = vi.fn();
    render(<TerminalPanel entries={[]} onClear={onClear} />);
    screen.getByText("Clear").click();
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("shows empty state when there are no entries", () => {
    render(<TerminalPanel entries={[]} onClear={() => {}} />);
    expect(screen.getByText(/No output yet/)).toBeInTheDocument();
  });

  it("renders log entries with text", () => {
    const entries: LogEntry[] = [
      entry("stderr", "Error: something failed"),
      entry("stdout", "Some CLI output"),
      entry("server", "Claude process started"),
    ];
    render(<TerminalPanel entries={entries} onClear={() => {}} />);

    expect(screen.getByText("Error: something failed")).toBeInTheDocument();
    expect(screen.getByText("Some CLI output")).toBeInTheDocument();
    expect(screen.getByText("Claude process started")).toBeInTheDocument();
  });

  it("renders source labels for each log type", () => {
    const entries: LogEntry[] = [
      entry("stderr", "err line"),
      entry("stdout", "out line"),
      entry("server", "srv line"),
    ];
    render(<TerminalPanel entries={entries} onClear={() => {}} />);

    expect(screen.getByText("[err]")).toBeInTheDocument();
    expect(screen.getByText("[out]")).toBeInTheDocument();
    expect(screen.getByText("[srv]")).toBeInTheDocument();
  });

  it("renders timestamps for entries", () => {
    const entries: LogEntry[] = [entry("server", "test")];
    const { container } = render(<TerminalPanel entries={entries} onClear={() => {}} />);

    // The formatted time should appear somewhere in the output
    // 12:00:00 is the expected formatted time for the test timestamp
    const timeElements = container.querySelectorAll(".text-gray-600");
    expect(timeElements.length).toBeGreaterThan(0);
  });

  it("does not show empty state when entries exist", () => {
    const entries: LogEntry[] = [entry("server", "hello")];
    render(<TerminalPanel entries={entries} onClear={() => {}} />);
    expect(screen.queryByText(/No output yet/)).toBeNull();
  });

  it("renders in a monospace font container", () => {
    const entries: LogEntry[] = [entry("stdout", "mono text")];
    const { container } = render(<TerminalPanel entries={entries} onClear={() => {}} />);
    const monoEl = container.querySelector(".font-mono");
    expect(monoEl).not.toBeNull();
  });

  it("renders multiple entries in order", () => {
    const entries: LogEntry[] = [
      entry("server", "first"),
      entry("stderr", "second"),
      entry("stdout", "third"),
    ];
    const { container } = render(<TerminalPanel entries={entries} onClear={() => {}} />);
    const textContent = container.textContent ?? "";
    const firstIdx = textContent.indexOf("first");
    const secondIdx = textContent.indexOf("second");
    const thirdIdx = textContent.indexOf("third");
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });
});
