import type { SttProvider, TtsProvider } from "./providers/types.js";
import { createWhisperProvider } from "./providers/whisper.js";
import { createOpenAiTtsProvider } from "./providers/openai-tts.js";
import { createElevenLabsTtsProvider } from "./providers/elevenlabs-tts.js";
import { createDeepgramProvider } from "./providers/deepgram.js";

interface VoiceProviderAdapters {
  createStt?: (apiKey: string, fetchImpl?: typeof fetch) => SttProvider;
  createTts?: (apiKey: string, fetchImpl?: typeof fetch) => TtsProvider;
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
