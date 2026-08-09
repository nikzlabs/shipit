/**
 * docs/252 / planning#341 — Codex's token counts, normalized to ShipIt's
 * disjoint convention, in a module **either side of the container boundary may
 * import**.
 *
 * Codex reports the same overlapping figures from two surfaces, and ShipIt now
 * reads both:
 *
 *  - the **app server**, which the session-side adapter drives over JSON-RPC
 *    (`thread/tokenUsage/updated`, camelCase keys);
 *  - **`codex exec --json`**, which the orchestrator's own naming shell-out
 *    reads as JSONL (`turn.completed`, snake_case keys).
 *
 * Both say the same thing in different words, and the thing they say is a trap:
 * **`input_tokens` INCLUDES the cached ones.** Measured against codex-cli
 * 0.146.0 driving a local Responses recorder — fed `input_tokens: 1000` with
 * `cached_tokens: 800`, both surfaces report 1000 and 800 unchanged. Claude's
 * classes are disjoint, so ShipIt's pricing code assumes disjointness; left
 * overlapping, `input × inputRate + cacheRead × cacheReadRate` charges every
 * cached token twice, at the dearer rate, on every Codex run. The rates always
 * apply here — Codex reports no dollar figure of its own — so there is no
 * harness-reported total to mask the error.
 *
 * The subtraction lives here rather than at each boundary for the reason
 * `spawn-routing.ts` gives for its own move: a second implementation is how the
 * two boundaries end up disagreeing. A reader downstream of either should never
 * re-derive it.
 */

/**
 * What Codex reported, key-normalized by the caller that read it.
 *
 * Deliberately not either surface's own shape: the app server sends
 * `cachedInputTokens` and `codex exec --json` sends `cached_input_tokens`, and
 * the mapping from wire keys to these is the one part that genuinely differs
 * per surface. The arithmetic below is the part that must not.
 */
export interface CodexReportedTokens {
  /** Total input, **including** the cached portion. */
  inputTokens?: number | undefined;
  /** Total output. Includes reasoning tokens, which Codex also reports separately. */
  outputTokens?: number | undefined;
  /** The cached portion of `inputTokens`. */
  cachedInputTokens?: number | undefined;
  cacheWriteInputTokens?: number | undefined;
}

/** ShipIt's convention: the four classes never overlap. */
export interface DisjointTokens {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * Split Codex's overlapping counts into ShipIt's disjoint classes.
 *
 * `undefined` in, `undefined` out — a run that reported no usage block reported
 * nothing, which the callers must keep distinct from a run that consumed zero
 * (an all-zero row prices to $0 through the rates, asserting "this was free").
 *
 * `Math.max(0, …)` because a future app server that reports the classes
 * disjointly would otherwise go negative rather than merely double-counting.
 */
export function disjointCodexTokens(
  reported: CodexReportedTokens | undefined,
): DisjointTokens | undefined {
  if (!reported) return undefined;
  return {
    input: Math.max(0, (reported.inputTokens ?? 0) - (reported.cachedInputTokens ?? 0)),
    output: reported.outputTokens ?? 0,
    cacheRead: reported.cachedInputTokens,
    ...(reported.cacheWriteInputTokens !== undefined
      ? { cacheWrite: reported.cacheWriteInputTokens }
      : {}),
  };
}
