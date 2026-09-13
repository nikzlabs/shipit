import { DirectCallError } from "./types.js";

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

/**
 * An empty answer is a failure, not a short success. Every caller of a direct
 * call wants text, and a run that stops on its output cap, or on a provider's
 * refusal, can return HTTP 200 carrying none — which would otherwise reach the
 * user as a silently blank result.
 */
export function requireText(text: string, label: string, reason?: string): string {
  if (text) return text;
  throw new DirectCallError(502, `${label} returned no text${reason ? ` (${reason})` : ""}`);
}

export async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  label: string,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      signal,
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new DirectCallError(502, `${label} request failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new DirectCallError(res.status, `${label} returned ${res.status}: ${detail.slice(0, 500)}`);
  }
  return await res.json();
}
