export interface ModelInfo {
  model: string;
  contextWindowTokens: number;
}

interface StatusBarProps {
  modelInfo: ModelInfo | null;
  contextTokens: number;
  agentName?: string;
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
  green: { bar: "bg-(--color-context-ok)", text: "text-(--color-context-ok)" },
  yellow: { bar: "bg-(--color-context-mid)", text: "text-(--color-context-mid)" },
  orange: { bar: "bg-(--color-context-high)", text: "text-(--color-context-high)" },
  red: { bar: "bg-(--color-context-full)", text: "text-(--color-context-full)" },
};

export function StatusBar({ modelInfo, contextTokens, agentName }: StatusBarProps) {
  if (!modelInfo) return null;

  const percentage = modelInfo.contextWindowTokens > 0
    ? Math.min(100, (contextTokens / modelInfo.contextWindowTokens) * 100)
    : 0;
  const level = getContextLevel(percentage);
  const colors = levelColors[level];

  return (
    <div
      className="flex items-center gap-3 px-4 py-1 border-t border-(--color-border-primary) text-xs text-(--color-text-secondary)"
      data-testid="status-bar"
    >
      {agentName && agentName !== "Claude Code" && (
        <>
          <span className="font-medium text-(--color-text-primary)" data-testid="agent-name">
            {agentName}
          </span>
          <span className="text-(--color-text-tertiary)">/</span>
        </>
      )}
      <span className="font-medium text-(--color-text-primary)" data-testid="model-name">
        {formatModelName(modelInfo.model)}
      </span>
      {contextTokens > 0 && (
        <div className="flex items-center gap-2" data-testid="context-meter">
          <span>
            Context: {formatTokenCount(contextTokens)} / {formatTokenCount(modelInfo.contextWindowTokens)}
          </span>
          <div className="w-20 h-1.5 bg-(--color-bg-tertiary) rounded-full overflow-hidden">
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
