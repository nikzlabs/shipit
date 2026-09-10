import type { CanonicalModelKey } from "./model-identity.js";

/** Only "no" blocks attachments; unverified models may receive images. */
export type VisionSupport = "yes" | "no" | "unverified";

// Model-level verdicts: OpenRouter and Vercel model endpoints, 2026-08-23.
// Gateway agreement does not prove that every service transports images correctly.
export const MODEL_VISION: Record<CanonicalModelKey, VisionSupport> = {
  "claude-opus-5": "yes",
  "claude-sonnet-5": "yes",
  "claude-haiku-4.5": "yes",
  "claude-fable-5": "yes",
  "claude-fable-5.1": "yes",

  // Verified from OpenAI's model page and Codex 0.153.2 metadata, 2026-09-04.
  "gpt-6-astra": "yes",
  "gpt-5.6-sol": "yes",
  "gpt-5.6-terra": "yes",
  "gpt-5.6-luna": "yes",
  "gpt-5.5": "yes",
  "gpt-5.4": "yes",
  "gpt-5.4-mini": "yes",
  "gpt-5.3-codex": "yes",
  // Neither gateway carries Spark; sibling capabilities are not evidence for it.
  "gpt-5.3-codex-spark": "unverified",
  "gpt-5.2": "yes",

  "deepseek-v4-flash": "no",
  "deepseek-v4-pro": "no",
  "glm-5.2": "no",
  "glm-5.3": "no",

  // The successor to the row above, and the opposite verdict. The only MEASURED
  // entry in this table: a 16x16 solid-red PNG sent to `deepseek-flash` at
  // DeepSeek's own endpoint came back "Red" (2026-09-10). Both public sources
  // agree, as does the vendor's own table (Vision ✓ here, ✗ for V4 Pro).
  "deepseek-v4.1-flash": "yes",

  "gemini-3.7-flash": "yes",

  "grok-4.6": "yes",
  "grok-4.5": "yes",
  "grok-4.3": "yes",
  "grok-4.20-0309-reasoning": "yes",
  "grok-4.20-0309-non-reasoning": "yes",

  "kimi-k3": "yes",
  "qwen3.8-max": "yes",
  // OpenRouter only.
  "ox-alpha": "yes",
};
