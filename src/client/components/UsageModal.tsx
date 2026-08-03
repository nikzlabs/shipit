import { useLayoutEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.js";
import type { SessionInfo, TurnUsage } from "../../server/shared/types.js";
import { formatTokenCount, getContextLevel, type ModelInfo } from "../utils/model-info.js";
import { formatModelName } from "../utils/format-model.js";

export interface SessionUsage {
  sessionId: string;
  totalCostUsd: number;
  totalDurationMs: number;
  turnCount: number;
}

export interface WeeklyUsage {
  week: string;
  costUsd: number;
  turns: number;
}

export interface UsageStats {
  sessions: SessionUsage[];
  totalCostUsd: number;
  totalTurns: number;
  weekly: WeeklyUsage[];
}

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
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
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

type WeeklyMetric = "cost" | "turns";

/** Compact metric label for the hover tooltip / average line. */
function formatWeeklyValue(metric: WeeklyMetric, costUsd: number, turns: number): string {
  return metric === "cost" ? formatCost(costUsd) : `${turns}`;
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
  const [metric, setMetric] = useState<WeeklyMetric>("cost");
  const chartRef = useRef<HTMLDivElement>(null);
  const visibleWeeks = useVisibleWeeks(chartRef);

  // Keep the x-axis bounded — only the latest weeks that fit are charted.
  const recent = weekly.slice(-visibleWeeks);
  const value = (w: WeeklyUsage) => (metric === "cost" ? w.costUsd : w.turns);
  const max = recent.reduce((hi, w) => Math.max(hi, value(w)), 0);
  const total = recent.reduce((sum, w) => sum + value(w), 0);
  const avg = recent.length > 0 ? total / recent.length : 0;
  // Cap bar height below 100% so the persistent value label above the tallest
  // bar still fits inside the chart area. The avg baseline uses the same scale.
  const BAR_SCALE = 82;
  const avgPct = max > 0 ? (avg / max) * BAR_SCALE : 0;
  const fmt = (w: WeeklyUsage) => formatWeeklyValue(metric, w.costUsd, w.turns);
  const avgLabel = metric === "cost" ? formatCost(avg) : `${Math.round(avg)}`;
  const totalLabel = metric === "cost" ? formatCost(total) : `${total}`;

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
          {(["cost", "turns"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMetric(m)}
              className={`px-2 py-0.5 rounded capitalize transition-colors ${
                metric === m
                  ? "bg-(--color-bg-tertiary) text-(--color-text-primary)"
                  : "text-(--color-text-secondary) hover:text-(--color-text-primary)"
              }`}
            >
              {m}
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

export function UsageModal({ currentSessionUsage, allUsage, sessions, onClose, modelInfo, contextTokens, turnUsage }: UsageModalProps) {
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

  const sessionAvgCost =
    currentSessionUsage && currentSessionUsage.turnCount > 0
      ? currentSessionUsage.totalCostUsd / currentSessionUsage.turnCount
      : 0;
  const allAvgCost =
    allUsage && allUsage.totalTurns > 0 ? allUsage.totalCostUsd / allUsage.totalTurns : 0;
  // Costliest first — with room for a full list, ordering by spend is what makes
  // the breakdown answer "where did the money go?".
  const rankedSessions = allUsage ? [...allUsage.sessions].sort((a, b) => b.totalCostUsd - a.totalCostUsd) : [];

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
              <div className="space-y-1 text-sm">
                {modelInfo && (
                  <Stat label="Model" value={formatModelName(modelInfo.model)} testId="usage-model-name" />
                )}
                <Stat label="Cost" value={formatCost(currentSessionUsage.totalCostUsd)} />
                <Stat label="Turns" value={`${currentSessionUsage.turnCount}`} />
                <Stat label="Duration" value={formatDuration(currentSessionUsage.totalDurationMs)} />
                {/* Only meaningful past the first turn — with one turn the
                    average is just the cost row again. */}
                {currentSessionUsage.turnCount > 1 && (
                  <Stat label="Avg / turn" value={formatCost(sessionAvgCost)} testId="usage-session-avg" />
                )}
              </div>
            ) : (
              <p className="text-sm text-(--color-text-secondary)">No usage data yet</p>
            )}
          </section>

          {/* All sessions */}
          <section>
            <SectionHeading>All sessions</SectionHeading>
            {allUsage && allUsage.totalTurns > 0 ? (
              <div className="space-y-1 text-sm">
                <Stat label="Cost" value={formatCost(allUsage.totalCostUsd)} />
                <Stat label="Turns" value={`${allUsage.totalTurns}`} />
                <Stat label="Sessions" value={`${allUsage.sessions.length}`} testId="usage-session-count" />
                {allUsage.totalTurns > 1 && (
                  <Stat label="Avg / turn" value={formatCost(allAvgCost)} testId="usage-all-avg" />
                )}
              </div>
            ) : (
              <p className="text-sm text-(--color-text-secondary)">No usage data yet</p>
            )}
          </section>

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
                <span className="text-right">Cost</span>
                <span className="text-right">Time</span>
              </div>
              <div className="max-h-64 overflow-y-auto">
                {[...turnUsage].reverse().map((turn, i) => {
                  const turnNum = turnUsage.length - i;
                  return (
                    <div
                      key={i}
                      className={`${TURN_ROW_COLS} items-center text-xs py-1 border-b border-(--color-border-primary) last:border-0 font-mono tabular-nums`}
                      data-testid="turn-breakdown-row"
                    >
                      <span className="text-(--color-text-secondary)">#{turnNum}</span>
                      <span className="text-(--color-text-primary) text-right">{formatTokenCount(turn.inputTokens)}</span>
                      <span className="text-(--color-text-primary) text-right">{formatTokenCount(turn.outputTokens)}</span>
                      <span className="text-(--color-text-secondary) text-right">{formatCost(turn.costUsd)}</span>
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
                {rankedSessions.map((s) => (
                  <div
                    key={s.sessionId}
                    className="flex items-center justify-between text-sm py-1 border-b border-(--color-border-primary) last:border-0"
                  >
                    <span className="text-(--color-text-primary) truncate mr-3" title={s.sessionId}>
                      {getSessionTitle(s.sessionId)}
                    </span>
                    <span className="shrink-0 flex items-center gap-3 tabular-nums">
                      <span className="text-(--color-text-secondary) text-xs">
                        {s.turnCount} {s.turnCount === 1 ? "turn" : "turns"}
                      </span>
                      <span className="text-(--color-text-primary)">{formatCost(s.totalCostUsd)}</span>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
