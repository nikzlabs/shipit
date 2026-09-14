/**
 * One API style's client for background work that runs without a harness and
 * without a container (docs/299 req 2). The catalogue decides whether a
 * credential may be called this way and supplies every field below.
 */
export interface DirectCallRequest {
  /** The service's endpoint base; the client appends its style's declared path. */
  baseUrl: string;
  apiModelId: string;
  apiKey: string;
  /** Declared per credential, and override the client's own headers. */
  headers?: Record<string, string>;
  prompt: string;
  maxOutputChars: number;
  signal: AbortSignal;
}

/**
 * Counts are DISJOINT, as `disjointCodexTokens` already requires of harness
 * telemetry: the three input figures never overlap, so a consumer can price
 * each at its own rate. The Messages API reports this shape already; the two
 * OpenAI styles report an input total that INCLUDES its cached portion, and
 * their clients subtract before returning. Pricing rates the three separately,
 * so an overlap is a wrong spend figure rather than a missing one.
 */
export interface DirectCallResult {
  text: string;
  /** Uncached input only. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
}

/** What the provider billed, whether or not it produced a usable answer. */
export type DirectCallUsage = Omit<DirectCallResult, "text">;

export type DirectCall = (req: DirectCallRequest) => Promise<DirectCallResult>;

export class DirectCallError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * The counts the provider reported before the call was judged a failure. A
     * 200 that stops on its output cap, or writes only reasoning, has been
     * billed in full — so the spend travels with the failure instead of
     * vanishing from every total (docs/299 req 7). Absent where the request
     * never reached a response body.
     */
    readonly usage?: DirectCallUsage,
    /**
     * The call may have been billed and no amount can ever be read: these
     * styles report their counts only in a whole response body, and this one
     * was cut off. The run is knowable, its amount is not
     * (docs/299-direct-provider-calls req 7). Distinct from `usage` being
     * absent, which also covers failures nobody was charged for.
     */
    readonly spendUnknown = false,
  ) {
    super(message);
    this.name = "DirectCallError";
  }
}
