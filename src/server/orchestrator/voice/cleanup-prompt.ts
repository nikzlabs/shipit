import { loadPrompt } from "../load-prompt.js";

export const CLEANUP_INSTRUCTIONS = loadPrompt(
  import.meta.url,
  "./cleanup-prompt.md",
);

export function buildCleanupPrompt(rawTranscript: string): string {
  return `${CLEANUP_INSTRUCTIONS}\n\nTranscript:\n${rawTranscript}`;
}
