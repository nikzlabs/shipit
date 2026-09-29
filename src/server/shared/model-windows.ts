import { catalogueContextWindows } from "./catalogue/index.js";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

// Aliases and retired IDs only; current model windows belong in the catalogue.
const LEGACY_CONTEXT_WINDOWS: Record<string, number> = {
  "sonnet": 1_000_000,
  "claude-sonnet": 200_000,
  "claude-opus-4-8": 1_000_000,
  "claude-haiku": 200_000,
  "opus-1m": 1_000_000,
  "gpt-5": 272_000,
  "gpt-5.6": 272_000,
};

// Runtime telemetry supersedes these initial estimates. Read per call: the
// model list can change while the process runs (docs/318).
export function modelContextWindows(): Record<string, number> {
  return { ...LEGACY_CONTEXT_WINDOWS, ...catalogueContextWindows() };
}

export function getContextWindowForModel(model: string | undefined): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW_TOKENS;
  const windows = modelContextWindows();
  const exact = windows[model];
  if (exact) return exact;
  let bestKey: string | null = null;
  for (const key of Object.keys(windows)) {
    if (model.includes(key) && (bestKey === null || key.length > bestKey.length)) {
      bestKey = key;
    }
  }
  return bestKey ? windows[bestKey] : DEFAULT_CONTEXT_WINDOW_TOKENS;
}
