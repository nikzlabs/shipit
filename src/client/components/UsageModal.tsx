import { useLayoutEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.js";
import type {
  SessionInfo, SessionUsage, SubscriptionLimitsMap, TurnUsage, UsageGroup, UsageStats,
  UsageTotals, WeeklyUsage,
} from "../../server/shared/types.js";
import { compareSessionsBySpend, sessionRunningFigure, sessionUsageTokens } from "../../server/shared/types/usage-types.js";
import { subscriptionWindowIsCurrent } from "../../server/shared/types/usage-limits-types.js";
import { formatTokenCount, getContextLevel, type ModelInfo } from "../utils/model-info.js";
import { formatModelName } from "../utils/format-model.js";
import { RUNNING_FIGURE_TITLE, formatCost, formatEstimate, turnCostDisplay } from "../utils/format-cost.js";
import { billingModeLabel, serviceLabel } from "../utils/service-label.js";

interface UsageModalProps {
  currentSessionUsage: SessionUsage | null;
  allUsage: UsageStats | null;
  sessions: SessionInfo[];
  onClose: () => void;
  modelInfo?: ModelInfo | null;
  contextTokens?: number;
  /**
   * Per-turn breakdown sourced from `UsageManager.getPerTurnUsage()` —
   * authoritative across reloads, no longer derived from cumulative deltas.
   */
  turnUsage?: TurnUsage[];
  /**
   * docs/252 req 10 — the live quota snapshot, keyed by `${serviceId}:${mode}`.
   * A `sub` group joins its own entry to show a quota bar; a `key` group has no
   * quota to report and renders no indicator at all, rather than an empty one.
   */
  subscriptionLimits?: SubscriptionLimitsMap;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `2026-06-01` → `Jun 1`, for compact x-axis labels. Parsed from the string
 * parts rather than `new Date(...)` so a westward local timezone can't shift the
 * label back a day.
 */
function formatWeek(week: string): string {
  const [, mon, day] = week.split("-");
  const name = MONTH_NAMES[Number(mon) - 1] ?? mon;
  return `${name} ${Number(day)}`;
}

/** `2026-06-01` → `Jun 1 – Jun 7`, the full Mon–Sun span, for hover tooltips. */
function formatWeekRange(week: string): string {
  const end = new Date(`${week}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  return `${formatWeek(week)} – ${formatWeek(end.toISOString().slice(0, 10))}`;
}

/**
 * docs/252 req 16 — three series on a toggle, never stacked. Two segments in
 * one bar carrying two different units invites reading them as parts of a
 * whole, which they are not. Volume is **tokens**, not turns: a turn is not a
 * fixed quantity of anything, and it is not the unit price or quota is computed
 * in.
 *
 * The split still tells its story across the toggle — a week where Paid rises
 * and At API rates falls is a week work moved *off* the plans, which Tokens
 * confirms.
 */
type WeeklyMetric = "paid" | "atApiRates" | "tokens";

const WEEKLY_METRICS: { key: WeeklyMetric; label: string }[] = [
  // "Metered", not "Paid". A `key` row's figure is the harness's own only when
  // the turn ran on that harness's native service AND it reported one; every
  // other metered turn is priced from four unit rates, which cannot express
  // per-request, image or tiered-cache charges (`catalogue.md`, *Pricing*).
  // Labelling that "Paid" asserts a fact about a bank statement.
  { key: "paid", label: "Metered" },
  { key: "atApiRates", label: "At API rates" },
  { key: "tokens", label: "Tokens" },
];

function weeklyValue(metric: WeeklyMetric, w: WeeklyUsage): number {
  if (metric === "paid") return w.costUsd;
  if (metric === "atApiRates") return w.atApiRatesUsd;
  return w.tokens;
}

/** Compact metric label for the bar labels, hover tooltip and average line. */
function formatWeeklyValue(metric: WeeklyMetric, value: number): string {
  if (metric === "paid") return formatCost(value);
  if (metric === "atApiRates") return formatEstimate(value);
  return formatTokenCount(value);
}

/** Minimum column width that keeps both a `$12.34` value and a `Apr 13` x-axis
 *  label legible (below this the axis labels start truncating). */
const MIN_BAR_PX = 44;
const DEFAULT_WEEKS = 12;
const MIN_WEEKS = 6;
const MAX_WEEKS = 20;

/**
 * How many weekly bars fit in the chart's measured width. Returns
 * `DEFAULT_WEEKS` until measured (and wherever `ResizeObserver` is unavailable,
 * e.g. jsdom), so the chart renders ~12 weeks by default and widens only when
 * the dialog actually has the room.
 */
function useVisibleWeeks(ref: React.RefObject<HTMLElement | null>): number {
  const [weeks, setWeeks] = useState(DEFAULT_WEEKS);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const w = el.clientWidth;
      // Ignore a zero width (detached / display:none) so we don't collapse to
      // the minimum before the dialog has real dimensions.
      if (w <= 0) return;
      setWeeks(Math.max(MIN_WEEKS, Math.min(MAX_WEEKS, Math.floor(w / MIN_BAR_PX))));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [ref]);

  return weeks;
}

/**
 * Per-week bar chart for the all-sessions trend. Pure CSS/Tailwind (no charting
 * lib, matching the ContextDial sparkline), toggles between cost and turns,
 * scaled to the largest bar in the series. Windowed to as many recent weeks as
 * fit the chart's width (~12 at the dialog's default size) so the x-axis stays
 * readable; draws an average baseline and emphasizes the most recent week.
 */
function WeeklyUsageChart({ weekly }: { weekly: WeeklyUsage[] }) {
  const [metric, setMetric] = useState<WeeklyMetric>("paid");
  const chartRef = useRef<HTMLDivElement>(null);
  const visibleWeeks = useVisibleWeeks(chartRef);

  // Keep the x-axis bounded — only the latest weeks that fit are charted.
  const recent = weekly.slice(-visibleWeeks);
  const value = (w: WeeklyUsage) => weeklyValue(metric, w);
  const max = recent.reduce((hi, w) => Math.max(hi, value(w)), 0);
  const total = recent.reduce((sum, w) => sum + value(w), 0);
  const avg = recent.length > 0 ? total / recent.length : 0;
  // Cap bar height below 100% so the persistent value label above the tallest
  // bar still fits inside the chart area. The avg baseline uses the same scale.
  const BAR_SCALE = 82;
  const avgPct = max > 0 ? (avg / max) * BAR_SCALE : 0;
  const fmt = (w: WeeklyUsage) => formatWeeklyValue(metric, value(w));
  const avgLabel = formatWeeklyValue(metric, avg);
  const totalLabel = formatWeeklyValue(metric, total);

  return (
    <section data-testid="weekly-usage-section">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <h3 className="text-sm font-medium text-(--color-text-secondary)">Weekly trend</h3>
          <span
            className="text-xs text-(--color-text-secondary) truncate"
            data-testid="weekly-usage-window"
          >
            last {recent.length} {recent.length === 1 ? "week" : "weeks"} · {totalLabel}
          </span>
        </div>
        <div className="flex gap-1 text-xs">
          {WEEKLY_METRICS.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMetric(m.key)}
              className={`px-2 py-0.5 rounded transition-colors ${
                metric === m.key
                  ? "bg-(--color-bg-tertiary) text-(--color-text-primary)"
                  : "text-(--color-text-secondary) hover:text-(--color-text-primary)"
              }`}
              data-testid={`weekly-metric-${m.key}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      {/* Bars and labels are separate rows with matching flex-1 columns so the
          percentage-height bars resolve against a definite-height ancestor. */}
      <div
        ref={chartRef}
        className="relative flex items-end gap-1 h-32"
        data-testid="weekly-usage-chart"
      >
        {recent.map((w, i) => {
          const h = max > 0 ? Math.max(2, (value(w) / max) * BAR_SCALE) : 2;
          const isCurrent = i === recent.length - 1;
          return (
            <div
              key={w.week}
              className="group relative flex-1 h-full flex flex-col justify-end min-w-0"
            >
              {/* Persistent per-week value label, sits directly above the bar. */}
              <span
                className={`pointer-events-none mb-0.5 text-center text-[9px] leading-tight tabular-nums truncate ${
                  isCurrent ? "text-(--color-text-primary) font-medium" : "text-(--color-text-secondary)"
                }`}
                data-testid="weekly-usage-bar-label"
              >
                {fmt(w)}
              </span>
              <div
                className={`w-full rounded-sm bg-(--color-accent) transition-all group-hover:opacity-80 ${
                  isCurrent ? "" : "opacity-55"
                }`}
                style={{ height: `${h}%` }}
                title={`${formatWeekRange(w.week)}: ${fmt(w)}`}
              />
            </div>
          );
        })}
        {/* Average baseline across the bars. */}
        {avg > 0 && (
          <div
            className="pointer-events-none absolute left-0 right-0 flex items-center"
            style={{ bottom: `${avgPct}%` }}
            data-testid="weekly-usage-avg"
          >
            <span className="mr-1 rounded bg-(--color-bg-secondary) px-1 text-[9px] leading-tight text-(--color-text-secondary)">
              avg {avgLabel}
            </span>
            <div className="flex-1 border-t border-dashed border-(--color-text-secondary) opacity-60" />
          </div>
        )}
      </div>
      <div className="flex gap-1 mt-1">
        {recent.map((w, i) => {
          const isCurrent = i === recent.length - 1;
          return (
            <span
              key={w.week}
              className={`flex-1 text-[10px] truncate text-center ${
                isCurrent ? "text-(--color-text-primary) font-medium" : "text-(--color-text-secondary)"
              }`}
            >
              {formatWeek(w.week)}
            </span>
          );
        })}
      </div>
    </section>
  );
}

function formatDuration(ms: number): string {
  if (ms === 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

const levelBarColors: Record<string, string> = {
  green: "bg-(--color-success)",
  yellow: "bg-(--color-warning)",
  orange: "bg-(--color-context-high)",
  red: "bg-(--color-error)",
};

/** Shared column template for the per-turn breakdown's header and rows. */
const TURN_ROW_COLS = "grid grid-cols-[2.5rem_1fr_1fr_1fr_1fr] gap-2";

/** Label/value row — the modal's standard stat line. */
function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-(--color-text-secondary)">{label}</span>
      <span className="text-(--color-text-primary) tabular-nums" data-testid={testId}>{value}</span>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-medium text-(--color-text-secondary) mb-2">{children}</h3>;
}

/**
 * docs/252 req 16 — the two headline figures, never one.
 *
 * "Metered spend (est.)" is the only figure that is money, and `est.` is
 * load-bearing rather than hedging: it is computed from the catalogue's four
 * unit rates, which cannot express per-request, image or tiered-cache charges
 * (`catalogue.md`, *Pricing*). Calling it "You paid" would assert a fact about
 * a bank statement.
 *
 * Plan usage is counted in **tokens** with its API-rate value beneath — the
 * number that says whether a subscription is worth keeping. It is deliberately
 * not in the money slot, is prefixed `≈`, and is never summed into the metered
 * figure.
 *
 * A scope with nothing metered says "Nothing", not `$0.00`: a zero reads as
 * telemetry that came back empty, which is the wrong impression for what is the
 * normal case for a subscription user.
 */
function UsageHeadline({ totals, testId }: { totals: UsageTotals; testId: string }) {
  const hasIncluded = totals.includedTokens > 0 || totals.atApiRatesUsd > 0;
  return (
    <div className="flex gap-5 items-start" data-testid={testId}>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-(--color-text-secondary)">
          Metered spend (est.)
        </div>
        <div
          className="text-lg font-semibold tabular-nums text-(--color-text-primary)"
          data-testid={`${testId}-metered`}
          title={RUNNING_FIGURE_TITLE.metered}
        >
          {totals.meteredCostUsd > 0 ? formatCost(totals.meteredCostUsd) : "Nothing"}
        </div>
        {/* With nothing metered and nothing on a plan there is no contrast to
            draw, so the estimate rides here instead of opening a second column
            that would be the only thing on screen. */}
        {!hasIncluded && totals.legacyCostUsd > 0 && (
          <div className="text-[11px] text-(--color-text-secondary) tabular-nums">
            {formatCost(totals.legacyCostUsd)} earlier accounting
          </div>
        )}
      </div>
      {hasIncluded && (
        <>
          <div className="w-px self-stretch bg-(--color-border-primary)" />
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wide text-(--color-text-secondary)">
              Included in plans
            </div>
            <div
              className="text-lg font-semibold tabular-nums text-(--color-text-primary)"
              data-testid={`${testId}-included`}
            >
              {formatTokenCount(totals.includedTokens)} tokens
            </div>
            <div
              className="text-[11px] text-(--color-text-secondary) tabular-nums"
              data-testid={`${testId}-at-api-rates`}
              title={RUNNING_FIGURE_TITLE["at-api-rates"]}
            >
              {formatEstimate(totals.atApiRatesUsd)} at API rates
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Worst quota window this `(service, mode)` is reporting, or null when it
 * reports none.
 *
 * A window whose reset has passed is skipped: readings are event-fed, so one
 * can outlive its window by hours, and showing "97%" for a window that rolled
 * over reports a limit the user is not actually near. The header pill draws the
 * same line in `meterDisplay` (docs/161).
 */
function worstQuota(
  group: UsageGroup,
  limits: SubscriptionLimitsMap | undefined,
  now: number = Date.now(),
): { pct: number; label: string } | null {
  if (group.kind !== "sub" || !limits) return null;
  let worst: { pct: number; label: string } | null = null;
  for (const snapshot of Object.values(limits[group.key] ?? {})) {
    for (const [label, window] of [["5h window", snapshot.session], ["7d window", snapshot.weekly]] as const) {
      if (window?.usedPct === undefined || window.usedPct === null) continue;
      if (!subscriptionWindowIsCurrent(window, now)) continue;
      if (!worst || window.usedPct > worst.pct) worst = { pct: window.usedPct, label };
    }
  }
  return worst;
}

/**
 * One row of the split. A metered row shows a price and no quota bar; a plan
 * row shows a bar and no price — that is req 10's "no indicator at all" rule
 * and req 12's billing-mode branch showing up in a third place.
 *
 * The legacy row is colourless and unlabelled by mode on purpose: tinting it as
 * plan or metered would assert the very attribution the bucket exists to admit
 * is missing. Its name says what is missing rather than when the row was
 * written, because the bucket is no longer purely historical (req 16,
 * planning#343): work that resolves no model writes into it going forward.
 *
 * Those forward rows are recorded **unpriced** (`non-turn-work.ts`), so they add
 * volume and no money. A bucket holding nothing else therefore has no figure to
 * print, and prints "Unpriced" rather than a `$0.00` that would assert the work
 * was free. When it *does* carry money, "earlier accounting" is the honest label
 * for a dollar figure of unknown provenance — which is not a claim that every
 * such dollar is pre-feature: a sub-agent consult whose stored default predates
 * the triple also writes an unattributed row and keeps the harness's own figure
 * (`services/sub-agent.ts`). That is phase 3's shape, unchanged here.
 */
function UsageGroupRow({
  group,
  limits,
}: {
  group: UsageGroup;
  limits: SubscriptionLimitsMap | undefined;
}) {
  const quota = worstQuota(group, limits);
  const legacy = group.kind === "legacy";
  // `$0.00` here would assert the work was free — the one thing req 16 exists to
  // stop the totals saying. A legacy bucket holding only unpriced rows has no
  // dollar figure to show, so it says so instead of printing a zero.
  const unpriced = legacy && group.costUsd === 0;
  return (
    <div
      className={`flex items-start gap-3 text-sm py-1.5 border-b border-(--color-border-primary) last:border-0 ${
        legacy ? "opacity-75" : ""
      }`}
      data-testid="usage-group-row"
      data-group-key={group.key}
    >
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2 flex-wrap">
          <span className="text-(--color-text-primary)">
            {legacy ? "No service recorded" : serviceLabel(group.serviceId!)}
          </span>
          <span className="text-[10px] px-1.5 py-px rounded-full border border-(--color-border-primary) text-(--color-text-secondary)">
            {legacy ? "Unattributed" : billingModeLabel(group.billingMode!)}
          </span>
        </span>
        {group.models.length > 0 && (
          <span className="block text-xs text-(--color-text-secondary) truncate">
            {group.models.map(formatModelName).join(", ")}
          </span>
        )}
      </span>
      <span className="w-24 shrink-0 text-right text-xs text-(--color-text-secondary) tabular-nums pt-0.5">
        {formatTokenCount(group.tokens)} tokens
      </span>
      <span className="w-28 shrink-0 text-right tabular-nums">
        {group.kind === "sub" ? (
          <>
            <span className="text-(--color-text-primary) text-xs">Included</span>
            {quota && (
              <>
                <span className="block mt-1 h-1 rounded-full bg-(--color-bg-tertiary) overflow-hidden">
                  <span
                    className="block h-full bg-(--color-accent)"
                    style={{ width: `${Math.min(100, quota.pct)}%` }}
                    data-testid="usage-group-quota"
                  />
                </span>
                <span className="block text-[10px] text-(--color-text-secondary)">
                  {Math.round(quota.pct)}% of {quota.label}
                </span>
              </>
            )}
            <span
              className="block text-[10px] text-(--color-text-secondary) mt-1"
              title={RUNNING_FIGURE_TITLE["at-api-rates"]}
            >
              {formatEstimate(group.atApiRatesUsd)} at API rates
            </span>
          </>
        ) : (
          <>
            <span className="text-(--color-text-primary)">
              {unpriced ? "Unpriced" : formatCost(group.costUsd)}
            </span>
            <span className="block text-[10px] text-(--color-text-secondary)">
              {unpriced ? "no rates recorded" : legacy ? "earlier accounting" : "metered"}
            </span>
          </>
        )}
      </span>
    </div>
  );
}

/**
 * docs/252 req 16 — "Avg / turn", divided by the RIGHT turn count.
 *
 * The pre-split version divided one dollar total by every turn in the scope, so
 * a mixed session averaged its metered spend over subscription turns that
 * contributed nothing to it. Each figure now divides by the turns that
 * produced it, and a scope with only one kind of turn shows only that figure.
 */
function averagePerTurn(totals: UsageTotals): { metered?: number; atApiRates?: number } | null {
  const out: { metered?: number; atApiRates?: number } = {};
  if (totals.meteredTurns > 0 && totals.meteredCostUsd > 0) {
    out.metered = totals.meteredCostUsd / totals.meteredTurns;
  }
  if (totals.includedTurns > 0 && totals.atApiRatesUsd > 0) {
    out.atApiRates = totals.atApiRatesUsd / totals.includedTurns;
  }
  return out.metered === undefined && out.atApiRates === undefined ? null : out;
}

/** One or two "Avg / turn" lines — money and estimate never share a row. */
function AvgPerTurnStat({
  avg,
  testId,
}: {
  avg: { metered?: number; atApiRates?: number };
  testId: string;
}) {
  return (
    <>
      {avg.metered !== undefined && (
        <Stat label="Avg / metered turn" value={formatCost(avg.metered)} testId={testId} />
      )}
      {avg.atApiRates !== undefined && (
        <Stat
          label="Avg / plan turn"
          value={`${formatEstimate(avg.atApiRates)} at API rates`}
          testId={`${testId}-at-api-rates`}
        />
      )}
    </>
  );
}

function UsageSplitSection({
  heading,
  groups,
  limits,
  testId,
}: {
  heading: string;
  groups: UsageGroup[];
  limits: SubscriptionLimitsMap | undefined;
  testId: string;
}) {
  if (groups.length === 0) return null;
  return (
    <section data-testid={testId}>
      <SectionHeading>{heading}</SectionHeading>
      <div className="max-h-64 overflow-y-auto">
        {groups.map((g) => (
          <UsageGroupRow key={g.key} group={g} limits={limits} />
        ))}
      </div>
    </section>
  );
}

export function UsageModal({ currentSessionUsage, allUsage, sessions, onClose, modelInfo, contextTokens, turnUsage, subscriptionLimits }: UsageModalProps) {
  // Look up session titles by ID
  const getSessionTitle = (sessionId: string): string => {
    const session = sessions.find((s) => s.id === sessionId);
    return session?.title ?? `${sessionId.slice(0, 12)  }...`;
  };

  const contextPercentage = modelInfo && modelInfo.contextWindowTokens > 0 && contextTokens
    ? Math.min(100, (contextTokens / modelInfo.contextWindowTokens) * 100)
    : 0;
  const contextLevel = getContextLevel(contextPercentage);

  // Compute cumulative token totals from turn data
  const totalInputTokens = turnUsage?.reduce((sum, t) => sum + t.inputTokens, 0) ?? 0;
  const totalOutputTokens = turnUsage?.reduce((sum, t) => sum + t.outputTokens, 0) ?? 0;
  const totalCacheRead = turnUsage?.reduce((sum, t) => sum + (t.cacheRead ?? 0), 0) ?? 0;
  const totalCacheCreate = turnUsage?.reduce((sum, t) => sum + (t.cacheCreate ?? 0), 0) ?? 0;
  const hasTurnTokens = (turnUsage?.length ?? 0) > 0;

  const sessionAvg = currentSessionUsage ? averagePerTurn(currentSessionUsage.totals) : null;
  const allAvg = allUsage ? averagePerTurn(allUsage.totals) : null;
  // Costliest first — with room for a full list, ordering by spend is what makes
  // the breakdown answer "where did the money go?". The tiebreak is explicit
  // (docs/252 req 16): under the split most sessions are legitimately $0, so
  // spend alone would leave the tail in arbitrary order.
  const rankedSessions = allUsage ? [...allUsage.sessions].sort(compareSessionsBySpend) : [];

  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent
        className="rounded-lg border-(--color-border-secondary) max-w-3xl w-full mx-4 max-h-[85vh] overflow-y-auto"
        data-testid="usage-modal-backdrop"
      >
        {/* Header */}
        <div className="flex items-center px-5 py-4 border-b border-(--color-border-secondary)">
          <DialogTitle className="text-lg font-semibold">Usage Summary</DialogTitle>
        </div>

        {/* Body — two columns on desktop, single column on mobile. The trend
            chart spans both so its bars stay wide enough to label. */}
        <div className="px-5 py-4 grid md:grid-cols-2 gap-x-6 gap-y-5">
          {/* Current session */}
          <section>
            <SectionHeading>This session</SectionHeading>
            {currentSessionUsage ? (
              <div className="space-y-2 text-sm">
                <UsageHeadline totals={currentSessionUsage.totals} testId="usage-session-headline" />
                <div className="space-y-1">
                  {modelInfo && (
                    <Stat label="Model" value={formatModelName(modelInfo.model)} testId="usage-model-name" />
                  )}
                  {/* A turn count describes the SESSION; it is not the volume
                      measure any more (req 16), which is why it sits here and
                      not in the headline. */}
                  <Stat label="Turns" value={`${currentSessionUsage.turnCount}`} />
                  <Stat
                    label="Tokens"
                    value={formatTokenCount(sessionUsageTokens(currentSessionUsage))}
                    testId="usage-session-tokens"
                  />
                  <Stat label="Duration" value={formatDuration(currentSessionUsage.totalDurationMs)} />
                  {/* Only meaningful past the first turn — with one turn the
                      average is just the headline again. */}
                  {currentSessionUsage.turnCount > 1 && sessionAvg && (
                    <AvgPerTurnStat avg={sessionAvg} testId="usage-session-avg" />
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-(--color-text-secondary)">No usage data yet</p>
            )}
          </section>

          {/* All sessions */}
          <section>
            <SectionHeading>All sessions</SectionHeading>
            {allUsage && allUsage.totalTurns > 0 ? (
              <div className="space-y-2 text-sm">
                <UsageHeadline totals={allUsage.totals} testId="usage-all-headline" />
                <div className="space-y-1">
                  <Stat label="Turns" value={`${allUsage.totalTurns}`} />
                  <Stat label="Sessions" value={`${allUsage.sessions.length}`} testId="usage-session-count" />
                  {allUsage.totalTurns > 1 && allAvg && (
                    <AvgPerTurnStat avg={allAvg} testId="usage-all-avg" />
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-(--color-text-secondary)">No usage data yet</p>
            )}
          </section>

          {/* The split — one row per (service, billing mode), legacy last */}
          {currentSessionUsage?.groups && currentSessionUsage.groups.length > 0 && (
            <UsageSplitSection
              heading="This session — by service"
              groups={currentSessionUsage.groups}
              limits={subscriptionLimits}
              testId="usage-session-split"
            />
          )}
          {allUsage && allUsage.groups.length > 0 && (
            <UsageSplitSection
              heading="All sessions — by service"
              groups={allUsage.groups}
              limits={subscriptionLimits}
              testId="usage-all-split"
            />
          )}

          {/* Context usage */}
          {modelInfo && contextTokens !== undefined && contextTokens > 0 && (
            <section data-testid="context-usage-section">
              <SectionHeading>Context usage</SectionHeading>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-(--color-text-secondary)">Tokens used</span>
                  <span className="text-(--color-text-primary) tabular-nums">
                    {formatTokenCount(contextTokens)} / {formatTokenCount(modelInfo.contextWindowTokens)}
                  </span>
                </div>
                <div className="w-full h-2 bg-(--color-bg-tertiary) rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${levelBarColors[contextLevel]}`}
                    style={{ width: `${contextPercentage}%` }}
                    data-testid="context-usage-bar"
                  />
                </div>
                <div className="text-right text-(--color-text-secondary)">{Math.round(contextPercentage)}%</div>
              </div>
            </section>
          )}

          {/* Token totals */}
          {hasTurnTokens && (
            <section data-testid="token-totals-section">
              <SectionHeading>Token totals</SectionHeading>
              <div className="space-y-1 text-sm">
                <Stat label="Input" value={`${formatTokenCount(totalInputTokens)} tokens`} />
                <Stat label="Output" value={`${formatTokenCount(totalOutputTokens)} tokens`} />
                {totalCacheRead > 0 && (
                  <Stat label="Cache read" value={`${formatTokenCount(totalCacheRead)} tokens`} testId="usage-cache-read" />
                )}
                {totalCacheCreate > 0 && (
                  <Stat label="Cache write" value={`${formatTokenCount(totalCacheCreate)} tokens`} testId="usage-cache-create" />
                )}
              </div>
            </section>
          )}

          {/* Weekly trend chart — full width so the bars stay legible */}
          {allUsage && allUsage.weekly.length > 0 && (
            <div className="md:col-span-2">
              <WeeklyUsageChart weekly={allUsage.weekly} />
            </div>
          )}

          {/* Per-turn token breakdown */}
          {hasTurnTokens && turnUsage && turnUsage.length > 0 && (
            <section data-testid="turn-breakdown-section">
              <SectionHeading>Per-turn breakdown</SectionHeading>
              {/* Header + rows share one column template so the labels line up
                  with their values — with a header the rows no longer need to
                  spell out "In:" / "Out:" inline. */}
              <div className={`${TURN_ROW_COLS} text-[10px] uppercase tracking-wide text-(--color-text-secondary) pb-1 border-b border-(--color-border-primary)`}>
                <span>Turn</span>
                <span className="text-right">In</span>
                <span className="text-right">Out</span>
                {/* Not "Paid": a metered turn's figure is an estimate wherever
                    the harness did not report one. `≈` stays reserved for the
                    at-API-rates comparison — overloading it here would erase
                    the distinction the split rests on — so the qualifier lives
                    in the header instead. */}
                <span
                  className="text-right"
                  title="ShipIt's estimate of metered spend, or the at-API-rates value of a subscription turn"
                >
                  Cost (est.)
                </span>
                <span className="text-right">Time</span>
              </div>
              <div className="max-h-64 overflow-y-auto">
                {[...turnUsage].reverse().map((turn, i) => {
                  const turnNum = turnUsage.length - i;
                  // docs/252 req 16 — a subscription turn's `costUsd` is zero
                  // by rule, so the column shows its at-API-rates value rather
                  // than reporting the turn as free.
                  const cost = turnCostDisplay(turn);
                  return (
                    <div
                      key={i}
                      className={`${TURN_ROW_COLS} items-center text-xs py-1 border-b border-(--color-border-primary) last:border-0 font-mono tabular-nums`}
                      data-testid="turn-breakdown-row"
                    >
                      <span className="text-(--color-text-secondary)">#{turnNum}</span>
                      <span className="text-(--color-text-primary) text-right">{formatTokenCount(turn.inputTokens)}</span>
                      <span className="text-(--color-text-primary) text-right">{formatTokenCount(turn.outputTokens)}</span>
                      <span
                        className="text-(--color-text-secondary) text-right"
                        title={cost.estimated ? RUNNING_FIGURE_TITLE["at-api-rates"] : undefined}
                      >
                        {cost.text}
                      </span>
                      <span className="text-(--color-text-secondary) text-right">{formatDuration(turn.durationMs ?? 0)}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Per-session breakdown */}
          {rankedSessions.length > 0 && (
            <section data-testid="recent-sessions-section">
              <SectionHeading>Recent sessions</SectionHeading>
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {rankedSessions.map((s) => {
                  // req 16 — the same running figure the dial shows, so a
                  // session reads the same in both places.
                  const figure = sessionRunningFigure(s.totals);
                  return (
                    <div
                      key={s.sessionId}
                      className="flex items-center justify-between text-sm py-1 border-b border-(--color-border-primary) last:border-0"
                      data-testid="usage-session-row"
                    >
                      <span className="text-(--color-text-primary) truncate mr-3" title={s.sessionId}>
                        {getSessionTitle(s.sessionId)}
                      </span>
                      <span className="shrink-0 flex items-center gap-3 tabular-nums">
                        <span className="text-(--color-text-secondary) text-xs">
                          {formatTokenCount(sessionUsageTokens(s))} tokens
                        </span>
                        <span
                          className={figure?.kind === "metered" ? "text-(--color-text-primary)" : "text-(--color-text-secondary)"}
                          title={figure ? RUNNING_FIGURE_TITLE[figure.kind] : undefined}
                          data-figure-kind={figure?.kind}
                        >
                          {figure === null
                            ? "—"
                            : figure.kind === "at-api-rates"
                              ? formatEstimate(figure.usd)
                              : formatCost(figure.usd)}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
