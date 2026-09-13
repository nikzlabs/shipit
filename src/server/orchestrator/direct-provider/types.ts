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
 * Cache reads and cache writes are counted separately because pricing rates
 * them separately (`shared/codex-token-usage.ts`); folding either into
 * inputTokens produces a wrong spend figure rather than a missing one.
 */
export interface DirectCallResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
}

export type DirectCall = (req: DirectCallRequest) => Promise<DirectCallResult>;

export class DirectCallError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DirectCallError";
  }
}
