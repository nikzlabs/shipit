/**
 * Per-model context window lookup. Split out of `agent-registry.ts` so the
 * client can import it without dragging `node:child_process` (and the rest of
 * the agent-detection machinery) into the browser bundle.
 *
 * The runtime registry in `agent-registry.ts` re-exports these so existing
 * server-side imports keep working unchanged.
 */

import { catalogueContextWindows } from "./catalogue/index.js";

/**
 * Default context window in tokens, used when a model is not in
 * `MODEL_CONTEXT_WINDOWS` or when no model is yet known. Equal to the
 * Claude Sonnet/Opus/Haiku 4.x window, which is the most common case.
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * Keys that are NOT catalogue model ids: CLI aliases and family prefixes that
 * exist purely for the substring fallback, plus ids ShipIt no longer offers but
 * old sessions still display.
 *
 * docs/252 phase 1 — every *current* model's window now comes from the service
 * catalogue (`ModelDef.contextWindow`), which is the single place a model is
 * declared. This map holds only what the catalogue has no row for, so the two
 * cannot state different windows for the same model.
 */
const LEGACY_CONTEXT_WINDOWS: Record<string, number> = {
  // Claude — 200K is the default. Specific keys override the substring
  // fallback so "claude-opus-4-8" resolves to its real 1M window even before
  // the first `result` event populates `modelUsage.contextWindow`.
  "sonnet": 1_000_000,
  "claude-sonnet": 200_000,
  // claude-opus-4-8 stays for sessions created before the Opus 5 default swap.
  "claude-opus-4-8": 1_000_000,
  // Same reason: Fable 5.1 replaced Fable 5 in the catalogue on 2026-09-01, so
  // the bare `claude-fable-5` id no longer has a row to derive a window from —
  // and without a key here it falls through the substring pass to the 200K
  // default, quietly showing a wrong number on the dial of every session still
  // pinned to it. (`anthropic/claude-fable-5` needs no key: Vercel still offers
  // it, so the catalogue still declares its window.)
  "claude-fable-5": 1_000_000,
  "claude-haiku": 200_000,
  "opus-1m": 1_000_000,
  // Codex / GPT-5 family. Use Codex's context window rather than the model's
  // larger API-advertised maximum: ShipIt runs these models through Codex,
  // whose app-server assigns and reports a 272K window. Runtime telemetry can
  // still replace this first-frame fallback when a profile reports another
  // effective window.
  // The legacy unsuffixed `gpt-5.6` key is retained for old session/history
  // display only; Codex selection now uses the explicit `gpt-5.6-sol` slug.
  "gpt-5": 272_000,
  "gpt-5.6": 272_000,
};

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
 * To add a window for a model ShipIt offers, add the model to the **catalogue**
 * (`catalogue/services.ts`) — `contextWindow` is a required field there, so a
 * new row cannot ship without one. `LEGACY_CONTEXT_WINDOWS` above is only for
 * aliases and retired ids the catalogue has no row for.
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  ...LEGACY_CONTEXT_WINDOWS,
  ...catalogueContextWindows(),
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
