import { useState, useMemo } from "react";
import { ICON_SIZE } from "../design-tokens.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";
import type { ModelInfo } from "./StatusBar.js";
import { formatTokenCount, getContextLevel } from "./StatusBar.js";
import type { TurnUsage } from "../../server/shared/types.js";

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
 * Detect a `/compact` event by checking for a sharp drop in input tokens
 * between the previous turn and the most recent turn — Claude Code's
 * `/compact` slash command replaces in-context history with a summary,
 * which surfaces as a step-change reduction in the next turn's input
 * token count. Threshold (40%) is conservative so normal turn-to-turn
 * variance doesn't trigger a false positive.
 */
function wasCompacted(turns: TurnUsage[]): boolean {
  if (turns.length < 2) return false;
  const last = turns[turns.length - 1];
  const prev = turns[turns.length - 2];
  if (prev.inputTokens < 5_000) return false;
  return last.inputTokens < prev.inputTokens * 0.6;
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
 */
export function ContextDial({
  modelInfo,
  turnUsage,
  /** Override the dial's "current context tokens" reading (defaults to the most recent turn's input). */
  contextTokensOverride,
}: {
  modelInfo: ModelInfo | null;
  turnUsage: TurnUsage[];
  contextTokensOverride?: number;
}) {
  const [open, setOpen] = useState(false);

  const lastTurn = turnUsage.length > 0 ? turnUsage[turnUsage.length - 1] : null;
  const contextTokens = contextTokensOverride ?? lastTurn?.inputTokens ?? 0;
  const compacted = wasCompacted(turnUsage);

  const aggregate = useMemo(() => {
    let totalCost = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheCreate = 0;
    for (const t of turnUsage) {
      totalCost += t.costUsd;
      totalInput += t.inputTokens;
      totalOutput += t.outputTokens;
      totalCacheRead += t.cacheRead ?? 0;
      totalCacheCreate += t.cacheCreate ?? 0;
    }
    return { totalCost, totalInput, totalOutput, totalCacheRead, totalCacheCreate };
  }, [turnUsage]);

  if (!modelInfo) return null;

  const window = modelInfo.contextWindowTokens > 0 ? modelInfo.contextWindowTokens : 200_000;
  const percentage = Math.min(100, (contextTokens / window) * 100);
  const level = getContextLevel(percentage);
  const textColor = levelTextColors[level];
  const barColor = levelBarColors[level];

  // Sparkline scaling — top of the chart is the largest input ever seen so the
  // dial reflects the running maximum (= effective context size).
  const maxInput = turnUsage.reduce((m, t) => Math.max(m, t.inputTokens), 1);

  // Top contributors — biggest input-token turns; mostly informative when the
  // context is approaching full.
  const topTurns = useMemo(() => {
    return [...turnUsage]
      .map((t, i) => ({ ...t, index: i + 1 }))
      .sort((a, b) => b.inputTokens - a.inputTokens)
      .slice(0, 3);
  }, [turnUsage]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-(--color-bg-hover) transition-colors"
          aria-label={`Context usage: ${Math.round(percentage)}%`}
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
                <span>Per-turn input</span>
                <span className="font-mono">
                  {turnUsage.length} {turnUsage.length === 1 ? "turn" : "turns"}
                </span>
              </div>
              <div
                className="flex items-end gap-0.5 h-10 bg-(--color-bg-tertiary) rounded p-1"
                data-testid="context-dial-sparkline"
              >
                {turnUsage.map((t, i) => {
                  const h = maxInput > 0 ? Math.max(2, (t.inputTokens / maxInput) * 100) : 2;
                  return (
                    <div
                      key={i}
                      className={`flex-1 ${barColor} rounded-sm`}
                      style={{ height: `${h}%`, opacity: 0.4 + 0.6 * (i / Math.max(1, turnUsage.length - 1)) }}
                      title={`Turn ${i + 1}: ${formatTokenCount(t.inputTokens)} in, ${formatTokenCount(t.outputTokens)} out`}
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
                    <span>{formatTokenCount(t.inputTokens)} in</span>
                    <span>{formatTokenCount(t.outputTokens)} out</span>
                    <span>{formatCost(t.costUsd)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="border-t border-(--color-border-primary) pt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-(--color-text-secondary)">
            <span>Total cost</span>
            <span className="text-(--color-text-primary) text-right font-mono">
              {formatCost(aggregate.totalCost)}
            </span>
            <span>Input tokens</span>
            <span className="text-(--color-text-primary) text-right font-mono">
              {formatTokenCount(aggregate.totalInput)}
            </span>
            <span>Output tokens</span>
            <span className="text-(--color-text-primary) text-right font-mono">
              {formatTokenCount(aggregate.totalOutput)}
            </span>
            {aggregate.totalCacheRead > 0 && (
              <>
                <span>Cache reads</span>
                <span className="text-(--color-text-primary) text-right font-mono">
                  {formatTokenCount(aggregate.totalCacheRead)}
                </span>
              </>
            )}
            {aggregate.totalCacheCreate > 0 && (
              <>
                <span>Cache writes</span>
                <span className="text-(--color-text-primary) text-right font-mono">
                  {formatTokenCount(aggregate.totalCacheCreate)}
                </span>
              </>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
