/**
 * Per-model context window lookup. Split out of `agent-registry.ts` so the
 * client can import it without dragging `node:child_process` (and the rest of
 * the agent-detection machinery) into the browser bundle.
 *
 * The runtime registry in `agent-registry.ts` re-exports these so existing
 * server-side imports keep working unchanged.
 */

/**
 * Default context window in tokens, used when a model is not in
 * `MODEL_CONTEXT_WINDOWS` or when no model is yet known. Equal to the
 * Claude Sonnet/Opus/Haiku 4.x window, which is the most common case.
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * Per-model context window sizes in tokens. Keys are matched first as exact
 * names, then by substring (so e.g. "claude-sonnet-4-20250514" matches
 * "sonnet"). Models not listed fall back to `DEFAULT_CONTEXT_WINDOW_TOKENS`.
 *
 * This is the STATIC fallback. The Claude CLI itself reports the authoritative
 * window in `result.modelUsage.<model>.contextWindow`; the adapter plumbs that
 * through `AgentResultEvent.contextWindow`, and `agent-listeners.ts` re-emits
 * `model_info` with that value so the dial updates dynamically. The static
 * map is only consulted before the first turn completes (when only the model
 * name is known) or for adapters that can't surface the field.
 *
 * Add entries here when a model with a different context window is added to
 * the agent registry, OR when ShipIt needs to show the correct window on the
 * first frame (before the first `result` event arrives).
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Claude — 200K is the default. Specific keys override the substring
  // fallback so "claude-opus-4-8" resolves to its real 1M window even before
  // the first `result` event populates `modelUsage.contextWindow`.
  "sonnet": 200_000,
  "claude-sonnet": 200_000,
  "claude-opus-4-8": 1_000_000,
  "haiku": 200_000,
  "claude-haiku": 200_000,
  "opus-1m": 1_000_000,
  // Codex / GPT-5 family (272K). Values verified against the ChatGPT
  // `/backend-api/codex/models` endpoint — all currently-listed codex
  // models advertise a `context_window` of 272000 tokens. Keep the bare
  // `gpt-5` substring fallback for forward compatibility with future
  // gpt-5.x.
  "gpt-5": 272_000,
  "gpt-5.5": 272_000,
  "gpt-5.4": 272_000,
  "gpt-5.4-mini": 272_000,
  "gpt-5.3-codex": 272_000,
  "gpt-5.2": 272_000,
};

/**
 * Resolve a context window size for a model identifier.
 *
 * Match order:
 *   1. Exact key in `MODEL_CONTEXT_WINDOWS`.
 *   2. Substring match against any key (longest key wins, so "gpt-5.4-mini"
 *      beats "gpt-5" when both match).
 *   3. `DEFAULT_CONTEXT_WINDOW_TOKENS` fallback.
 */
export function getContextWindowForModel(model: string | undefined): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW_TOKENS;
  const exact = MODEL_CONTEXT_WINDOWS[model];
  if (exact) return exact;
  let bestKey: string | null = null;
  for (const key of Object.keys(MODEL_CONTEXT_WINDOWS)) {
    if (model.includes(key) && (bestKey === null || key.length > bestKey.length)) {
      bestKey = key;
    }
  }
  return bestKey ? MODEL_CONTEXT_WINDOWS[bestKey] : DEFAULT_CONTEXT_WINDOW_TOKENS;
}
