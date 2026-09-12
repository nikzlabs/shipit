import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TerminalPanel } from "./TerminalPanel.js";
import { useTerminalStore } from "../stores/terminal-store.js";

vi.mock("./LogView.js", () => ({
  LogView: ({ channel, showSource }: { channel: string; showSource?: boolean }) => (
    <div data-testid="log-view" data-channel={channel} data-show-source={String(!!showSource)} />
  ),
}));

vi.mock("./SessionHealthStrip.js", () => ({
  SessionHealthStrip: () => <div data-testid="health-strip" />,
}));

beforeEach(() => {
  useTerminalStore.getState().reset();
});

afterEach(cleanup);

const defaultProps = {
  onClear: () => {},
  terminalMode: "logs" as const,
  onTerminalModeChange: () => {},
  shellContent: null,
  send: () => {},
  sessionId: undefined,
  onReconnectWs: () => {},
};

describe("TerminalPanel", () => {
  it("renders the Logs/Shell sub-tab switcher", () => {
    render(<TerminalPanel {...defaultProps} />);
    expect(screen.getByRole("tab", { name: "Logs" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Shell" })).toBeInTheDocument();
  });

  it("mounts the agent LogView with showSource", () => {
    render(<TerminalPanel {...defaultProps} />);
    const view = screen.getByTestId("log-view");
    expect(view.getAttribute("data-channel")).toBe("agent");
    expect(view.getAttribute("data-show-source")).toBe("true");
  });

  it("renders a Clear button in logs mode and calls onClear", () => {
    const onClear = vi.fn();
    render(<TerminalPanel {...defaultProps} onClear={onClear} />);
    screen.getByText("Clear").click();
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("hides Clear button in shell mode", () => {
    render(<TerminalPanel {...defaultProps} terminalMode="shell" />);
    expect(screen.queryByText("Clear")).toBeNull();
  });

  describe("sub-tab switching", () => {
    it("calls onTerminalModeChange when Shell tab is clicked", () => {
      const onTerminalModeChange = vi.fn();
      render(<TerminalPanel {...defaultProps} onTerminalModeChange={onTerminalModeChange} />);
      fireEvent.click(screen.getByRole("tab", { name: "Shell" }));
      expect(onTerminalModeChange).toHaveBeenCalledWith("shell");
    });

    it("calls onTerminalModeChange when Logs tab is clicked", () => {
      const onTerminalModeChange = vi.fn();
      render(
        <TerminalPanel {...defaultProps} terminalMode="shell" onTerminalModeChange={onTerminalModeChange} />,
      );
      fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
      expect(onTerminalModeChange).toHaveBeenCalledWith("logs");
    });

    it("shows shell content when in shell mode", () => {
      render(
        <TerminalPanel
          {...defaultProps}
          terminalMode="shell"
          shellContent={<div data-testid="shell-content">Shell here</div>}
        />,
      );
      expect(screen.getByTestId("shell-content")).toBeInTheDocument();
    });
  });

  describe("both tabs stay mounted (xterm state preservation)", () => {
    it("keeps both the LogView and shell content mounted across mode switches", () => {
      const { rerender } = render(
        <TerminalPanel
          {...defaultProps}
          terminalMode="shell"
          shellContent={<div data-testid="shell-content">Shell here</div>}
        />,
      );

      expect(screen.getByTestId("shell-content")).toBeInTheDocument();
      expect(screen.getByTestId("log-view")).toBeInTheDocument();

      rerender(
        <TerminalPanel
          {...defaultProps}
          terminalMode="logs"
          shellContent={<div data-testid="shell-content">Shell here</div>}
        />,
      );
      expect(screen.getByTestId("shell-content")).toBeInTheDocument();
      expect(screen.getByTestId("log-view")).toBeInTheDocument();
    });
  });
});
