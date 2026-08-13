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
 *
 * The second trap is `total` itself: it is the running rollup for the whole
 * THREAD, not for the turn. `codexTurnTokens` is what turns one into the other;
 * see its own doc. `disjointCodexTokens` stays the plain split, because the
 * orchestrator's `codex exec --json` reader is a ONE-SHOT — its thread is one
 * turn long, so its rollup already is that turn's.
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

/** Every class of a disjoint row, added up. */
function totalOf(tokens: DisjointTokens): number {
  return tokens.input + tokens.output + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0);
}

/**
 * planning#367 — ONE TURN's tokens, from the app-server's CUMULATIVE thread
 * rollup and the rollup as it stood before the turn began.
 *
 * `thread/tokenUsage/updated`'s `total` accumulates over the whole thread, and
 * `thread/resume` RESTORES the accumulator from the rollout file — which lives
 * in `~/.codex`, a persistent volume — so it never resets for the life of a
 * ShipIt session. Recording it as the turn's own tokens made every
 * `SUM(usage_turns)` a sum of running totals: `sum(C_i)` where the true figure
 * is `C_N`, i.e. roughly `(N+1)/2 ×` for flat turns and worse for growing ones.
 * Measured against `@openai/codex` 0.146.0 driving a local Responses recorder
 * that returns identical usage every call, one process per turn plus
 * `thread/resume` (ShipIt's own model): `total.inputTokens` went 1000 → 2000 →
 * 3000 while `last.inputTokens` stayed 1000.
 *
 * This is the token half of the conversion `UsageManager.record` already does
 * for a cumulative COST, and it follows the same two rules:
 *
 *  - **`max(0, …)` per class**, so a rollup that somehow shrank in one class
 *    cannot post a credit against the others;
 *  - **a shrunken rollup is a new baseline, not a negative turn** — when the
 *    current total is below the baseline the accumulator restarted (a fresh or
 *    reset thread), and `current` is itself the turn's usage. Collapsing that to
 *    zeros would assert the turn was free, which is the wrong-number trap
 *    `disjointCodexTokens` is written to avoid.
 *
 * No baseline (the first turn of a thread, and every one-shot run) means the
 * rollup already is the turn's own.
 */
export function codexTurnTokens(
  cumulative: CodexReportedTokens | undefined,
  baseline: CodexReportedTokens | undefined,
): DisjointTokens | undefined {
  const current = disjointCodexTokens(cumulative);
  if (!current) return undefined;
  const before = disjointCodexTokens(baseline);
  if (!before || totalOf(current) < totalOf(before)) return current;
  return {
    input: Math.max(0, current.input - before.input),
    output: Math.max(0, current.output - before.output),
    cacheRead: current.cacheRead === undefined
      ? undefined
      : Math.max(0, current.cacheRead - (before.cacheRead ?? 0)),
    ...(current.cacheWrite !== undefined
      ? { cacheWrite: Math.max(0, current.cacheWrite - (before.cacheWrite ?? 0)) }
      : {}),
  };
}
