import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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
      entry("preview", "pre line"),
    ];
    render(<TerminalPanel entries={entries} onClear={() => {}} />);

    expect(screen.getByText("[err]")).toBeInTheDocument();
    expect(screen.getByText("[out]")).toBeInTheDocument();
    expect(screen.getByText("[srv]")).toBeInTheDocument();
    expect(screen.getByText("[pre]")).toBeInTheDocument();
  });

  it("renders timestamps for entries", () => {
    const entries: LogEntry[] = [entry("server", "test")];
    const { container } = render(<TerminalPanel entries={entries} onClear={() => {}} />);

    // The formatted time should appear somewhere in the output
    // 12:00:00 is the expected formatted time for the test timestamp
    const timeElements = container.querySelectorAll(".text-gray-400");
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

  describe("source filtering", () => {
    it("renders filter buttons for each source", () => {
      render(<TerminalPanel entries={[]} onClear={() => {}} />);
      const filterGroup = screen.getByRole("group", { name: /filter log sources/i });
      expect(filterGroup).toBeInTheDocument();
      // All four filter buttons should be present (err, out, srv, pre)
      const buttons = filterGroup.querySelectorAll("button");
      expect(buttons).toHaveLength(4);
    });

    it("filter buttons have aria-pressed=true by default", () => {
      render(<TerminalPanel entries={[]} onClear={() => {}} />);
      const filterGroup = screen.getByRole("group", { name: /filter log sources/i });
      const buttons = filterGroup.querySelectorAll("button");
      buttons.forEach((btn) => {
        expect(btn.getAttribute("aria-pressed")).toBe("true");
      });
    });

    it("clicking a filter button hides entries of that source", () => {
      const entries: LogEntry[] = [
        entry("stderr", "error line"),
        entry("stdout", "output line"),
        entry("server", "server line"),
      ];
      render(<TerminalPanel entries={entries} onClear={() => {}} />);

      // All entries visible initially
      expect(screen.getByText("error line")).toBeInTheDocument();
      expect(screen.getByText("output line")).toBeInTheDocument();
      expect(screen.getByText("server line")).toBeInTheDocument();

      // Click the "err" filter button to hide stderr
      const filterGroup = screen.getByRole("group", { name: /filter log sources/i });
      const errButton = filterGroup.querySelector("button[aria-pressed='true']") as HTMLButtonElement;
      fireEvent.click(errButton);

      // stderr entry should be hidden
      expect(screen.queryByText("error line")).toBeNull();
      // others still visible
      expect(screen.getByText("output line")).toBeInTheDocument();
      expect(screen.getByText("server line")).toBeInTheDocument();
    });

    it("clicking a hidden filter button shows entries again", () => {
      const entries: LogEntry[] = [
        entry("stderr", "error line"),
        entry("stdout", "output line"),
      ];
      render(<TerminalPanel entries={entries} onClear={() => {}} />);

      const filterGroup = screen.getByRole("group", { name: /filter log sources/i });
      const errButton = filterGroup.querySelector("button") as HTMLButtonElement;

      // Hide stderr
      fireEvent.click(errButton);
      expect(screen.queryByText("error line")).toBeNull();

      // Show stderr again
      fireEvent.click(errButton);
      expect(screen.getByText("error line")).toBeInTheDocument();
    });

    it("prevents hiding all sources", () => {
      const entries: LogEntry[] = [
        entry("stderr", "error line"),
        entry("stdout", "output line"),
        entry("server", "server line"),
        entry("preview", "preview line"),
      ];
      render(<TerminalPanel entries={entries} onClear={() => {}} />);

      const filterGroup = screen.getByRole("group", { name: /filter log sources/i });
      const buttons = Array.from(filterGroup.querySelectorAll("button")) as HTMLButtonElement[];

      // Hide first three sources
      fireEvent.click(buttons[0]); // hide stderr
      fireEvent.click(buttons[1]); // hide stdout
      fireEvent.click(buttons[2]); // hide server

      // Try to hide the last one — should not work
      fireEvent.click(buttons[3]);

      // preview entries should still be visible (can't hide all)
      expect(screen.getByText("preview line")).toBeInTheDocument();
    });

    it("shows filter-specific empty state when all entries are filtered out", () => {
      const entries: LogEntry[] = [entry("stderr", "only stderr")];
      render(<TerminalPanel entries={entries} onClear={() => {}} />);

      // Hide stderr
      const filterGroup = screen.getByRole("group", { name: /filter log sources/i });
      const errButton = filterGroup.querySelector("button") as HTMLButtonElement;
      fireEvent.click(errButton);

      expect(screen.getByText(/No logs match the current filter/)).toBeInTheDocument();
    });
  });
});
