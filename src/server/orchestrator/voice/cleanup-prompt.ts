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
 */

export const CLEANUP_INSTRUCTIONS = `You are cleaning up a voice transcription of a chat message a developer is about to send to a coding assistant. Return the same message, preserving meaning exactly:

- Fix obvious transcription mis-hearings (homophones, mangled proper nouns, mis-cased technical terms like "React useEffect").
- Remove disfluencies and filler words ("um", "uh", "you know", "like" used as filler, repeated false starts).
- Fix capitalisation and basic punctuation.
- Preserve the speaker's wording, tone, and intent. Do NOT rephrase, shorten, expand, summarise, answer, or comment on the message.
- If you are unsure whether a word is a mis-hearing or intentional, keep the original word.
- Output ONLY the cleaned message. No preamble, no quotes, no explanation.`;

/** Build the full prompt (instructions + transcript) sent as the user turn. */
export function buildCleanupPrompt(rawTranscript: string): string {
  return `${CLEANUP_INSTRUCTIONS}\n\nTranscript:\n${rawTranscript}`;
}
