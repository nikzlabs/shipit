import { Fragment, useState, useMemo } from "react";
import { INSET_FOCUS_RING, ICON_SIZE } from "../design-tokens.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";
import type { ModelInfo } from "../utils/model-info.js";
import { formatTokenCount, getContextLevel } from "../utils/model-info.js";
import type { TurnUsage, UsageTotals } from "../../server/shared/types.js";
import { turnContextTokens } from "../../server/shared/types.js";
import { sessionRunningFigure } from "../../server/shared/types/usage-types.js";
import {
  RUNNING_FIGURE_TITLE, formatCost, formatEstimate, turnCostDisplay,
} from "../utils/format-cost.js";

const levelTextColors: Record<string, string> = {
  green: "text-(--color-context-ok)",
  yellow: "text-(--color-context-mid)",
  orange: "text-(--color-context-high)",
  red: "text-(--color-context-full)",
};

const levelBarColors: Record<string, string> = {
  green: "bg-(--color-context-ok)",
  yellow: "bg-(--color-context-mid)",
  orange: "bg-(--color-context-high)",
  red: "bg-(--color-context-full)",
};

function fallbackTotals(turns: TurnUsage[]): UsageTotals {
  const totals: UsageTotals = {
    meteredCostUsd: 0, meteredTurns: 0, meteredTokens: 0,
    atApiRatesUsd: 0, includedTurns: 0, includedTokens: 0,
    legacyCostUsd: 0, legacyTurns: 0, legacyTokens: 0,
  };
  for (const t of turns) {
    const tokens = t.inputTokens + t.outputTokens + (t.cacheRead ?? 0) + (t.cacheCreate ?? 0);
    if (t.billingMode === "sub") {
      totals.atApiRatesUsd += t.atApiRatesUsd ?? 0;
      totals.includedTurns += 1;
      totals.includedTokens += tokens;
    } else if (t.billingMode === "key") {
      totals.meteredCostUsd += t.costUsd;
      totals.meteredTurns += 1;
      totals.meteredTokens += tokens;
    } else {
      totals.legacyCostUsd += t.costUsd;
      totals.legacyTurns += 1;
      totals.legacyTokens += tokens;
    }
  }
  return totals;
}

function CostRows({ totals, underline }: { totals: UsageTotals; underline?: boolean }) {
  const label = underline
    ? "text-(--color-text-secondary) underline decoration-dotted underline-offset-2"
    : "text-(--color-text-secondary)";
  const rows: { key: string; label: string; value: string; title: string; dim?: boolean }[] = [];
  if (totals.meteredCostUsd > 0 || (totals.atApiRatesUsd === 0 && totals.legacyCostUsd === 0)) {
    rows.push({
      key: "metered",
      label: "Metered spend",
      value: formatCost(totals.meteredCostUsd),
      title: RUNNING_FIGURE_TITLE.metered,
    });
  }
  if (totals.atApiRatesUsd > 0) {
    rows.push({
      key: "at-api-rates",
      label: "At API rates",
      value: formatEstimate(totals.atApiRatesUsd),
      title: RUNNING_FIGURE_TITLE["at-api-rates"],
      dim: true,
    });
  }
  if (totals.legacyCostUsd > 0) {
    rows.push({
      key: "earlier",
      label: "Earlier accounting",
      value: formatCost(totals.legacyCostUsd),
      title: RUNNING_FIGURE_TITLE.earlier,
      dim: true,
    });
  }
  return (
    <>
      {rows.map((row) => (
        <Fragment key={row.key}>
          <span className={label} title={row.title}>{row.label}</span>
          <span
            className={`text-right font-mono ${row.dim ? "text-(--color-text-secondary)" : "text-(--color-text-primary)"}`}
            data-testid={`context-dial-cost-${row.key}`}
          >
            {row.value}
          </span>
        </Fragment>
      ))}
    </>
  );
}

function wasCompacted(turns: TurnUsage[]): boolean {
  if (turns.length < 2) return false;
  const last = turnContextTokens(turns[turns.length - 1]);
  const prev = turnContextTokens(turns[turns.length - 2]);
  if (prev < 5_000) return false;
  return last < prev * 0.6;
}

export function ContextDial({
  modelInfo,
  turnUsage,
  contextTokensOverride,
  sessionTotals,
  cumulativeInputTokens,
  cumulativeOutputTokens,
  onOpenUsageDetails,
  authoritativeCompacted,
  compact = false,
}: {
  modelInfo: ModelInfo | null;
  turnUsage: TurnUsage[];
  contextTokensOverride?: number;
  sessionTotals?: UsageTotals;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  onOpenUsageDetails?: () => void;
  authoritativeCompacted?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const lastTurn = turnUsage.length > 0 ? turnUsage[turnUsage.length - 1] : null;
  const contextTokens = contextTokensOverride ?? (lastTurn ? turnContextTokens(lastTurn) : 0);
  const compacted = authoritativeCompacted || wasCompacted(turnUsage);

  const cacheAggregate = useMemo(() => {
    let totalCacheRead = 0;
    let totalCacheCreate = 0;
    for (const t of turnUsage) {
      totalCacheRead += t.cacheRead ?? 0;
      totalCacheCreate += t.cacheCreate ?? 0;
    }
    return { totalCacheRead, totalCacheCreate };
  }, [turnUsage]);

  const topTurns = useMemo(() => {
    return [...turnUsage]
      .map((t, i) => ({ ...t, index: i + 1, contextTokens: turnContextTokens(t) }))
      .sort((a, b) => b.contextTokens - a.contextTokens)
      .slice(0, 3);
  }, [turnUsage]);

  const totals = sessionTotals ?? fallbackTotals(turnUsage);
  const running = sessionRunningFigure(totals);
  const totalInput = cumulativeInputTokens ?? turnUsage.reduce((sum, t) => sum + t.inputTokens, 0);
  const totalOutput = cumulativeOutputTokens ?? turnUsage.reduce((sum, t) => sum + t.outputTokens, 0);

  if (!modelInfo) return null;

  const window = modelInfo.contextWindowTokens > 0 ? modelInfo.contextWindowTokens : 200_000;
  const percentage = Math.min(100, (contextTokens / window) * 100);
  const level = getContextLevel(percentage);
  const textColor = levelTextColors[level];
  const barColor = levelBarColors[level];

  const maxContext = turnUsage.reduce((m, t) => Math.max(m, turnContextTokens(t)), 1);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-(--color-bg-hover) transition-colors ${INSET_FOCUS_RING}`}
          aria-label={`Context usage: ${Math.round(percentage)}%${
            running
              ? `, ${RUNNING_FIGURE_TITLE[running.kind]}: ${
                running.kind === "at-api-rates" ? formatEstimate(running.usd) : formatCost(running.usd)
              }`
              : ""
          }`}
          data-testid="context-dial"
          data-level={level}
        >
          <span className={`flex items-center justify-center ${textColor}`}>
            <svg width={ICON_SIZE.MD} height={ICON_SIZE.MD} viewBox="0 0 20 20">
              <circle
                cx="10"
                cy="10"
                r="7"
                fill="none"
                stroke="currentColor"
                strokeOpacity="0.2"
                strokeWidth="2.5"
              />
              <circle
                cx="10"
                cy="10"
                r="7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeDasharray={`${(percentage / 100) * 44} 44`}
                strokeLinecap="round"
                transform="rotate(-90 10 10)"
              />
            </svg>
          </span>
          {!compact && contextTokens > 0 && (
            <span
              className="hidden md:inline text-[11px] font-mono text-(--color-text-secondary)"
              data-testid="context-dial-label"
            >
              {formatTokenCount(contextTokens)}
            </span>
          )}
          {!compact && running && (
            <span
              className="hidden md:inline text-[11px] font-mono text-(--color-accent)"
              data-testid="context-dial-cost"
              data-figure-kind={running.kind}
              title={RUNNING_FIGURE_TITLE[running.kind]}
            >
              {running.kind === "at-api-rates" ? formatEstimate(running.usd) : formatCost(running.usd)}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-80 p-3"
        data-testid="context-dial-popover"
      >
        <div className="space-y-3 text-xs">
          <div className="flex items-baseline justify-between">
            <span className="text-(--color-text-primary) font-medium">
              {modelInfo.model}
            </span>
            <span className={`${textColor} font-mono`}>
              {Math.round(percentage)}%
            </span>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between text-(--color-text-secondary)">
              <span>Context</span>
              <span className="font-mono">
                {formatTokenCount(contextTokens)} / {formatTokenCount(window)}
              </span>
            </div>
            <div className="w-full h-1.5 bg-(--color-bg-tertiary) rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${barColor} transition-all`}
                style={{ width: `${percentage}%` }}
                data-testid="context-dial-bar"
              />
            </div>
          </div>

          {compacted && (
            <div
              className="px-2 py-1.5 rounded bg-(--color-context-ok)/10 border border-(--color-context-ok)/20 text-(--color-context-ok)"
              data-testid="context-compacted-pill"
            >
              Context compacted — most recent turn used much less context than the
              previous turn.
            </div>
          )}

          {(level === "orange" || level === "red") && !compacted && (
            <div
              className={`px-2 py-1.5 rounded ${textColor} bg-(--color-bg-tertiary)`}
              data-testid="compact-hint"
            >
              Type <code className="font-mono">/compact</code> in the composer to
              summarize chat history and free up context.
            </div>
          )}

          {turnUsage.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-(--color-text-secondary)">
                <span>Per-turn context</span>
                <span className="font-mono">
                  {turnUsage.length} {turnUsage.length === 1 ? "turn" : "turns"}
                </span>
              </div>
              <div
                className="flex items-end gap-0.5 h-10 bg-(--color-bg-tertiary) rounded p-1"
                data-testid="context-dial-sparkline"
              >
                {turnUsage.map((t, i) => {
                  const ctx = turnContextTokens(t);
                  const h = maxContext > 0 ? Math.max(2, (ctx / maxContext) * 100) : 2;
                  return (
                    <div
                      key={i}
                      className={`flex-1 ${barColor} rounded-sm`}
                      style={{ height: `${h}%`, opacity: 0.4 + 0.6 * (i / Math.max(1, turnUsage.length - 1)) }}
                      title={`Turn ${i + 1}: ${formatTokenCount(ctx)} context, ${formatTokenCount(t.outputTokens)} out`}
                    />
                  );
                })}
              </div>
            </div>
          )}

          {topTurns.length > 0 && (
            <div className="space-y-1">
              <div className="text-(--color-text-secondary)">Largest turns</div>
              <div className="space-y-0.5 font-mono">
                {topTurns.map((t) => {
                  const cost = turnCostDisplay(t);
                  return (
                    <div
                      key={t.index}
                      className="flex justify-between text-(--color-text-primary)"
                    >
                      <span className="text-(--color-text-secondary)">#{t.index}</span>
                      <span>{formatTokenCount(t.contextTokens)} ctx</span>
                      <span>{formatTokenCount(t.outputTokens)} out</span>
                      <span className={cost.estimated ? "text-(--color-text-secondary)" : ""}>
                        {cost.text}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="border-t border-(--color-border-primary) pt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-(--color-text-secondary)">
            {onOpenUsageDetails ? (
              <button
                type="button"
                onClick={() => {
                  onOpenUsageDetails();
                  setOpen(false);
                }}
                className="col-span-2 -mx-1 px-1 py-0.5 grid grid-cols-2 gap-x-3 rounded hover:bg-(--color-bg-hover) text-left transition-colors cursor-pointer"
                data-testid="context-dial-open-usage"
                aria-label="Open usage details"
              >
                <CostRows totals={totals} underline />
              </button>
            ) : (
              <CostRows totals={totals} />
            )}
            <span>Input tokens</span>
            <span className="text-(--color-text-primary) text-right font-mono">
              {formatTokenCount(totalInput)}
            </span>
            <span>Output tokens</span>
            <span className="text-(--color-text-primary) text-right font-mono">
              {formatTokenCount(totalOutput)}
            </span>
            {cacheAggregate.totalCacheRead > 0 && (
              <>
                <span>Cache reads</span>
                <span className="text-(--color-text-primary) text-right font-mono">
                  {formatTokenCount(cacheAggregate.totalCacheRead)}
                </span>
              </>
            )}
            {cacheAggregate.totalCacheCreate > 0 && (
              <>
                <span>Cache writes</span>
                <span className="text-(--color-text-primary) text-right font-mono">
                  {formatTokenCount(cacheAggregate.totalCacheCreate)}
                </span>
              </>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
