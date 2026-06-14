/**
 * Coding vocabulary used to bias the speech-recognition step (docs/144).
 *
 * The LLM cleanup pass (cleanup-prompt.ts) fixes mis-hearings after the fact,
 * but it can only work with the words STT actually emits — if Whisper hears
 * "APR" or "dogs", cleanup has nothing to map back from. Biasing the STT step
 * toward this vocabulary nudges the recognizer to produce the right tokens in
 * the first place. The context is always software development, so the term
 * list is unconditional.
 *
 * Keep this aligned with the canonical terms called out in CLEANUP_INSTRUCTIONS
 * — the two layers reinforce the same vocabulary.
 */

/** Canonical coding terms STT commonly mangles, in the casing we want back. */
export const CODING_VOCABULARY: readonly string[] = [
  // Acronyms / initialisms
  "PR",
  "pull request",
  "API",
  "UI",
  "CLI",
  "SDK",
  "ID",
  "URL",
  "JSON",
  "SQL",
  "CSS",
  "HTML",
  "npm",
  "CI",
  "OAuth",
  "regex",
  "env",
  // Spoken shorthand
  "repo",
  "async",
  "auth",
  "config",
  "param",
  "params",
  "deps",
  "middleware",
  "endpoint",
  "commit",
  "merge",
  "rebase",
  "branch",
  "diff",
  "stack trace",
  // Libraries / frameworks / tools
  "React",
  "Node",
  "TypeScript",
  "Postgres",
  "Redis",
  "Docker",
  "Kubernetes",
  "GitHub",
  "Vite",
  "Tailwind",
  "Zustand",
  "Fastify",
  // Coding assistants / AI tools
  "Claude",
  "Claude Code",
  "Anthropic",
  "Codex",
  "Opus",
  "Sonnet",
  "Haiku",
  "GPT",
  "OpenAI",
  "ShipIt",
];

/**
 * Whisper biases toward terms that appear in its `prompt` parameter — a free
 * text hint (~224 tokens max) it treats as prior context. A comma-joined term
 * list nudges spelling and casing without constraining the output.
 */
export const WHISPER_BIAS_PROMPT = CODING_VOCABULARY.join(", ");

/**
 * Deepgram's keyword boosting (`keywords` on nova-2) takes single tokens with
 * an optional `:intensifier`. Multi-word phrases aren't boosted as a unit, so
 * we split them into their component words and de-duplicate. The `:2` boost is
 * a moderate nudge — high enough to favor the term, low enough to avoid
 * hallucinating it into unrelated audio.
 */
export const DEEPGRAM_KEYWORDS: readonly string[] = Array.from(
  new Set(CODING_VOCABULARY.flatMap((term) => term.split(/\s+/))),
);
