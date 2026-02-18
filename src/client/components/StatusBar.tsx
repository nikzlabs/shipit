export interface ModelInfo {
  model: string;
  contextWindowTokens: number;
}

interface StatusBarProps {
  modelInfo: ModelInfo | null;
  contextTokens: number;
}

/** Convert CLI model ID to a human-readable display name. */
export function formatModelName(model: string): string {
  if (model.includes("opus")) return "Opus 4";
  if (model.includes("sonnet-4")) return "Sonnet 4";
  if (model.includes("sonnet-3")) return "Sonnet 3.5";
  if (model.includes("haiku")) return "Haiku 3.5";
  return model;
}

/** Format a token count as a compact string (e.g. 42180 -> "42.2K"). */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

type ContextLevel = "green" | "yellow" | "orange" | "red";

/** Get the color level for a context usage percentage. */
export function getContextLevel(percentage: number): ContextLevel {
  if (percentage >= 90) return "red";
  if (percentage >= 80) return "orange";
  if (percentage >= 60) return "yellow";
  return "green";
}

const levelColors: Record<ContextLevel, { bar: string; text: string }> = {
  green: { bar: "bg-green-500", text: "text-green-400" },
  yellow: { bar: "bg-yellow-500", text: "text-yellow-400" },
  orange: { bar: "bg-orange-500", text: "text-orange-400" },
  red: { bar: "bg-red-500", text: "text-red-400" },
};

export function StatusBar({ modelInfo, contextTokens }: StatusBarProps) {
  if (!modelInfo) return null;

  const percentage = modelInfo.contextWindowTokens > 0
    ? Math.min(100, (contextTokens / modelInfo.contextWindowTokens) * 100)
    : 0;
  const level = getContextLevel(percentage);
  const colors = levelColors[level];

  return (
    <div
      className="flex items-center gap-3 px-4 py-1 border-t border-gray-200 dark:border-gray-800 text-xs text-gray-500 dark:text-gray-400"
      data-testid="status-bar"
    >
      <span className="font-medium text-gray-600 dark:text-gray-300" data-testid="model-name">
        {formatModelName(modelInfo.model)}
      </span>
      {contextTokens > 0 && (
        <div className="flex items-center gap-2" data-testid="context-meter">
          <span>
            Context: {formatTokenCount(contextTokens)} / {formatTokenCount(modelInfo.contextWindowTokens)}
          </span>
          <div className="w-20 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${colors.bar}`}
              style={{ width: `${percentage}%` }}
              data-testid="context-bar"
            />
          </div>
          <span className={colors.text}>{Math.round(percentage)}%</span>
        </div>
      )}
    </div>
  );
}
