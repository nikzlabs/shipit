import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ContextDial } from "./ContextDial.js";
import type { TurnUsage } from "../../server/shared/types.js";

afterEach(() => {
  cleanup();
});

const window200k = { model: "claude-sonnet-4-20250514", contextWindowTokens: 200_000 };

function makeTurn(inputTokens: number, overrides: Partial<TurnUsage> = {}): TurnUsage {
  return {
    inputTokens,
    outputTokens: Math.round(inputTokens * 0.05),
    costUsd: inputTokens * 0.00001,
    model: "claude-sonnet-4-20250514",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("ContextDial", () => {
  it("returns null when modelInfo is null", () => {
    const { container } = render(<ContextDial modelInfo={null} turnUsage={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("does not throw a hook-order error when modelInfo flips from null to set", () => {
    // Regression: `topTurns` useMemo used to live *after* the
    // `if (!modelInfo) return null` guard, so a re-render that populated
    // modelInfo rendered one more hook than the previous pass → React #310.
    const { rerender, container } = render(
      <ContextDial modelInfo={null} turnUsage={[makeTurn(10_000)]} />,
    );
    expect(container.firstChild).toBeNull();
    rerender(<ContextDial modelInfo={window200k} turnUsage={[makeTurn(10_000)]} />);
    expect(screen.getByTestId("context-dial")).toBeInTheDocument();
  });

  it("renders the dial with green level for low usage", () => {
    render(
      <ContextDial
        modelInfo={window200k}
        turnUsage={[makeTurn(20_000)]}
      />,
    );
    const dial = screen.getByTestId("context-dial");
    expect(dial).toBeInTheDocument();
    expect(dial.getAttribute("data-level")).toBe("green");
  });

  it("transitions to yellow at 60% usage", () => {
    render(
      <ContextDial
        modelInfo={window200k}
        turnUsage={[makeTurn(120_000)]}
      />,
    );
    expect(screen.getByTestId("context-dial").getAttribute("data-level")).toBe("yellow");
  });

  it("transitions to orange at 80% usage", () => {
    render(
      <ContextDial
        modelInfo={window200k}
        turnUsage={[makeTurn(170_000)]}
      />,
    );
    expect(screen.getByTestId("context-dial").getAttribute("data-level")).toBe("orange");
  });

  it("transitions to red at 90% usage", () => {
    render(
      <ContextDial
        modelInfo={window200k}
        turnUsage={[makeTurn(190_000)]}
      />,
    );
    expect(screen.getByTestId("context-dial").getAttribute("data-level")).toBe("red");
  });

  it("clamps the dial at 100% even when context exceeds the window", () => {
    render(
      <ContextDial
        modelInfo={window200k}
        turnUsage={[makeTurn(250_000)]}
      />,
    );
    // Dial still renders, level red
    expect(screen.getByTestId("context-dial").getAttribute("data-level")).toBe("red");
  });

  it("opens the popover when clicked and shows the per-turn breakdown", () => {
    render(
      <ContextDial
        modelInfo={window200k}
        turnUsage={[makeTurn(10_000), makeTurn(50_000), makeTurn(80_000)]}
      />,
    );
    fireEvent.click(screen.getByTestId("context-dial"));
    expect(screen.getByTestId("context-dial-popover")).toBeInTheDocument();
    expect(screen.getByTestId("context-dial-sparkline")).toBeInTheDocument();
  });

  it("shows the compact hint when context is high but not compacted", () => {
    render(
      <ContextDial
        modelInfo={window200k}
        turnUsage={[makeTurn(180_000)]}
      />,
    );
    fireEvent.click(screen.getByTestId("context-dial"));
    expect(screen.getByTestId("compact-hint")).toBeInTheDocument();
  });

  it("shows the 'context compacted' pill after a sharp input-token drop", () => {
    // Two turns: first ~150K, second ~30K — a /compact-style drop.
    render(
      <ContextDial
        modelInfo={window200k}
        turnUsage={[makeTurn(150_000), makeTurn(30_000)]}
      />,
    );
    fireEvent.click(screen.getByTestId("context-dial"));
    expect(screen.getByTestId("context-compacted-pill")).toBeInTheDocument();
  });

  it("does NOT show the compacted pill for normal turn-to-turn variance", () => {
    render(
      <ContextDial
        modelInfo={window200k}
        turnUsage={[makeTurn(50_000), makeTurn(45_000)]}
      />,
    );
    fireEvent.click(screen.getByTestId("context-dial"));
    expect(screen.queryByTestId("context-compacted-pill")).toBeNull();
  });
});
