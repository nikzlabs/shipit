export interface CodexReportedTokens {
  /** Includes both cache portions. */
  inputTokens?: number | undefined;
  /** Includes reasoning tokens. */
  outputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  cacheWriteInputTokens?: number | undefined;
}

export interface DisjointTokens {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Missing usage stays undefined; a zero row would incorrectly assert a free run. */
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

function totalOf(tokens: DisjointTokens): number {
  return tokens.input + tokens.output + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0);
}

/** Codex totals survive thread resume. A reduced total means the accumulator reset. */
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
