/**
 * Information about the agent's active model — name and context window size.
 * Sourced from the agent CLI via the orchestrator and consumed by status,
 * usage, and selector components.
 */
export interface ModelInfo {
  model: string;
  contextWindowTokens: number;
}

/** Format a token count as a compact string (e.g. 42180 -> "42.2K"). */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

export type ContextLevel = "green" | "yellow" | "orange" | "red";

/** Get the color level for a context usage percentage. */
export function getContextLevel(percentage: number): ContextLevel {
  if (percentage >= 90) return "red";
  if (percentage >= 80) return "orange";
  if (percentage >= 60) return "yellow";
  return "green";
}
