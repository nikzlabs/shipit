/**
 * Cleanup-provider selection + the cleanup runner with sanity checks (docs/144).
 *
 * `pickCleanupProvider()` is the single place provider selection lives:
 *   1. Claude Code OAuth bearer (the common case for ShipIt users).
 *   2. OpenAI voice key (fallback).
 * It gates on a non-null token from `getAccessToken()` rather than the generic
 * `checkCredentials()` boolean, which is also true for API-key-only setups
 * that have no usable OAuth bearer for direct Anthropic calls.
 *
 * `cleanTranscript()` runs the chosen adapter under a 3s timeout and a small
 * sanity check. On ANY failure it returns the raw transcript plus an
 * `errorCode` — the user is never blocked on a flaky cleanup call.
 */

import type { AuthManager } from "../agents/claude/auth-manager.js";
import { createClaudeCleanupProvider } from "./providers/claude-cleanup.js";
import { createOpenAiCleanupProvider } from "./providers/openai-cleanup.js";
import type { CleanupProvider } from "./providers/types.js";

export const CLEANUP_TIMEOUT_MS = 3000;
/** Cleaned output longer than this ratio of the input is treated as garbage. */
const MAX_LENGTH_RATIO = 2;
/** Telltale preambles a misbehaving model emits despite the "output ONLY" rule. */
const PREAMBLE_PATTERNS = [
  /^here(?:'s| is)\b/i,
  /^the cleaned\b/i,
  /^cleaned (?:message|transcript|version)\b/i,
  /^sure[,!]/i,
];

export type CleanupErrorCode =
  | "no-provider"
  | "timeout"
  | "provider-error"
  | "empty-output"
  | "too-long"
  | "preamble";

export interface CleanupResult {
  text: string;
  /** Set when cleanup ran successfully (so the client can show which path ran). */
  cleanupProvider?: CleanupProvider["id"];
  /** Set when cleanup fell through to the raw transcript. */
  cleanupErrorCode?: CleanupErrorCode;
}

/**
 * Resolve the cleanup provider to use, in order of preference. Returns null
 * when neither a Claude OAuth bearer nor an OpenAI key is available.
 */
export async function pickCleanupProvider(
  authManager: AuthManager,
  openaiKey: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<CleanupProvider | null> {
  try {
    const token = await authManager.getAccessToken();
    if (token.token) {
      return createClaudeCleanupProvider(token.token, fetchImpl);
    }
  } catch {
    // Fall through to OpenAI — a broken Claude path must not block cleanup.
  }
  if (openaiKey) {
    return createOpenAiCleanupProvider(openaiKey, fetchImpl);
  }
  return null;
}

function isSane(raw: string, cleaned: string): CleanupErrorCode | null {
  if (!cleaned) return "empty-output";
  if (cleaned.length > Math.max(40, raw.length * MAX_LENGTH_RATIO)) return "too-long";
  if (PREAMBLE_PATTERNS.some((p) => p.test(cleaned))) return "preamble";
  return null;
}

/**
 * Run cleanup with timeout + sanity check, falling through to `raw` on any
 * failure. `provider` is null when none is available (caller passes the
 * result of `pickCleanupProvider`).
 */
export async function cleanTranscript(
  raw: string,
  provider: CleanupProvider | null,
  opts: { language?: string; timeoutMs?: number } = {},
): Promise<CleanupResult> {
  if (!provider) {
    return { text: raw, cleanupErrorCode: "no-provider" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? CLEANUP_TIMEOUT_MS);
  try {
    const cleaned = await provider.clean(raw, {
      signal: controller.signal,
      ...(opts.language ? { language: opts.language } : {}),
    });
    const problem = isSane(raw, cleaned);
    if (problem) {
      return { text: raw, cleanupErrorCode: problem };
    }
    return { text: cleaned, cleanupProvider: provider.id };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { text: raw, cleanupErrorCode: aborted ? "timeout" : "provider-error" };
  } finally {
    clearTimeout(timer);
  }
}
