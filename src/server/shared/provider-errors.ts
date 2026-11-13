// Provider failures that a later call usually gets past, told apart from auth failures
// (docs/342-transient-provider-retry). Only read on the error text of a failed turn.

const EDGE_BLOCK_PAGE = /attention required!?\s*\|\s*cloudflare/i;
const EDGE_BLOCK_MARKER = /cloudflare|<!doctype html|<html[\s>]/i;

/**
 * A provider's CDN refusing the request with an HTML block page, not an API error. Harnesses
 * can report it as an auth failure, but no sign-in fixes it. `status`, when known, must be 403.
 */
export function textIndicatesProviderEdgeBlock(text: string, status?: number): boolean {
  if (status !== undefined && status !== 403) return false;
  if (EDGE_BLOCK_PAGE.test(text)) return true;
  return (status === 403 || /\b403\b/.test(text)) && EDGE_BLOCK_MARKER.test(text);
}

export type TransientProviderErrorKind = "edge-block" | "overloaded" | "server-error";

// Claude Code: "API Error: 500 {...}", "API Error: Repeated 529 Overloaded errors".
const API_ERROR_STATUS = /\bAPI Error:?\s*(?:repeated\s+)?(5\d\d)\b/i;
// Anthropic's error body, as a harness passes it through.
const ANTHROPIC_ERROR_TYPE = /"type"\s*:\s*"(api_error|overloaded_error)"/;
// OpenCode 2 reports the provider's message alone.
const BARE_MESSAGE = /^\s*(overloaded|internal server error|bad gateway|service unavailable|gateway time-?out)\.?\s*$/i;

export function transientProviderErrorKind(text: string | undefined): TransientProviderErrorKind | null {
  if (!text) return null;
  if (textIndicatesProviderEdgeBlock(text)) return "edge-block";
  const status = API_ERROR_STATUS.exec(text)?.[1];
  if (status) return status === "529" ? "overloaded" : "server-error";
  const type = ANTHROPIC_ERROR_TYPE.exec(text)?.[1];
  if (type) return type === "overloaded_error" ? "overloaded" : "server-error";
  const bare = BARE_MESSAGE.exec(text)?.[1];
  if (bare) return bare.toLowerCase() === "overloaded" ? "overloaded" : "server-error";
  return null;
}
