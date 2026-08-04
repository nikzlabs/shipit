import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsageModal, type SessionUsage, type UsageStats } from "./UsageModal.js";
import type { ModelInfo } from "../utils/model-info.js";
import type { SessionInfo, TurnUsage } from "../../server/shared/types.js";

afterEach(cleanup);

const mockSessions: SessionInfo[] = [
  { id: "sess-1", title: "Build landing page", createdAt: "2026-01-01", lastUsedAt: "2026-01-02", remoteUrl: "" },
  { id: "sess-2", title: "Fix API routes", createdAt: "2026-01-03", lastUsedAt: "2026-01-04", remoteUrl: "" },
];

const mockCurrentUsage: SessionUsage = {
  sessionId: "sess-1",
  totalCostUsd: 0.42,
  totalDurationMs: 192000, // 3m 12s
  turnCount: 7,
};

const mockAllUsage: UsageStats = {
  sessions: [
    { sessionId: "sess-1", totalCostUsd: 0.42, totalDurationMs: 192000, turnCount: 7 },
    { sessionId: "sess-2", totalCostUsd: 0.93, totalDurationMs: 300000, turnCount: 12 },
  ],
  totalCostUsd: 1.35,
  totalTurns: 19,
  // Values deliberately distinct from the session/total figures above so the
  // chart's hover tooltips and avg label don't collide with exact-text queries.
  // 2026-06-01 / -08 / -15 are consecutive Mondays.
  weekly: [
    { week: "2026-06-01", costUsd: 0.15, turns: 2 },
    { week: "2026-06-08", costUsd: 0.55, turns: 4 },
    { week: "2026-06-15", costUsd: 0.65, turns: 5 },
  ],
};

describe("UsageModal", () => {
  it("renders the dialog with correct role and aria-label", () => {
    render(
      <UsageModal
        currentSessionUsage={mockCurrentUsage}
        allUsage={mockAllUsage}
        sessions={mockSessions}
        onClose={() => {}}
      />
    );
    expect(screen.getByRole("dialog", { name: "Usage Summary" })).toBeInTheDocument();
  });

  it("renders the header title", () => {
    render(
      <UsageModal
        currentSessionUsage={mockCurrentUsage}
        allUsage={mockAllUsage}
        sessions={mockSessions}
        onClose={() => {}}
      />
    );
    expect(screen.getByText("Usage Summary")).toBeInTheDocument();
  });

  it("displays current session usage", () => {
    render(
      <UsageModal
        currentSessionUsage={mockCurrentUsage}
        allUsage={mockAllUsage}
        sessions={mockSessions}
        onClose={() => {}}
      />
    );
    expect(screen.getByText("This session")).toBeInTheDocument();
    // $0.42 appears in both "This session" and "Recent sessions" breakdown
    expect(screen.getAllByText("$0.42")).toHaveLength(2);
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("3m 12s")).toBeInTheDocument();
  });

  it("displays 'No usage data yet' when current session has no usage", () => {
    render(
      <UsageModal
        currentSessionUsage={null}
        allUsage={mockAllUsage}
        sessions={mockSessions}
        onClose={() => {}}
      />
    );
    expect(screen.getAllByText("No usage data yet")[0]).toBeInTheDocument();
  });

  it("displays all sessions aggregate", () => {
    render(
      <UsageModal
        currentSessionUsage={mockCurrentUsage}
        allUsage={mockAllUsage}
        sessions={mockSessions}
        onClose={() => {}}
      />
    );
    expect(screen.getByText("All sessions")).toBeInTheDocument();
    expect(screen.getByText("$1.35")).toBeInTheDocument();
    expect(screen.getByText("19")).toBeInTheDocument();
  });

  it("renders the weekly trend chart with a bar and label per week", () => {
    render(
      <UsageModal
        currentSessionUsage={mockCurrentUsage}
        allUsage={mockAllUsage}
        sessions={mockSessions}
        onClose={() => {}}
      />
    );
    expect(screen.getByText("Weekly trend")).toBeInTheDocument();
    const chart = screen.getByTestId("weekly-usage-chart");
    // One column per week + the average baseline overlay (last child).
    expect(chart.querySelectorAll("[title]")).toHaveLength(mockAllUsage.weekly.length);
    // X-axis labels are the week's Monday.
    expect(screen.getByText("Jun 1")).toBeInTheDocument();
    expect(screen.getByText("Jun 15")).toBeInTheDocument();
    expect(screen.getByTestId("weekly-usage-avg")).toBeInTheDocument();
  });

  it("shows a persistent cost label above each weekly bar", () => {
    render(
      <UsageModal
        currentSessionUsage={mockCurrentUsage}
        allUsage={mockAllUsage}
        sessions={mockSessions}
        onClose={() => {}}
      />
    );
    const labels = screen.getAllByTestId("weekly-usage-bar-label");
    expect(labels).toHaveLength(mockAllUsage.weekly.length);
    expect(labels.map((l) => l.textContent)).toEqual(["$0.15", "$0.55", "$0.65"]);
  });

  it("switches the persistent bar labels to turn counts when toggled", async () => {
    const user = userEvent.setup();
    render(
      <UsageModal
        currentSessionUsage={mockCurrentUsage}
        allUsage={mockAllUsage}
        sessions={mockSessions}
        onClose={() => {}}
      />
    );
    const section = screen.getByTestId("weekly-usage-section");
    await user.click(within(section).getByRole("button", { name: "turns" }));
    const labels = screen.getAllByTestId("weekly-usage-bar-label");
    expect(labels.map((l) => l.textContent)).toEqual(["2", "4", "5"]);
  });

  it("toggles the weekly chart between cost and turns", async () => {
    const user = userEvent.setup();
    render(
      <UsageModal
        currentSessionUsage={mockCurrentUsage}
        allUsage={mockAllUsage}
        sessions={mockSessions}
        onClose={() => {}}
      />
    );
    const chart = screen.getByTestId("weekly-usage-chart");
    // Cost mode (default): the most-recent bar's tooltip shows the Mon–Sun span
    // and the formatted cost.
    expect(chart.querySelector('[title="Jun 15 – Jun 21: $0.65"]')).not.toBeNull();
    // Within the chart section, click the Turns toggle.
    const section = screen.getByTestId("weekly-usage-section");
    await user.click(within(section).getByRole("button", { name: "turns" }));
    expect(chart.querySelector('[title="Jun 15 – Jun 21: 5"]')).not.toBeNull();
  });

  it("windows the weekly chart to the most recent 12 weeks by default", () => {
    // 20 consecutive Mondays starting 2026-01-05. Without a ResizeObserver
    // (jsdom) the chart falls back to its 12-week default window.
    const many: UsageStats = {
      sessions: [],
      totalCostUsd: 10,
      totalTurns: 100,
      weekly: Array.from({ length: 20 }, (_, i) => ({
        week: new Date(Date.parse("2026-01-05T00:00:00Z") + i * 7 * 86400000)
          .toISOString()
          .slice(0, 10),
        costUsd: i + 1,
        turns: i + 1,
      })),
    };
    render(
      <UsageModal currentSessionUsage={null} allUsage={many} sessions={[]} onClose={() => {}} />
    );
    const chart = screen.getByTestId("weekly-usage-chart");
    expect(chart.querySelectorAll("[title]")).toHaveLength(12);
    // The window keeps the NEWEST weeks: 2026-01-05 + 19 weeks = 2026-05-18.
    expect(screen.getByText("May 18")).toBeInTheDocument();
    expect(screen.getByTestId("weekly-usage-window")).toHaveTextContent("last 12 weeks");
  });

  it("shows average cost per turn for the session and across all sessions", () => {
    render(
      <UsageModal
        currentSessionUsage={mockCurrentUsage}
        allUsage={mockAllUsage}
        sessions={mockSessions}
        onClose={() => {}}
      />
    );
    // $0.42 / 7 turns, $1.35 / 19 turns.
    expect(screen.getByTestId("usage-session-avg")).toHaveTextContent("$0.06");
    expect(screen.getByTestId("usage-all-avg")).toHaveTextContent("$0.07");
    expect(screen.getByTestId("usage-session-count")).toHaveTextContent("2");
  });

  it("hides the per-turn average on a single-turn session", () => {
    render(
      <UsageModal
        currentSessionUsage={{ ...mockCurrentUsage, turnCount: 1 }}
        allUsage={null}
        sessions={mockSessions}
        onClose={() => {}}
      />
    );
    expect(screen.queryByTestId("usage-session-avg")).toBeNull();
  });

  it("orders the session breakdown by cost, highest first", () => {
    render(
      <UsageModal
        currentSessionUsage={mockCurrentUsage}
        allUsage={mockAllUsage}
        sessions={mockSessions}
        onClose={() => {}}
      />
    );
    const rows = within(screen.getByTestId("recent-sessions-section")).getAllByTitle(/sess-/);
    expect(rows.map((r) => r.textContent)).toEqual(["Fix API routes", "Build landing page"]);
  });

  it("shows cache token totals when turns carry them", () => {
    const turnUsage: TurnUsage[] = [
      { inputTokens: 5000, outputTokens: 1200, costUsd: 0.05, durationMs: 3000, timestamp: "2026-01-01T00:00:00Z", cacheRead: 40000, cacheCreate: 2000 },
    ];
    render(
      <UsageModal
        currentSessionUsage={mockCurrentUsage}
        allUsage={mockAllUsage}
        sessions={[]}
        onClose={vi.fn()}
        turnUsage={turnUsage}
      />
    );
    expect(screen.getByTestId("usage-cache-read")).toHaveTextContent("40.0K");
    expect(screen.getByTestId("usage-cache-create")).toHaveTextContent("2.0K");
  });

  it("displays per-session breakdown with titles", () => {
    render(
      <UsageModal
        currentSessionUsage={mockCurrentUsage}
        allUsage={mockAllUsage}
        sessions={mockSessions}
        onClose={() => {}}
      />
    );
    expect(screen.getByText("Recent sessions")).toBeInTheDocument();
    expect(screen.getByText("Build landing page")).toBeInTheDocument();
    expect(screen.getByText("Fix API routes")).toBeInTheDocument();
    expect(screen.getByText("$0.93")).toBeInTheDocument();
  });

  it("falls back to truncated session ID when session title is not found", () => {
    const usageWithUnknownSession: UsageStats = {
      sessions: [
        { sessionId: "unknown-session-id-long", totalCostUsd: 0.10, totalDurationMs: 1000, turnCount: 1 },
      ],
      totalCostUsd: 0.10,
      totalTurns: 1,
      weekly: [],
    };
    render(
      <UsageModal
        currentSessionUsage={null}
        allUsage={usageWithUnknownSession}
        sessions={[]}
        onClose={() => {}}
      />
    );
    expect(screen.getByText("unknown-sess...")).toBeInTheDocument();
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <UsageModal
        currentSessionUsage={mockCurrentUsage}
        allUsage={mockAllUsage}
        sessions={mockSessions}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when backdrop is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <UsageModal
        currentSessionUsage={mockCurrentUsage}
        allUsage={mockAllUsage}
        sessions={mockSessions}
        onClose={onClose}
      />
    );
    // Radix Dialog closes on Escape; use that instead of clicking the old aria-hidden backdrop
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not close when clicking inside the modal content", () => {
    const onClose = vi.fn();
    render(
      <UsageModal
        currentSessionUsage={mockCurrentUsage}
        allUsage={mockAllUsage}
        sessions={mockSessions}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByText("Usage Summary"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders zero usage gracefully", () => {
    const zeroUsage: SessionUsage = {
      sessionId: "sess-1",
      totalCostUsd: 0,
      totalDurationMs: 0,
      turnCount: 0,
    };
    render(
      <UsageModal
        currentSessionUsage={zeroUsage}
        allUsage={{ sessions: [], totalCostUsd: 0, totalTurns: 0, weekly: [] }}
        sessions={mockSessions}
        onClose={() => {}}
      />
    );
    expect(screen.getByText("$0.00")).toBeInTheDocument();
    expect(screen.getByText("0s")).toBeInTheDocument();
  });

  it("formats sub-cent amounts with three decimal places", () => {
    const subCentUsage: SessionUsage = {
      sessionId: "sess-1",
      totalCostUsd: 0.005,
      totalDurationMs: 1000,
      turnCount: 1,
    };
    render(
      <UsageModal
        currentSessionUsage={subCentUsage}
        allUsage={null}
        sessions={mockSessions}
        onClose={() => {}}
      />
    );
    expect(screen.getByText("$0.005")).toBeInTheDocument();
  });

  it("shows 'No usage data yet' for all sessions when allUsage is null", () => {
    render(
      <UsageModal
        currentSessionUsage={null}
        allUsage={null}
        sessions={[]}
        onClose={() => {}}
      />
    );
    const noDataTexts = screen.getAllByText("No usage data yet");
    expect(noDataTexts).toHaveLength(2);
  });

  it("shows model name when modelInfo is provided", () => {
    const modelInfo: ModelInfo = {
      model: "claude-sonnet-5",
      contextWindowTokens: 1_000_000,
    };

    render(
      <UsageModal
        currentSessionUsage={mockCurrentUsage}
        allUsage={mockAllUsage}
        sessions={[]}
        onClose={vi.fn()}
        modelInfo={modelInfo}
      />
    );

    expect(screen.getByTestId("usage-model-name")).toHaveTextContent("Sonnet 5");
  });

  it("shows context usage section when contextTokens > 0", () => {
    const modelInfo: ModelInfo = {
      model: "claude-sonnet-4-20250514",
      contextWindowTokens: 200000,
    };

    render(
      <UsageModal
        currentSessionUsage={mockCurrentUsage}
        allUsage={mockAllUsage}
        sessions={[]}
        onClose={vi.fn()}
        modelInfo={modelInfo}
        contextTokens={80000}
      />
    );

    expect(screen.getByTestId("context-usage-section")).toBeInTheDocument();
    expect(screen.getByTestId("context-usage-bar")).toBeInTheDocument();
  });

  it("hides context usage when no contextTokens", () => {
    render(
      <UsageModal
        currentSessionUsage={mockCurrentUsage}
        allUsage={mockAllUsage}
        sessions={[]}
        onClose={vi.fn()}
      />
    );

    expect(screen.queryByTestId("context-usage-section")).toBeNull();
  });

  it("shows per-turn token breakdown", () => {
    const turnUsage: TurnUsage[] = [
      { inputTokens: 5000, outputTokens: 1200, costUsd: 0.05, durationMs: 3000, timestamp: "2026-01-01T00:00:00Z" },
      { inputTokens: 8000, outputTokens: 2400, costUsd: 0.08, durationMs: 5000, timestamp: "2026-01-01T00:01:00Z" },
    ];

    render(
      <UsageModal
        currentSessionUsage={mockCurrentUsage}
        allUsage={mockAllUsage}
        sessions={[]}
        onClose={vi.fn()}
        turnUsage={turnUsage}
      />
    );

    expect(screen.getByTestId("turn-breakdown-section")).toBeInTheDocument();
  });

  it("shows token totals section", () => {
    const turnUsage: TurnUsage[] = [
      { inputTokens: 5000, outputTokens: 1200, costUsd: 0.05, durationMs: 3000, timestamp: "2026-01-01T00:00:00Z" },
      { inputTokens: 8000, outputTokens: 2400, costUsd: 0.08, durationMs: 5000, timestamp: "2026-01-01T00:01:00Z" },
    ];

    render(
      <UsageModal
        currentSessionUsage={mockCurrentUsage}
        allUsage={mockAllUsage}
        sessions={[]}
        onClose={vi.fn()}
        turnUsage={turnUsage}
      />
    );

    expect(screen.getByTestId("token-totals-section")).toBeInTheDocument();
  });

  it("hides per-turn breakdown when turnUsage is empty", () => {
    render(
      <UsageModal
        currentSessionUsage={mockCurrentUsage}
        allUsage={mockAllUsage}
        sessions={[]}
        onClose={vi.fn()}
        turnUsage={[]}
      />
    );

    expect(screen.queryByTestId("turn-breakdown-section")).toBeNull();
    expect(screen.queryByTestId("token-totals-section")).toBeNull();
  });

  it("shows basic session usage without model or token data", () => {
    render(
      <UsageModal
        currentSessionUsage={mockCurrentUsage}
        allUsage={mockAllUsage}
        sessions={[]}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("This session")).toBeInTheDocument();
    // Cost may appear multiple times (session + per-session breakdown)
    expect(screen.getAllByText("$0.42").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("3m 12s")).toBeInTheDocument();
  });
});
