/** Human-readable display names for known model aliases/IDs. */
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  // Claude CLI aliases
  sonnet: "Sonnet 4.7",
  opus: "Opus 4.7",
  haiku: "Haiku 4.5",
  // Codex model IDs. Display names normalize the ChatGPT backend's
  // inconsistent casing (e.g. "gpt-5.4" → "GPT-5.4").
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.3-codex": "GPT-5.3 Codex",
  "gpt-5.2": "GPT-5.2",
};

/** Known Claude model families that map to CLI aliases. */
const CLAUDE_FAMILIES = ["sonnet", "opus", "haiku"];

/**
 * Resolve a raw model ID to its CLI alias.
 *
 * Handles patterns like:
 *   "claude-sonnet-4-6"          → "sonnet"
 *   "claude-opus-4-20250514"     → "opus"
 *   "claude-haiku-4-5-20251001"  → "haiku"
 *   "sonnet"                     → "sonnet"  (already an alias)
 *   "gpt-5.4"                    → "gpt-5.4" (non-Claude, returned as-is)
 */
export function resolveModelAlias(modelId: string): string {
  // Already an alias
  if (CLAUDE_FAMILIES.includes(modelId)) return modelId;

  // Parse "claude-{family}-..." pattern
  const match = /^claude-(\w+)-/.exec(modelId);
  if (match) {
    const family = match[1].toLowerCase();
    if (CLAUDE_FAMILIES.includes(family)) return family;
  }

  // Non-Claude model — return as-is
  return modelId;
}

/** Convert a model alias or raw model ID to a human-readable display name. */
export function formatModelName(modelId: string): string {
  // Direct lookup
  if (MODEL_DISPLAY_NAMES[modelId]) return MODEL_DISPLAY_NAMES[modelId];
  // Try resolving to alias
  const alias = resolveModelAlias(modelId);
  if (alias !== modelId && MODEL_DISPLAY_NAMES[alias]) return MODEL_DISPLAY_NAMES[alias];
  // Fallback: parse dated IDs like "claude-sonnet-4-20250514" → "Sonnet 4"
  const match = /claude-(\w+)-(\d[\w.]*)/.exec(modelId);
  if (match) {
    const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    const version = match[2].replace(/-\d{8}$/, "");
    return `${family} ${version}`;
  }
  return modelId;
}
