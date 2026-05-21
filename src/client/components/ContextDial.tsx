import { useState, useMemo } from "react";
import { ICON_SIZE } from "../design-tokens.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";
import type { ModelInfo } from "../utils/model-info.js";
import { formatTokenCount, getContextLevel } from "../utils/model-info.js";
import type { TurnUsage } from "../../server/shared/types.js";
import { turnContextTokens } from "../../server/shared/types.js";

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

function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Detect a `/compact` event by checking for a sharp drop in context size
 * between the previous turn and the most recent turn — Claude Code's
 * `/compact` slash command replaces in-context history with a summary,
 * which surfaces as a step-change reduction in the next turn's context
 * occupancy. Threshold (40%) is conservative so normal turn-to-turn
 * variance doesn't trigger a false positive.
 *
 * Uses `turnContextTokens()` (input + cache reads + cache writes) rather than
 * raw `inputTokens` — with prompt caching active, `inputTokens` is tiny and
 * noisy, so comparing it would never reliably detect a compaction.
 */
function wasCompacted(turns: TurnUsage[]): boolean {
  if (turns.length < 2) return false;
  const last = turnContextTokens(turns[turns.length - 1]);
  const prev = turnContextTokens(turns[turns.length - 2]);
  if (prev < 5_000) return false;
  return last < prev * 0.6;
}

/**
 * Compact context-window usage indicator with an expandable popover that
 * surfaces a per-turn token/cost breakdown. Inspired by Conductor's
 * "context dial" (v0.33.0).
 *
 * The dial fills from green → yellow → orange → red as the most recent
 * turn's input tokens (= the current context size, since Claude re-reads
 * the entire conversation each turn) approaches the model's window. When
 * the dial is full enough, a hint suggests typing `/compact` in the
 * composer — the slash command travels through the regular send path,
 * so this component never invokes it directly (CLAUDE.md §5).
 *
 * The dial is also the canonical surface for *running session cost*. The
 * trigger button shows the cumulative session cost next to the K-token
 * reading, and the popover's "Total cost" row opens the full usage modal.
 * The previous standalone cost pill in the composer toolbar (driven from
 * the same `currentSessionUsage` the dial now reads) was removed when
 * these two surfaces were unified.
 */
export function ContextDial({
  modelInfo,
  turnUsage,
  /** Override the dial's "current context tokens" reading (defaults to the most recent turn's input). */
  contextTokensOverride,
  /**
   * Authoritative session-cumulative totals — sourced from `UsageManager`
   * via `usage_update` / `/history`. Used for the popover's totals row so
   * it always matches the value `UsageModal` shows (no more $1.31-vs-$5.41
   * discrepancy between the dial's per-turn sum and the cost pill).
   */
  sessionTotalCostUsd,
  cumulativeInputTokens,
  cumulativeOutputTokens,
  /**
   * Click handler for the popover's "Total cost" row. Wired up to open the
   * usage modal — the dial is now the entry point that the cost pill used
   * to be.
   */
  onOpenUsageDetails,
}: {
  modelInfo: ModelInfo | null;
  turnUsage: TurnUsage[];
  contextTokensOverride?: number;
  sessionTotalCostUsd?: number;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  onOpenUsageDetails?: () => void;
}) {
  const [open, setOpen] = useState(false);

  const lastTurn = turnUsage.length > 0 ? turnUsage[turnUsage.length - 1] : null;
  // Context occupancy = uncached input + cache reads + cache writes. Using
  // `lastTurn.inputTokens` alone here was the bug behind "Context: 4 / 200K" —
  // with prompt caching, virtually the entire window shows up as cache tokens.
  const contextTokens = contextTokensOverride ?? (lastTurn ? turnContextTokens(lastTurn) : 0);
  const compacted = wasCompacted(turnUsage);

  // Cumulative cache totals are still derived from the per-turn series — the
  // server doesn't currently surface session-level cache totals, and they're
  // strictly informational (shown only when > 0).
  const cacheAggregate = useMemo(() => {
    let totalCacheRead = 0;
    let totalCacheCreate = 0;
    for (const t of turnUsage) {
      totalCacheRead += t.cacheRead ?? 0;
      totalCacheCreate += t.cacheCreate ?? 0;
    }
    return { totalCacheRead, totalCacheCreate };
  }, [turnUsage]);

  // Top contributors — biggest turns by context occupancy (input + cache);
  // mostly informative when the context is approaching full.
  //
  // IMPORTANT: this hook must stay above the `if (!modelInfo) return null`
  // guard below. `modelInfo` flips from null → populated once the first
  // turn's usage arrives, so a component instance that rendered while it was
  // null (1 fewer hook) would render more hooks on the next pass → React
  // error #310 ("Rendered more hooks than during the previous render").
  const topTurns = useMemo(() => {
    return [...turnUsage]
      .map((t, i) => ({ ...t, index: i + 1, contextTokens: turnContextTokens(t) }))
      .sort((a, b) => b.contextTokens - a.contextTokens)
      .slice(0, 3);
  }, [turnUsage]);

  // Authoritative cost / token totals — fall back to per-turn sums only if
  // the parent didn't pass them (e.g. tests, or a pre-rehydration render).
  const totalCost = sessionTotalCostUsd ?? turnUsage.reduce((sum, t) => sum + t.costUsd, 0);
  const totalInput = cumulativeInputTokens ?? turnUsage.reduce((sum, t) => sum + t.inputTokens, 0);
  const totalOutput = cumulativeOutputTokens ?? turnUsage.reduce((sum, t) => sum + t.outputTokens, 0);

  if (!modelInfo) return null;

  const window = modelInfo.contextWindowTokens > 0 ? modelInfo.contextWindowTokens : 200_000;
  const percentage = Math.min(100, (contextTokens / window) * 100);
  const level = getContextLevel(percentage);
  const textColor = levelTextColors[level];
  const barColor = levelBarColors[level];

  // Sparkline scaling — top of the chart is the largest context occupancy
  // ever seen so the dial reflects the running maximum (= effective context
  // size, including cache reads/writes).
  const maxContext = turnUsage.reduce((m, t) => Math.max(m, turnContextTokens(t)), 1);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-(--color-bg-hover) transition-colors"
          aria-label={`Context usage: ${Math.round(percentage)}%${totalCost > 0 ? `, session cost ${formatCost(totalCost)}` : ""}`}
          data-testid="context-dial"
          data-level={level}
        >
          <span className={`flex items-center justify-center ${textColor}`}>
            {/* Circular dial indicator */}
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
          {contextTokens > 0 && (
            <span
              className="hidden md:inline text-[11px] font-mono text-(--color-text-secondary)"
              data-testid="context-dial-label"
            >
              {formatTokenCount(contextTokens)}
            </span>
          )}
          {totalCost > 0 && (
            <span
              className="text-[11px] font-mono text-(--color-accent)"
              data-testid="context-dial-cost"
            >
              {formatCost(totalCost)}
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
                {topTurns.map((t) => (
                  <div
                    key={t.index}
                    className="flex justify-between text-(--color-text-primary)"
                  >
                    <span className="text-(--color-text-secondary)">#{t.index}</span>
                    <span>{formatTokenCount(t.contextTokens)} ctx</span>
                    <span>{formatTokenCount(t.outputTokens)} out</span>
                    <span>{formatCost(t.costUsd)}</span>
                  </div>
                ))}
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
                <span className="text-(--color-text-secondary) underline decoration-dotted underline-offset-2">
                  Total cost
                </span>
                <span className="text-(--color-text-primary) text-right font-mono">
                  {formatCost(totalCost)}
                </span>
              </button>
            ) : (
              <>
                <span>Total cost</span>
                <span className="text-(--color-text-primary) text-right font-mono">
                  {formatCost(totalCost)}
                </span>
              </>
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
