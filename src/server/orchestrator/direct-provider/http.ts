import { DirectCallError, type DirectCallUsage } from "./types.js";

/**
 * Deliberately generous on the text itself: at roughly four characters per
 * token, a third of the character budget leaves headroom for a tokenizer that
 * splits the caller's language harder than English.
 *
 * `reasoningAllowance` is for a style that bills reasoning against this same
 * cap, where a text-sized budget can be spent before any answer is written.
 */
export function maxOutputTokens(maxOutputChars: number, reasoningAllowance = 0): number {
  return Math.max(64, Math.ceil(maxOutputChars / 3)) + reasoningAllowance;
}

/** Never negative, and never overlapping: see DirectCallResult. */
export function uncachedInput(
  total: number | undefined,
  cacheRead: number | undefined,
  cacheWrite: number | undefined,
): number | undefined {
  if (total === undefined) return undefined;
  return Math.max(0, total - (cacheRead ?? 0) - (cacheWrite ?? 0));
}

/** `openai-responses` reports this as a status it already rejects on its own. */
const OUTPUT_LIMIT_STOPS = new Set(["max_tokens", "length"]);

/**
 * An answer that stopped short is a failure, not a short success, and both ways
 * of stopping arrive as HTTP 200. An EMPTY answer would reach the user blank; a
 * PARTIAL one is worse, being indistinguishable from a complete answer — a
 * voice transcript cleaned this way is replaced by its own opening clause with
 * nothing to say so (docs/299-direct-provider-calls req 6). Asking for a budget
 * wide enough that the cap cannot bite is not a substitute: the provider's own
 * limit can be lower than ours, and only the provider says which one stopped it.
 */
export function requireCompleteText(
  text: string,
  label: string,
  reason?: string,
  // It was still billed, so the counts ride on the error rather than vanishing.
  usage?: DirectCallUsage,
): string {
  if (reason && OUTPUT_LIMIT_STOPS.has(reason)) {
    throw new DirectCallError(502, `${label} ran out of output budget (${reason})`, usage);
  }
  if (text) return text;
  throw new DirectCallError(502, `${label} returned no text${reason ? ` (${reason})` : ""}`, usage);
}

export async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  label: string,
): Promise<unknown> {
  // Read before the send: a signal that had already fired reached no transport
  // at all, so that failure is not a run.
  const abortedBeforeSend = signal.aborted;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      signal,
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Cancelled after the request was handed to the transport. Whether it ever
    // reached the provider is NOT observable through `fetch` — measured: an
    // abort landing during connect sends nothing and looks identical here. So
    // this over-reports rather than under-reports, deliberately: counting a run
    // that may have cost nothing misstates no money, while dropping one erases
    // money that was spent (docs/299-direct-provider-calls req 7).
    throw new DirectCallError(
      502,
      `${label} request failed: ${(err as Error).message}`,
      undefined,
      signal.aborted && !abortedBeforeSend,
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new DirectCallError(res.status, `${label} returned ${res.status}: ${detail.slice(0, 500)}`);
  }
  try {
    return await res.json();
  } catch (err) {
    // The provider answered 200, so it ran the model. A body lost part-way —
    // an abort, or a dropped socket — was billed with its counts among the
    // bytes that never arrived, and the ones that did are unreadable. Measured:
    // that fails as a TypeError, while a SyntaxError means the whole body did
    // arrive and simply was not JSON, which no model wrote.
    throw new DirectCallError(
      502,
      `${label} returned an unreadable body: ${(err as Error).message}`,
      undefined,
      !(err instanceof SyntaxError),
    );
  }
}
