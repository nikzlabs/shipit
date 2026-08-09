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
 * **`input_tokens` is the TOTAL, and both cache figures are details of it.**
 * Measured against codex-cli 0.146.0 driving a local Responses recorder — fed
 * `input_tokens: 1000` with `input_tokens_details: {cached_tokens: 800,
 * cache_write_tokens: 50}`, it reports `input_tokens: 1000,
 * cached_input_tokens: 800, cache_write_input_tokens: 50`, the total passed
 * through untouched.
 *
 * Claude's classes are disjoint, so ShipIt's pricing code assumes disjointness
 * and `costFromRates` charges each class its own **replacement** rate — the
 * catalogue's `cacheWrite` is "1.25× the uncached input rate" for OpenAI and
 * literally `=== input` for DeepSeek and GLM, i.e. what those tokens cost
 * *instead of* the ordinary rate, never a surcharge on top of it
 * (`catalogue/services.ts`). So **both** details come out of the input total.
 * Subtract only the cached one and every cache-write token is charged twice,
 * at the ordinary rate and again at the write rate; subtract neither and every
 * cached token is charged twice, at the dearer rate. Codex reports no dollar
 * figure of its own, so the rates always apply here and there is no
 * harness-reported total to mask either error.
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
  /** Total input, **including** both the cached and the cache-written portions. */
  inputTokens?: number | undefined;
  /** Total output. Includes reasoning tokens, which Codex also reports separately. */
  outputTokens?: number | undefined;
  /** The cached portion of `inputTokens`. */
  cachedInputTokens?: number | undefined;
  /** The portion of `inputTokens` written to the cache — also inside the total. */
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
 * **Reported nothing and consumed zero are different facts, and this returns
 * `undefined` for the first.** An all-zero row prices to $0 through the
 * catalogue's rates and thereby asserts the run was free — a wrong number
 * rather than a missing one, which is the trap the whole cost rule is written
 * to avoid. So an absent usage block and a present-but-empty one (`{}`, every
 * field non-numeric) both mean "nothing was reported"; only a block carrying at
 * least one real figure becomes a row.
 *
 * `Math.max(0, …)` because a provider that reports the details as additions
 * rather than as portions of the total would otherwise go negative — a credit
 * on the bill, which is worse than the double-count it guards against.
 */
export function disjointCodexTokens(
  reported: CodexReportedTokens | undefined,
): DisjointTokens | undefined {
  if (!reported) return undefined;
  const { inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens } = reported;
  const reportedSomething = [inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens]
    .some((v) => typeof v === "number");
  if (!reportedSomething) return undefined;
  return {
    input: Math.max(0, (inputTokens ?? 0) - (cachedInputTokens ?? 0) - (cacheWriteInputTokens ?? 0)),
    output: outputTokens ?? 0,
    cacheRead: cachedInputTokens,
    ...(cacheWriteInputTokens !== undefined ? { cacheWrite: cacheWriteInputTokens } : {}),
  };
}
