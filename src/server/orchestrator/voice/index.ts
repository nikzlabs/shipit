/**
 * Barrel for the voice provider/cache modules (docs/144).
 */

export * from "./providers/types.js";
export { createWhisperProvider } from "./providers/whisper.js";
export { createOpenAiTtsProvider } from "./providers/openai-tts.js";
export { createClaudeCleanupProvider } from "./providers/claude-cleanup.js";
export { createOpenAiCleanupProvider } from "./providers/openai-cleanup.js";
export { CLEANUP_INSTRUCTIONS, buildCleanupPrompt } from "./cleanup-prompt.js";
export {
  pickCleanupProvider,
  cleanTranscript,
  CLEANUP_TIMEOUT_MS,
  type CleanupResult,
  type CleanupErrorCode,
} from "./cleanup.js";
export { stripForTts } from "./strip-for-tts.js";
export { TtsCache, ttsCacheKey } from "./tts-cache.js";
