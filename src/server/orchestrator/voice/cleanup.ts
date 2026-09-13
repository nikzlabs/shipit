import { createOpenAiCleanupProvider } from "./providers/openai-cleanup.js";
import type { CleanupProvider } from "./providers/types.js";

export const CLEANUP_TIMEOUT_MS = 3000;
const MAX_LENGTH_RATIO = 2;
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
  cleanupProvider?: CleanupProvider["id"];
  cleanupErrorCode?: CleanupErrorCode;
}

// The OpenAI voice key is the only credential cleanup may use: a subscription
// OAuth token may not be used to call its provider's API
// (docs/299-direct-provider-calls req 1).
export function pickCleanupProvider(
  openaiKey: string | null,
  fetchImpl: typeof fetch = fetch,
): CleanupProvider | null {
  return openaiKey ? createOpenAiCleanupProvider(openaiKey, fetchImpl) : null;
}

function isSane(raw: string, cleaned: string): CleanupErrorCode | null {
  if (!cleaned) return "empty-output";
  if (cleaned.length > Math.max(40, raw.length * MAX_LENGTH_RATIO)) return "too-long";
  if (PREAMBLE_PATTERNS.some((p) => p.test(cleaned))) return "preamble";
  return null;
}

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
