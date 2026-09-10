import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ContextDial } from "./ContextDial.js";
import type { TurnUsage, UsageTotals } from "../../server/shared/types.js";

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

  it("counts cache reads + writes toward context occupancy (not just inputTokens)", () => {
    render(
      <ContextDial
        modelInfo={window200k}
        turnUsage={[makeTurn(4, { cacheRead: 120_000, cacheCreate: 50_000 })]}
      />,
    );
    const dial = screen.getByTestId("context-dial");
    expect(dial.getAttribute("data-level")).toBe("orange");
  });

  it("prefers explicit contextTokens over the cache-sum for tool-heavy turns", () => {
    render(
      <ContextDial
        modelInfo={window200k}
        turnUsage={[
          makeTurn(30, {
            cacheRead: 540_000,
            cacheCreate: 36_000,
            contextTokens: 50_000,
          }),
        ]}
      />,
    );
    const dial = screen.getByTestId("context-dial");
    expect(dial.getAttribute("data-level")).toBe("green");
  });
});

describe("ContextDial — the running figure (docs/252 req 16)", () => {
  const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({
    meteredCostUsd: 0, meteredTurns: 0, meteredTokens: 0,
    atApiRatesUsd: 0, includedTurns: 0, includedTokens: 0,
    legacyCostUsd: 0, legacyTurns: 0, legacyTokens: 0,
    ...over,
  });

  it("shows the estimate, marked with ≈, when nothing was billed", () => {
    render(
      <ContextDial
        modelInfo={window200k}
        turnUsage={[makeTurn(10_000)]}
        sessionTotals={totals({ atApiRatesUsd: 2.1, includedTurns: 9 })}
      />,
    );
    const figure = screen.getByTestId("context-dial-cost");
    expect(figure).toHaveTextContent("≈$2.10");
    expect(figure).toHaveAttribute("data-figure-kind", "at-api-rates");
    expect(figure.getAttribute("title")).toMatch(/subscription/i);
  });

  it("shows money unprefixed when money moved", () => {
    render(
      <ContextDial
        modelInfo={window200k}
        turnUsage={[makeTurn(10_000)]}
        sessionTotals={totals({ meteredCostUsd: 0.42, meteredTurns: 4, atApiRatesUsd: 6.9 })}
      />,
    );
    const figure = screen.getByTestId("context-dial-cost");
    expect(figure).toHaveTextContent("$0.42");
    expect(figure.textContent).not.toContain("≈");
    expect(figure).toHaveAttribute("data-figure-kind", "metered");
  });

  it("does not let a stray metered consult eclipse the plan work on the trigger", () => {
    render(
      <ContextDial
        modelInfo={window200k}
        turnUsage={[makeTurn(10_000)]}
        sessionTotals={totals({
          meteredCostUsd: 0.004, meteredTurns: 1, meteredTokens: 12_000,
          atApiRatesUsd: 131.58, includedTurns: 39, includedTokens: 208_600_000,
        })}
      />,
    );
    const figure = screen.getByTestId("context-dial-cost");
    expect(figure).toHaveTextContent("≈$131.58");
    expect(figure).toHaveAttribute("data-figure-kind", "at-api-rates");
    fireEvent.click(screen.getByTestId("context-dial"));
    expect(screen.getByTestId("context-dial-cost-metered")).toHaveTextContent("$0.004");
  });

  it("breaks the parts out in the popover and never sums them", () => {
    render(
      <ContextDial
        modelInfo={window200k}
        turnUsage={[makeTurn(10_000)]}
        sessionTotals={totals({ meteredCostUsd: 0.42, atApiRatesUsd: 6.9, legacyCostUsd: 1.5 })}
      />,
    );
    fireEvent.click(screen.getByTestId("context-dial"));
    expect(screen.getByTestId("context-dial-cost-metered")).toHaveTextContent("$0.42");
    expect(screen.getByTestId("context-dial-cost-at-api-rates")).toHaveTextContent("≈$6.90");
    expect(screen.getByTestId("context-dial-cost-earlier")).toHaveTextContent("$1.50");
    expect(screen.queryByText(/8\.82/)).toBeNull();
  });

  it("prices a subscription turn at API rates in the largest-turns list", () => {
    render(
      <ContextDial
        modelInfo={window200k}
        turnUsage={[makeTurn(10_000, { billingMode: "sub", costUsd: 0, atApiRatesUsd: 0.03 })]}
        sessionTotals={totals({ atApiRatesUsd: 0.03 })}
      />,
    );
    fireEvent.click(screen.getByTestId("context-dial"));
    expect(screen.getAllByText("≈$0.03").length).toBeGreaterThanOrEqual(2);
  });

  it("splits the pre-rehydration fallback too, so a plan session never flashes $0", () => {
    render(
      <ContextDial
        modelInfo={window200k}
        turnUsage={[makeTurn(10_000, { billingMode: "sub", costUsd: 0, atApiRatesUsd: 1.25 })]}
      />,
    );
    expect(screen.getByTestId("context-dial-cost")).toHaveTextContent("≈$1.25");
  });
});
