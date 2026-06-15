/**
 * The locked transcript-cleanup prompt (docs/144).
 *
 * Single source of truth used by BOTH cleanup adapters (Claude OAuth and
 * OpenAI) and by the tests. Changes go through PR review — the prompt must
 * not be tuned per-provider, or Claude and OpenAI cleanup would diverge
 * (open question #9 in the plan).
 *
 * The "do NOT rephrase / answer" lines are load-bearing: cleanup must not
 * slip into agent-like behavior. A transcript shaped like a question must
 * come back as the same question, not as an answer to it.
 *
 * The prompt text lives in `cleanup-prompt.md` next to this file (see
 * CLAUDE.md › "Prompts").
 */

import { loadPrompt } from "../load-prompt.js";

export const CLEANUP_INSTRUCTIONS = loadPrompt(
  import.meta.url,
  "./cleanup-prompt.md",
);

/** Build the full prompt (instructions + transcript) sent as the user turn. */
export function buildCleanupPrompt(rawTranscript: string): string {
  return `${CLEANUP_INSTRUCTIONS}\n\nTranscript:\n${rawTranscript}`;
}
