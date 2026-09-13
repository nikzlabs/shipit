import { DirectCallError } from "./types.js";

/**
 * Deliberately generous: at roughly four characters per token, a third of the
 * character budget leaves headroom, so the cap never truncates an answer the
 * caller would have accepted. A slow run is bounded by the caller's deadline.
 */
export function maxOutputTokens(maxOutputChars: number): number {
  return Math.max(64, Math.ceil(maxOutputChars / 3));
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
