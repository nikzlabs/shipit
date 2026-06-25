import { useState } from "react";
import { XIcon } from "@phosphor-icons/react";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.js";
import { ICON_SIZE } from "../design-tokens.js";
import type { SessionInfo, TurnUsage } from "../../server/shared/types.js";
import { formatTokenCount, getContextLevel, type ModelInfo } from "../utils/model-info.js";

export interface SessionUsage {
  sessionId: string;
  totalCostUsd: number;
  totalDurationMs: number;
  turnCount: number;
}

export interface MonthlyUsage {
  month: string;
  costUsd: number;
  turns: number;
}

export interface UsageStats {
  sessions: SessionUsage[];
  totalCostUsd: number;
  totalTurns: number;
  monthly: MonthlyUsage[];
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

/** `2026-06` → `Jun '26`, for compact x-axis labels. */
function formatMonth(month: string): string {
  const [year, mon] = month.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const idx = Number(mon) - 1;
  const name = names[idx] ?? mon;
  return `${name} '${year.slice(2)}`;
}

type MonthlyMetric = "cost" | "turns";

/** Compact metric label for the hover tooltip / average line. */
function formatMonthlyValue(metric: MonthlyMetric, costUsd: number, turns: number): string {
  return metric === "cost" ? formatCost(costUsd) : `${turns}`;
}

/**
 * Compact per-month bar chart for the all-sessions trend. Pure CSS/Tailwind
 * (no charting lib, matching the ContextDial sparkline), toggles between cost
 * and turns, scaled to the largest bar in the series. Windowed to the most
 * recent 12 months so the x-axis stays readable as data accumulates; draws an
 * average baseline and emphasizes the current (most recent) month.
 */
function MonthlyUsageChart({ monthly }: { monthly: MonthlyUsage[] }) {
  const [metric, setMetric] = useState<MonthlyMetric>("cost");

  // Keep the x-axis bounded — only the latest 12 months are charted.
  const recent = monthly.slice(-12);
  const value = (m: MonthlyUsage) => (metric === "cost" ? m.costUsd : m.turns);
  const max = recent.reduce((hi, m) => Math.max(hi, value(m)), 0);
  const total = recent.reduce((sum, m) => sum + value(m), 0);
  const avg = recent.length > 0 ? total / recent.length : 0;
  // Cap bar height below 100% so the persistent value label above the tallest
  // bar still fits inside the chart area. The avg baseline uses the same scale.
  const BAR_SCALE = 82;
  const avgPct = max > 0 ? (avg / max) * BAR_SCALE : 0;
  const fmt = (m: MonthlyUsage) => formatMonthlyValue(metric, m.costUsd, m.turns);
  const avgLabel = metric === "cost" ? formatCost(avg) : `${Math.round(avg)}`;

  return (
    <section data-testid="monthly-usage-section">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-(--color-text-secondary)">Monthly trend</h3>
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
      <div className="relative flex items-end gap-1 h-20" data-testid="monthly-usage-chart">
        {recent.map((m, i) => {
          const h = max > 0 ? Math.max(2, (value(m) / max) * BAR_SCALE) : 2;
          const isCurrent = i === recent.length - 1;
          return (
            <div
              key={m.month}
              className="group relative flex-1 h-full flex flex-col justify-end min-w-0"
            >
              {/* Persistent per-month value label, sits directly above the bar. */}
              <span
                className={`pointer-events-none mb-0.5 text-center text-[9px] leading-tight tabular-nums truncate ${
                  isCurrent ? "text-(--color-text-primary) font-medium" : "text-(--color-text-secondary)"
                }`}
                data-testid="monthly-usage-bar-label"
              >
                {fmt(m)}
              </span>
              <div
                className={`w-full rounded-sm bg-(--color-accent) transition-all group-hover:opacity-80 ${
                  isCurrent ? "" : "opacity-55"
                }`}
                style={{ height: `${h}%` }}
                title={`${formatMonth(m.month)}: ${fmt(m)}`}
              />
            </div>
          );
        })}
        {/* Average baseline across the bars. */}
        {avg > 0 && (
          <div
            className="pointer-events-none absolute left-0 right-0 flex items-center"
            style={{ bottom: `${avgPct}%` }}
            data-testid="monthly-usage-avg"
          >
            <span className="mr-1 rounded bg-(--color-bg-secondary) px-1 text-[9px] leading-tight text-(--color-text-secondary)">
              avg {avgLabel}
            </span>
            <div className="flex-1 border-t border-dashed border-(--color-text-secondary) opacity-60" />
          </div>
        )}
      </div>
      <div className="flex gap-1 mt-1">
        {recent.map((m, i) => {
          const isCurrent = i === recent.length - 1;
          return (
            <span
              key={m.month}
              className={`flex-1 text-[10px] truncate text-center ${
                isCurrent ? "text-(--color-text-primary) font-medium" : "text-(--color-text-secondary)"
              }`}
            >
              {formatMonth(m.month)}
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

import { formatModelName } from "../utils/format-model.js";

const levelBarColors: Record<string, string> = {
  green: "bg-(--color-success)",
  yellow: "bg-(--color-warning)",
  orange: "bg-(--color-context-high)",
  red: "bg-(--color-error)",
};

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
  const hasTurnTokens = (turnUsage?.length ?? 0) > 0;

  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent
        className="rounded-lg border-(--color-border-secondary) max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto"
        data-testid="usage-modal-backdrop"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-(--color-border-secondary)">
          <DialogTitle className="text-lg font-semibold">Usage Summary</DialogTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-9 w-9 max-md:h-10 max-md:w-10"
            aria-label="Close"
          >
            <XIcon size={ICON_SIZE.MD} weight="bold" />
          </Button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-5">
          {/* Current session */}
          <section>
            <h3 className="text-sm font-medium text-(--color-text-secondary) mb-2">This session</h3>
            {currentSessionUsage ? (
              <div className="space-y-1 text-sm">
                {modelInfo && (
                  <div className="flex justify-between">
                    <span className="text-(--color-text-secondary)">Model</span>
                    <span className="text-(--color-text-primary)" data-testid="usage-model-name">{formatModelName(modelInfo.model)}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-(--color-text-secondary)">Cost</span>
                  <span className="text-(--color-text-primary)">{formatCost(currentSessionUsage.totalCostUsd)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-(--color-text-secondary)">Turns</span>
                  <span className="text-(--color-text-primary)">{currentSessionUsage.turnCount}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-(--color-text-secondary)">Duration</span>
                  <span className="text-(--color-text-primary)">{formatDuration(currentSessionUsage.totalDurationMs)}</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-(--color-text-secondary)">No usage data yet</p>
            )}
          </section>

          {/* Context usage */}
          {modelInfo && contextTokens !== undefined && contextTokens > 0 && (
            <section data-testid="context-usage-section">
              <h3 className="text-sm font-medium text-(--color-text-secondary) mb-2">Context usage</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-(--color-text-secondary)">Tokens used</span>
                  <span className="text-(--color-text-primary)">
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

          {/* Per-turn token breakdown */}
          {hasTurnTokens && turnUsage && turnUsage.length > 0 && (
            <section data-testid="turn-breakdown-section">
              <h3 className="text-sm font-medium text-(--color-text-secondary) mb-2">Per-turn breakdown</h3>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {[...turnUsage].reverse().map((turn, i) => {
                  const turnNum = turnUsage.length - i;
                  return (
                    <div
                      key={i}
                      className="flex items-center justify-between text-xs py-1 border-b border-(--color-border-primary) last:border-0 font-mono"
                    >
                      <span className="text-(--color-text-secondary) w-8">#{turnNum}</span>
                      <span className="text-(--color-text-primary)">
                        In: {formatTokenCount(turn.inputTokens)}
                      </span>
                      <span className="text-(--color-text-primary)">
                        Out: {formatTokenCount(turn.outputTokens)}
                      </span>
                      <span className="text-(--color-text-secondary)">{formatCost(turn.costUsd)}</span>
                      <span className="text-(--color-text-secondary)">{formatDuration(turn.durationMs ?? 0)}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Token totals */}
          {hasTurnTokens && (
            <section data-testid="token-totals-section">
              <h3 className="text-sm font-medium text-(--color-text-secondary) mb-2">Token totals</h3>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-(--color-text-secondary)">Input</span>
                  <span className="text-(--color-text-primary)">{formatTokenCount(totalInputTokens)} tokens</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-(--color-text-secondary)">Output</span>
                  <span className="text-(--color-text-primary)">{formatTokenCount(totalOutputTokens)} tokens</span>
                </div>
              </div>
            </section>
          )}

          {/* All sessions */}
          <section>
            <h3 className="text-sm font-medium text-(--color-text-secondary) mb-2">All sessions</h3>
            {allUsage && allUsage.totalTurns > 0 ? (
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-(--color-text-secondary)">Cost</span>
                  <span className="text-(--color-text-primary)">{formatCost(allUsage.totalCostUsd)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-(--color-text-secondary)">Turns</span>
                  <span className="text-(--color-text-primary)">{allUsage.totalTurns}</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-(--color-text-secondary)">No usage data yet</p>
            )}
          </section>

          {/* Monthly trend chart */}
          {allUsage && allUsage.monthly.length > 0 && (
            <MonthlyUsageChart monthly={allUsage.monthly} />
          )}

          {/* Per-session breakdown */}
          {allUsage && allUsage.sessions.length > 0 && (
            <section>
              <h3 className="text-sm font-medium text-(--color-text-secondary) mb-2">Recent sessions</h3>
              <div className="space-y-1">
                {allUsage.sessions.map((s) => (
                  <div
                    key={s.sessionId}
                    className="flex items-center justify-between text-sm py-1 border-b border-(--color-border-primary) last:border-0"
                  >
                    <span className="text-(--color-text-primary) truncate mr-3" title={s.sessionId}>
                      {getSessionTitle(s.sessionId)}
                    </span>
                    <span className="text-(--color-text-primary) shrink-0">{formatCost(s.totalCostUsd)}</span>
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
