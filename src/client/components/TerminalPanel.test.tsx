import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TerminalPanel, type LogEntry } from "./TerminalPanel.js";

beforeEach(() => {
  // jsdom doesn't implement scrollIntoView
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

let nextId = 1;
const entry = (source: LogEntry["source"], text: string): LogEntry => ({
  id: nextId++,
  source,
  text,
  timestamp: "2025-01-15T12:00:00.000Z",
});

/** Default props for tests that don't care about the shell sub-tab. */
const defaultProps = {
  onClear: () => {},
  terminalMode: "logs" as const,
  onTerminalModeChange: () => {},
  shellContent: null,
};

describe("TerminalPanel", () => {
  it("renders the Logs/Shell sub-tab switcher", () => {
    render(<TerminalPanel entries={[]} {...defaultProps} />);
    expect(screen.getByRole("tab", { name: "Logs" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Shell" })).toBeInTheDocument();
  });

  it("renders a Clear button in logs mode", () => {
    const onClear = vi.fn();
    render(<TerminalPanel entries={[]} {...defaultProps} onClear={onClear} />);
    screen.getByText("Clear").click();
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("hides Clear button in shell mode", () => {
    render(<TerminalPanel entries={[]} {...defaultProps} terminalMode="shell" />);
    expect(screen.queryByText("Clear")).toBeNull();
  });

  it("shows empty state when there are no entries in logs mode", () => {
    render(<TerminalPanel entries={[]} {...defaultProps} />);
    expect(screen.getByText(/No output yet/)).toBeInTheDocument();
  });

  it("renders log entries with text", () => {
    const entries: LogEntry[] = [
      entry("stderr", "Error: something failed"),
      entry("stdout", "Some CLI output"),
      entry("server", "Claude process started"),
    ];
    render(<TerminalPanel entries={entries} {...defaultProps} />);

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
    render(<TerminalPanel entries={entries} {...defaultProps} />);

    expect(screen.getByText("[err]")).toBeInTheDocument();
    expect(screen.getByText("[out]")).toBeInTheDocument();
    expect(screen.getByText("[srv]")).toBeInTheDocument();
    expect(screen.getByText("[pre]")).toBeInTheDocument();
  });

  it("renders timestamps for entries", () => {
    const entries: LogEntry[] = [entry("server", "test")];
    const { container } = render(<TerminalPanel entries={entries} {...defaultProps} />);

    const timeElements = container.querySelectorAll(".text-gray-400");
    expect(timeElements.length).toBeGreaterThan(0);
  });

  it("does not show empty state when entries exist", () => {
    const entries: LogEntry[] = [entry("server", "hello")];
    render(<TerminalPanel entries={entries} {...defaultProps} />);
    expect(screen.queryByText(/No output yet/)).toBeNull();
  });

  it("renders in a monospace font container", () => {
    const entries: LogEntry[] = [entry("stdout", "mono text")];
    const { container } = render(<TerminalPanel entries={entries} {...defaultProps} />);
    const monoEl = container.querySelector(".font-mono");
    expect(monoEl).not.toBeNull();
  });

  it("renders multiple entries in order", () => {
    const entries: LogEntry[] = [
      entry("server", "first"),
      entry("stderr", "second"),
      entry("stdout", "third"),
    ];
    const { container } = render(<TerminalPanel entries={entries} {...defaultProps} />);
    const textContent = container.textContent ?? "";
    const firstIdx = textContent.indexOf("first");
    const secondIdx = textContent.indexOf("second");
    const thirdIdx = textContent.indexOf("third");
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });

  describe("sub-tab switching", () => {
    it("calls onTerminalModeChange when Shell tab is clicked", () => {
      const onTerminalModeChange = vi.fn();
      render(
        <TerminalPanel
          entries={[]}
          {...defaultProps}
          onTerminalModeChange={onTerminalModeChange}
        />,
      );

      fireEvent.click(screen.getByRole("tab", { name: "Shell" }));
      expect(onTerminalModeChange).toHaveBeenCalledWith("shell");
    });

    it("calls onTerminalModeChange when Logs tab is clicked", () => {
      const onTerminalModeChange = vi.fn();
      render(
        <TerminalPanel
          entries={[]}
          {...defaultProps}
          terminalMode="shell"
          onTerminalModeChange={onTerminalModeChange}
        />,
      );

      fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
      expect(onTerminalModeChange).toHaveBeenCalledWith("logs");
    });

    it("shows shell content when in shell mode", () => {
      render(
        <TerminalPanel
          entries={[]}
          {...defaultProps}
          terminalMode="shell"
          shellContent={<div data-testid="shell-content">Shell here</div>}
        />,
      );

      expect(screen.getByTestId("shell-content")).toBeInTheDocument();
    });

    it("hides log source filters in shell mode", () => {
      render(
        <TerminalPanel
          entries={[entry("stderr", "err")]}
          {...defaultProps}
          terminalMode="shell"
        />,
      );

      expect(screen.queryByRole("group", { name: /filter log sources/i })).toBeNull();
    });

    it("shows log source filters in logs mode", () => {
      render(
        <TerminalPanel
          entries={[entry("stderr", "err")]}
          {...defaultProps}
          terminalMode="logs"
        />,
      );

      expect(screen.getByRole("group", { name: /filter log sources/i })).toBeInTheDocument();
    });
  });

  describe("source filtering", () => {
    it("renders filter buttons for each source", () => {
      render(<TerminalPanel entries={[]} {...defaultProps} />);
      const filterGroup = screen.getByRole("group", { name: /filter log sources/i });
      expect(filterGroup).toBeInTheDocument();
      const buttons = filterGroup.querySelectorAll("button");
      expect(buttons).toHaveLength(6);
    });

    it("filter buttons have aria-pressed=true by default", () => {
      render(<TerminalPanel entries={[]} {...defaultProps} />);
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
      render(<TerminalPanel entries={entries} {...defaultProps} />);

      expect(screen.getByText("error line")).toBeInTheDocument();
      expect(screen.getByText("output line")).toBeInTheDocument();
      expect(screen.getByText("server line")).toBeInTheDocument();

      const filterGroup = screen.getByRole("group", { name: /filter log sources/i });
      const errButton = filterGroup.querySelector("button[aria-pressed='true']") as HTMLButtonElement;
      fireEvent.click(errButton);

      expect(screen.queryByText("error line")).toBeNull();
      expect(screen.getByText("output line")).toBeInTheDocument();
      expect(screen.getByText("server line")).toBeInTheDocument();
    });

    it("clicking a hidden filter button shows entries again", () => {
      const entries: LogEntry[] = [
        entry("stderr", "error line"),
        entry("stdout", "output line"),
      ];
      render(<TerminalPanel entries={entries} {...defaultProps} />);

      const filterGroup = screen.getByRole("group", { name: /filter log sources/i });
      const errButton = filterGroup.querySelector("button") as HTMLButtonElement;

      fireEvent.click(errButton);
      expect(screen.queryByText("error line")).toBeNull();

      fireEvent.click(errButton);
      expect(screen.getByText("error line")).toBeInTheDocument();
    });

    it("prevents hiding all sources", () => {
      const entries: LogEntry[] = [
        entry("stderr", "error line"),
        entry("stdout", "output line"),
        entry("server", "server line"),
        entry("preview", "preview line"),
        entry("deploy", "deploy line"),
        entry("install", "install line"),
      ];
      render(<TerminalPanel entries={entries} {...defaultProps} />);

      const filterGroup = screen.getByRole("group", { name: /filter log sources/i });
      const buttons = Array.from(filterGroup.querySelectorAll("button")) as HTMLButtonElement[];

      fireEvent.click(buttons[0]);
      fireEvent.click(buttons[1]);
      fireEvent.click(buttons[2]);
      fireEvent.click(buttons[3]);
      fireEvent.click(buttons[4]);

      fireEvent.click(buttons[5]);

      expect(screen.getByText("install line")).toBeInTheDocument();
    });

    it("shows filter-specific empty state when all entries are filtered out", () => {
      const entries: LogEntry[] = [entry("stderr", "only stderr")];
      render(<TerminalPanel entries={entries} {...defaultProps} />);

      const filterGroup = screen.getByRole("group", { name: /filter log sources/i });
      const errButton = filterGroup.querySelector("button") as HTMLButtonElement;
      fireEvent.click(errButton);

      expect(screen.getByText(/No logs match the current filter/)).toBeInTheDocument();
    });
  });

  describe("shell tab persistence", () => {
    it("keeps shell content mounted when switching to logs mode", () => {
      const { rerender } = render(
        <TerminalPanel
          entries={[]}
          {...defaultProps}
          terminalMode="shell"
          shellContent={<div data-testid="shell-content">Shell here</div>}
        />,
      );

      expect(screen.getByTestId("shell-content")).toBeInTheDocument();

      // Switch to logs — shell content should still be in the DOM (hidden)
      rerender(
        <TerminalPanel
          entries={[]}
          {...defaultProps}
          terminalMode="logs"
          shellContent={<div data-testid="shell-content">Shell here</div>}
        />,
      );

      expect(screen.getByTestId("shell-content")).toBeInTheDocument();
    });
  });

  describe("auto-scroll", () => {
    it("uses instant scroll behavior for new entries", () => {
      const entries = [entry("server", "line 1")];
      const { rerender } = render(<TerminalPanel entries={entries} {...defaultProps} />);

      const newEntries = [...entries, entry("server", "line 2")];
      rerender(<TerminalPanel entries={newEntries} {...defaultProps} />);

      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: "instant" });
    });
  });
});
