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

export const CLEANUP_INSTRUCTIONS = `You are cleaning up a voice transcription of a chat message a developer is about to send to a coding assistant. The speaker is talking about software, so the transcript is dense with programming jargon, tool names, and acronyms that generic speech-to-text mangles. Return the same message, preserving meaning exactly:

- Fix obvious transcription mis-hearings (homophones, mangled proper nouns, mis-cased technical terms like "React useEffect").
- The context is always software development — assume it. Resolve words to their coding meaning; the speaker means the software term, not the everyday homophone:
  - Spelled-out acronyms and initialisms should be the uppercase acronym, kept as the developer would write it: "a PR" / "pee arr" → "a PR" (pull request, two letters — never "APR" or "per"); "the API" → "the API"; "a UI" → "a UI"; "the CLI", "the SDK", "an ID", "the URL", "JSON" ("Jason" → "JSON"), "SQL", "CSS", "HTML", "npm", "CI", "OAuth", "regex", "env".
  - Common spoken shorthand expands to the developer's word, not a soundalike: "docs" → "docs" (documents/documentation, never "dogs"); "repo" → "repo" (not "reppost" or "ripple"); "async", "auth", "config", "param(s)", "dependency"/"deps", "middleware", "endpoint", "commit", "merge", "rebase", "branch", "diff", "stack trace".
  - Library, framework, and tool names keep their canonical casing: React, Node, npm, TypeScript, Postgres, Redis, Docker, Kubernetes ("kubernetes"/"k8s"), GitHub, Vite, Tailwind, Zustand, Fastify.
  - Coding-assistant and AI tool names keep their casing too — the speaker is dictating to one: Claude ("clawed"/"cloud" in an AI context → "Claude"), Claude Code, Anthropic, Codex ("codecs"/"codex" → "Codex"), Opus, Sonnet, Haiku, GPT, OpenAI.
  - Code-ish identifiers stay as identifiers: function/variable/file names, flags ("--force"), and paths ("src/server"). Do not split or "correct" camelCase, snake_case, or kebab-case (e.g. "useEffect", "session_id", "cleanup-prompt").
- Remove disfluencies and filler words ("um", "uh", "you know", "like" used as filler, repeated false starts).
- Fix capitalisation and basic punctuation.
- Preserve the speaker's wording, tone, and intent. Do NOT rephrase, shorten, expand, summarise, answer, or comment on the message. Resolving a mis-hearing to the right technical term is allowed and expected; rewriting otherwise-correct words is not.
- If you are unsure whether a word is a mis-hearing or intentional, keep the original word.
- Output ONLY the cleaned message. No preamble, no quotes, no explanation.`;

/** Build the full prompt (instructions + transcript) sent as the user turn. */
export function buildCleanupPrompt(rawTranscript: string): string {
  return `${CLEANUP_INSTRUCTIONS}\n\nTranscript:\n${rawTranscript}`;
}
