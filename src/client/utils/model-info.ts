

export interface ModelInfo {
  model: string;
  contextWindowTokens: number;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

export type ContextLevel = "green" | "yellow" | "orange" | "red";

export function getContextLevel(percentage: number): ContextLevel {
  if (percentage >= 90) return "red";
  if (percentage >= 80) return "orange";
  if (percentage >= 60) return "yellow";
  return "green";
}
