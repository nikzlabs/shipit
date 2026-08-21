import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsageModal } from "./UsageModal.js";
import type { ModelInfo } from "../utils/model-info.js";
import type {
  SessionInfo, SessionUsage, TurnUsage, UsageStats, UsageTotals,
} from "../../server/shared/types.js";
import { EMPTY_USAGE_TOTALS } from "../../server/shared/types/usage-types.js";

afterEach(cleanup);

/**
 * docs/252 req 16 — a scope's figures are the split, not one total. These
 * fixtures are METERED sessions unless a case says otherwise, so the
 * pre-existing assertions still describe money that left the account.
 */
function totals(over: Partial<UsageTotals> = {}): UsageTotals {
  return { ...EMPTY_USAGE_TOTALS, ...over };
}
const metered = (usd: number, turns: number, tokens = turns * 1000): UsageTotals =>
  totals({ meteredCostUsd: usd, meteredTurns: turns, meteredTokens: tokens });

const mockSessions: SessionInfo[] = [
  { id: "sess-1", title: "Build landing page", createdAt: "2026-01-01", lastUsedAt: "2026-01-02", remoteUrl: "" },
  { id: "sess-2", title: "Fix API routes", createdAt: "2026-01-03", lastUsedAt: "2026-01-04", remoteUrl: "" },
];

const mockCurrentUsage: SessionUsage = {
  sessionId: "sess-1",
  totalDurationMs: 192000, // 3m 12s
  turnCount: 7,
  totals: metered(0.42, 7),
};

const mockAllUsage: UsageStats = {
  sessions: [
    { sessionId: "sess-1", totalDurationMs: 192000, turnCount: 7, totals: metered(0.42, 7) },
    { sessionId: "sess-2", totalDurationMs: 300000, turnCount: 12, totals: metered(0.93, 12) },
  ],
  totals: metered(1.35, 19),
  groups: [],
  totalTurns: 19,
  // Values deliberately distinct from the session/total figures above so the
  // chart's hover tooltips and avg label don't collide with exact-text queries.
  // 2026-06-01 / -08 / -15 are consecutive Mondays.
  weekly: [
    { week: "2026-06-01", costUsd: 0.15, atApiRatesUsd: 1.15, tokens: 2000 },
    { week: "2026-06-08", costUsd: 0.55, atApiRatesUsd: 2.55, tokens: 4000 },
    { week: "2026-06-15", costUsd: 0.65, atApiRatesUsd: 3.65, tokens: 5000 },
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

  it("switches the persistent bar labels to token counts when toggled", async () => {
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
    await user.click(within(section).getByTestId("weekly-metric-tokens"));
    const labels = screen.getAllByTestId("weekly-usage-bar-label");
    expect(labels.map((l) => l.textContent)).toEqual(["2.0K", "4.0K", "5.0K"]);
  });

  it("toggles the weekly chart across paid, at-API-rates and tokens (docs/252 req 16)", async () => {
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
    // Metered mode (default): the most-recent bar's tooltip shows the Mon–Sun
    // span and the formatted cost.
    expect(chart.querySelector('[title="Jun 15 – Jun 21: $0.65"]')).not.toBeNull();
    const section = screen.getByTestId("weekly-usage-section");
    // The estimate is prefixed `≈` so it can never read as money spent.
    await user.click(within(section).getByTestId("weekly-metric-atApiRates"));
    expect(chart.querySelector('[title="Jun 15 – Jun 21: ≈$3.65"]')).not.toBeNull();
    // Volume is tokens, not turns (req 16).
    await user.click(within(section).getByTestId("weekly-metric-tokens"));
    expect(chart.querySelector('[title="Jun 15 – Jun 21: 5.0K"]')).not.toBeNull();
  });

  it("windows the weekly chart to the most recent 12 weeks by default", () => {
    // 20 consecutive Mondays starting 2026-01-05. Without a ResizeObserver
    // (jsdom) the chart falls back to its 12-week default window.
    const many: UsageStats = {
      sessions: [],
      totals: metered(10, 100),
      groups: [],
      totalTurns: 100,
      weekly: Array.from({ length: 20 }, (_, i) => ({
        week: new Date(Date.parse("2026-01-05T00:00:00Z") + i * 7 * 86400000)
          .toISOString()
          .slice(0, 10),
        costUsd: i + 1,
        atApiRatesUsd: i + 1,
        tokens: (i + 1) * 1000,
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
        { sessionId: "unknown-session-id-long", totalDurationMs: 1000, turnCount: 1, totals: metered(0.10, 1) },
      ],
      totals: metered(0.10, 1),
      groups: [],
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
      totalDurationMs: 0,
      turnCount: 0,
      totals: totals(),
    };
    render(
      <UsageModal
        currentSessionUsage={zeroUsage}
        allUsage={{ sessions: [], totals: totals(), groups: [], totalTurns: 0, weekly: [] }}
        sessions={mockSessions}
        onClose={() => {}}
      />
    );
    // req 16 — "Nothing", not `$0.00`: a zero reads as telemetry that came back
    // empty, which is the wrong impression for a session that spent nothing.
    expect(screen.getByText("Nothing")).toBeInTheDocument();
    expect(screen.getByText("0s")).toBeInTheDocument();
  });

  it("formats sub-cent amounts with three decimal places", () => {
    const subCentUsage: SessionUsage = {
      sessionId: "sess-1",
      totalDurationMs: 1000,
      turnCount: 1,
      totals: metered(0.005, 1),
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

/**
 * docs/252 req 16 — the split, and the wording that keeps it honest. These
 * cases are about which figure appears where, not about layout.
 */
describe("UsageModal — the usage split (docs/252 req 16)", () => {
  const planGroup = {
    key: "anthropic:sub", kind: "sub" as const, serviceId: "anthropic", billingMode: "sub" as const,
    models: ["claude-opus-5"], turns: 9, tokens: 1_400_000, costUsd: 0, atApiRatesUsd: 5.4,
  };
  const meteredGroup = {
    key: "deepseek:key", kind: "key" as const, serviceId: "deepseek", billingMode: "key" as const,
    models: ["deepseek-v4-flash"], turns: 4, tokens: 310_000, costUsd: 0.11, atApiRatesUsd: 0.11,
  };
  const legacyGroup = {
    key: "legacy", kind: "legacy" as const,
    models: [], turns: 12, tokens: 71_500_000, costUsd: 31.7, atApiRatesUsd: 0,
  };

  const mixed: SessionUsage = {
    sessionId: "sess-1",
    totalDurationMs: 4320000,
    turnCount: 13,
    totals: totals({
      meteredCostUsd: 0.11, meteredTurns: 4, meteredTokens: 310_000,
      atApiRatesUsd: 5.4, includedTurns: 9, includedTokens: 1_400_000,
    }),
    groups: [planGroup, meteredGroup],
  };

  it("shows two headline figures and never adds them together", () => {
    render(
      <UsageModal currentSessionUsage={mixed} allUsage={null} sessions={mockSessions} onClose={() => {}} />
    );
    const headline = screen.getByTestId("usage-session-headline");
    // "Metered spend (est.)" — est. is load-bearing: the figure comes from four
    // unit rates, so calling it "You paid" would assert a bank statement.
    expect(within(headline).getByText("Metered spend (est.)")).toBeInTheDocument();
    expect(screen.getByTestId("usage-session-headline-metered")).toHaveTextContent("$0.11");
    // Plan usage is counted in TOKENS with its API-rate value beneath it.
    expect(screen.getByTestId("usage-session-headline-included")).toHaveTextContent("1.4M tokens");
    expect(screen.getByTestId("usage-session-headline-at-api-rates")).toHaveTextContent("≈$5.40 at API rates");
    // The sum $5.51 must appear nowhere.
    expect(screen.queryByText(/5\.51/)).toBeNull();
  });

  it("says 'Nothing' rather than $0.00 for a subscription-only session", () => {
    render(
      <UsageModal
        currentSessionUsage={{ ...mixed, totals: totals({ atApiRatesUsd: 2.1, includedTurns: 9, includedTokens: 480_000 }) }}
        allUsage={null}
        sessions={mockSessions}
        onClose={() => {}}
      />
    );
    expect(screen.getByTestId("usage-session-headline-metered")).toHaveTextContent("Nothing");
    expect(screen.getByTestId("usage-session-headline-at-api-rates")).toHaveTextContent("≈$2.10");
  });

  it("gives a plan row a quota bar and a metered row a price, never both", () => {
    render(
      <UsageModal
        currentSessionUsage={mixed}
        allUsage={null}
        sessions={mockSessions}
        onClose={() => {}}
        subscriptionLimits={{
          "anthropic:sub": {
            "acct-a": {
              serviceId: "anthropic", billingMode: "sub", routeId: "acct-a", plan: "Max",
              session: { usedPct: 62, resetAt: "2030-01-01T00:00:00Z" },
              weekly: null, fetchedAt: Date.now(),
            },
          },
        }}
      />
    );
    const rows = screen.getAllByTestId("usage-group-row");
    const plan = rows.find((r) => r.dataset.groupKey === "anthropic:sub")!;
    const metered = rows.find((r) => r.dataset.groupKey === "deepseek:key")!;
    expect(within(plan).getByText("Included")).toBeInTheDocument();
    expect(within(plan).getByTestId("usage-group-quota")).toHaveStyle({ width: "62%" });
    expect(within(plan).getByText(/62% of 5h window/)).toBeInTheDocument();
    expect(within(plan).getByText("≈$5.40 at API rates")).toBeInTheDocument();
    // req 10 — a metered mode has no allowance, so it renders no indicator at all.
    expect(within(metered).queryByTestId("usage-group-quota")).toBeNull();
    expect(within(metered).getByText("$0.11")).toBeInTheDocument();
    expect(within(metered).getByText("metered")).toBeInTheDocument();
  });

  // planning#343 — the name says what is missing, not when the row was written:
  // the bucket now takes forward-generated unattributed volume too. The money
  // label stays "earlier accounting" because those forward rows are unpriced.
  it("names the legacy group for its missing attribution, never for a mode", () => {
    render(
      <UsageModal
        currentSessionUsage={{ ...mixed, groups: [...mixed.groups!, legacyGroup] }}
        allUsage={null}
        sessions={mockSessions}
        onClose={() => {}}
      />
    );
    const legacy = screen.getAllByTestId("usage-group-row")
      .find((r) => r.dataset.groupKey === "legacy")!;
    expect(within(legacy).getByText("No service recorded")).toBeInTheDocument();
    expect(within(legacy).getByText("Unattributed")).toBeInTheDocument();
    expect(within(legacy).getByText("earlier accounting")).toBeInTheDocument();
    expect(within(legacy).getByText("$31.70")).toBeInTheDocument();
    // Its total joins neither headline.
    expect(screen.getByTestId("usage-session-headline-metered")).toHaveTextContent("$0.11");
  });

  // planning#343 — the forward rows are unpriced, so a bucket holding only them
  // has no dollar figure. `formatCost(0)` would print "$0.00", which asserts the
  // work was free: the one thing req 16 exists to stop the totals saying.
  it("says a legacy group carrying only unpriced volume has no figure", () => {
    render(
      <UsageModal
        currentSessionUsage={{
          ...mixed,
          groups: [...mixed.groups!, { ...legacyGroup, costUsd: 0, tokens: 12_400, turns: 1 }],
        }}
        allUsage={null}
        sessions={mockSessions}
        onClose={() => {}}
      />
    );
    const legacy = screen.getAllByTestId("usage-group-row")
      .find((r) => r.dataset.groupKey === "legacy")!;
    expect(within(legacy).getByText("Unpriced")).toBeInTheDocument();
    expect(within(legacy).getByText("no rates recorded")).toBeInTheDocument();
    expect(within(legacy).queryByText("$0.00")).toBeNull();
    // The volume is still reported — that is the whole point of the row.
    expect(within(legacy).getByText(/12\.4K tokens|12,400 tokens/)).toBeInTheDocument();
  });

  it("averages each figure over the turns that produced it", () => {
    // The pre-split version divided metered spend by EVERY turn, including the
    // subscription turns that contributed nothing to it.
    render(
      <UsageModal currentSessionUsage={mixed} allUsage={null} sessions={mockSessions} onClose={() => {}} />
    );
    expect(screen.getByTestId("usage-session-avg")).toHaveTextContent("$0.03"); // 0.11 / 4
    expect(screen.getByTestId("usage-session-avg-at-api-rates")).toHaveTextContent("≈$0.60"); // 5.4 / 9
  });

  it("shows a subscription turn's at-API-rates value in the per-turn column", () => {
    const turns: TurnUsage[] = [
      { inputTokens: 100, outputTokens: 10, costUsd: 0, timestamp: "2026-08-09T00:00:00Z", billingMode: "sub", atApiRatesUsd: 0.02 },
      { inputTokens: 100, outputTokens: 10, costUsd: 0.05, timestamp: "2026-08-09T00:01:00Z", billingMode: "key" },
    ];
    render(
      <UsageModal
        currentSessionUsage={mixed}
        allUsage={null}
        sessions={mockSessions}
        onClose={() => {}}
        turnUsage={turns}
      />
    );
    const rows = screen.getAllByTestId("turn-breakdown-row");
    // Newest first — the metered turn, then the subscription one, which reads
    // as an estimate rather than as "this turn was free".
    expect(rows[0]).toHaveTextContent("$0.05");
    expect(rows[1]).toHaveTextContent("≈$0.02");
    // `≈` stays reserved for the comparison — a metered turn is qualified by the
    // column header ("Cost (est.)") rather than by borrowing that marker.
    expect(rows[0].textContent).not.toContain("≈");
    expect(screen.getByText("Cost (est.)")).toBeInTheDocument();
  });

  it("ranks $0 subscription sessions by their estimate instead of arbitrarily", () => {
    render(
      <UsageModal
        currentSessionUsage={null}
        allUsage={{
          sessions: [
            { sessionId: "sess-1", totalDurationMs: 0, turnCount: 3, totals: totals({ atApiRatesUsd: 1, includedTokens: 100 }) },
            { sessionId: "sess-2", totalDurationMs: 0, turnCount: 3, totals: totals({ atApiRatesUsd: 9, includedTokens: 900 }) },
          ],
          totals: totals({ atApiRatesUsd: 10, includedTokens: 1000 }),
          groups: [],
          totalTurns: 6,
          weekly: [],
        }}
        sessions={mockSessions}
        onClose={() => {}}
      />
    );
    const rows = screen.getAllByTestId("usage-session-row");
    expect(rows[0]).toHaveTextContent("Fix API routes"); // sess-2, the larger estimate
    expect(rows[0]).toHaveTextContent("≈$9.00");
    expect(rows[1]).toHaveTextContent("Build landing page");
  });
});
