/**
 * Server-side voice provider registry (docs/144).
 *
 * Maps a provider id to its STT/TTS adapter factories and the content type its
 * TTS bytes carry. The service layer dispatches through here instead of
 * hardcoding OpenAI, so adding a provider is: write the adapter, add a catalog
 * entry (src/server/shared/voice-catalog.ts), and register the factory here.
 *
 * Cleanup providers are NOT in this registry — cleanup selection has its own
 * precedence logic (Claude OAuth bearer → OpenAI key) in cleanup.ts.
 */

import type { SttProvider, TtsProvider } from "./providers/types.js";
import { createWhisperProvider } from "./providers/whisper.js";
import { createOpenAiTtsProvider } from "./providers/openai-tts.js";
import { createElevenLabsTtsProvider } from "./providers/elevenlabs-tts.js";
import { createDeepgramProvider } from "./providers/deepgram.js";

interface VoiceProviderAdapters {
  createStt?: (apiKey: string, fetchImpl?: typeof fetch) => SttProvider;
  createTts?: (apiKey: string, fetchImpl?: typeof fetch) => TtsProvider;
  /** MIME type of the TTS byte stream (used for the response Content-Type). */
  ttsContentType?: string;
}

const REGISTRY: Record<string, VoiceProviderAdapters> = {
  openai: {
    createStt: createWhisperProvider,
    createTts: createOpenAiTtsProvider,
    ttsContentType: "audio/mpeg",
  },
  elevenlabs: {
    createTts: createElevenLabsTtsProvider,
    ttsContentType: "audio/mpeg",
  },
  deepgram: {
    createStt: createDeepgramProvider,
  },
};

export function getVoiceAdapters(providerId: string): VoiceProviderAdapters | undefined {
  return REGISTRY[providerId];
}
