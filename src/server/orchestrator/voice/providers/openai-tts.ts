/**
 * OpenAI TTS adapter (docs/144).
 *
 * Streams synthesized speech as `audio/mpeg` (or the requested format). The
 * service layer caches the bytes by content hash so re-pressing Play doesn't
 * re-bill OpenAI; this adapter just performs one synthesis call.
 */

import { VoiceProviderError, type TtsProvider, type TtsSpeakOptions } from "./types.js";

const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const TTS_MODEL = "tts-1";

export function createOpenAiTtsProvider(apiKey: string, fetchImpl: typeof fetch = fetch): TtsProvider {
  return {
    async speak(text: string, opts: TtsSpeakOptions): Promise<ReadableStream<Uint8Array>> {
      let res: Response;
      try {
        res = await fetchImpl(OPENAI_SPEECH_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: TTS_MODEL,
            input: text,
            voice: opts.voice,
            speed: opts.speed,
            response_format: opts.format ?? "mp3",
          }),
        });
      } catch (err) {
        throw new VoiceProviderError(502, `OpenAI TTS request failed: ${(err as Error).message}`);
      }

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new VoiceProviderError(res.status || 502, `OpenAI TTS returned ${res.status}: ${detail.slice(0, 500)}`);
      }

      return res.body;
    },
  };
}
