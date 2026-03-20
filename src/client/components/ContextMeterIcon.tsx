import { useState } from "react";
import { ICON_SIZE } from "../design-tokens.js";
import type { ModelInfo } from "./StatusBar.js";
import { formatTokenCount, getContextLevel } from "./StatusBar.js";

const levelColors: Record<string, string> = {
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

export function ContextMeterIcon({
  modelInfo,
  contextTokens,
}: {
  modelInfo: ModelInfo | null;
  contextTokens: number;
}) {
  const [showTooltip, setShowTooltip] = useState(false);

  if (!modelInfo || contextTokens === 0) return null;

  const percentage = modelInfo.contextWindowTokens > 0
    ? Math.min(100, (contextTokens / modelInfo.contextWindowTokens) * 100)
    : 0;
  const level = getContextLevel(percentage);
  const colorClass = levelColors[level];
  const barColorClass = levelBarColors[level];

  return (
    <div
      className="relative flex items-center"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      data-testid="context-meter-icon"
    >
      <div
        className={`flex items-center justify-center ${colorClass}`}
        aria-label={`Context usage: ${Math.round(percentage)}%`}
      >
        {/* Circular meter indicator */}
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
      </div>

      {/* Tooltip */}
      {showTooltip && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-(--color-bg-elevated) border border-(--color-border-secondary) rounded-lg shadow-xl z-50 whitespace-nowrap text-xs">
          <div className="text-(--color-text-primary) font-medium mb-1">
            {modelInfo.model}
          </div>
          <div className="flex items-center gap-2 text-(--color-text-secondary)">
            <span>
              {formatTokenCount(contextTokens)} / {formatTokenCount(modelInfo.contextWindowTokens)}
            </span>
            <div className="w-16 h-1.5 bg-(--color-bg-tertiary) rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${barColorClass}`}
                style={{ width: `${percentage}%` }}
              />
            </div>
            <span className={colorClass}>{Math.round(percentage)}%</span>
          </div>
        </div>
      )}
    </div>
  );
}
