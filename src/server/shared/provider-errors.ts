// Provider failures that a later call usually gets past, told apart from auth failures
// (docs/342-transient-provider-retry). Only read on the error text of a failed turn.

const EDGE_BLOCK_PAGE = /attention required!?\s*\|\s*cloudflare/i;
const EDGE_BLOCK_MARKER = /cloudflare|<!doctype html|<html[\s>]/i;

/**
 * A provider's CDN refusing the request with an HTML block page, not an API error. Harnesses
 * can report it as an auth failure, but no sign-in fixes it. `status`, when known, must be 403.
 * Without a status, HTML alone is not enough: it must name Cloudflare.
 */
export function textIndicatesProviderEdgeBlock(text: string, status?: number): boolean {
  if (status !== undefined && status !== 403) return false;
  if (EDGE_BLOCK_PAGE.test(text)) return true;
  if (status === 403) return EDGE_BLOCK_MARKER.test(text);
  return /\b403\b/.test(text) && /cloudflare/i.test(text);
}

export type TransientProviderErrorKind = "edge-block" | "overloaded" | "server-error";

// Anchored at the start, so a failed turn's prose that quotes an error does not match.
// Claude Code: "API Error: 500 {...}", "API Error: Repeated 529 Overloaded errors",
// "Failed to authenticate. API Error: 403 ..."; OpenCode 2 5xx, as its adapter words it.
const API_ERROR_LEAD = /^\s*(?:failed to authenticate\.\s*)?API Error:?\s*(?:repeated\s+)?(\d{3})\b/i;
// OpenCode 2's notice for a block page (its adapter's `edgeBlockMessage`).
const EDGE_BLOCK_NOTICE = /^\s*(?:Anthropic's|The provider's) edge blocked this request\b/;
// Anthropic's error body on its own.
const ANTHROPIC_ERROR_BODY = /^\s*\{[\s\S]*"type"\s*:\s*"(api_error|overloaded_error)"/;
// OpenCode 2 reports the provider's message alone.
const BARE_MESSAGE = /^\s*(overloaded|internal server error|bad gateway|service unavailable|gateway time-?out)\.?\s*$/i;

export function transientProviderErrorKind(text: string | undefined): TransientProviderErrorKind | null {
  if (!text) return null;
  const status = API_ERROR_LEAD.exec(text)?.[1];
  if (status) {
    if (status === "403") return textIndicatesProviderEdgeBlock(text) ? "edge-block" : null;
    if (status === "529") return "overloaded";
    return status.startsWith("5") ? "server-error" : null;
  }
  if (EDGE_BLOCK_NOTICE.test(text)) return "edge-block";
  const type = ANTHROPIC_ERROR_BODY.exec(text)?.[1];
  if (type) return type === "overloaded_error" ? "overloaded" : "server-error";
  const bare = BARE_MESSAGE.exec(text)?.[1];
  if (bare) return bare.toLowerCase() === "overloaded" ? "overloaded" : "server-error";
  return null;
}
