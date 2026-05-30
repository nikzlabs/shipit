/**
 * ElevenLabs TTS adapter (docs/144).
 *
 * Streams synthesized speech as `audio/mpeg`. The voice id is a path segment
 * (ElevenLabs keys voices by id, not a fixed enum like OpenAI), so the service
 * layer passes the configured voice through `opts.voice`. This adapter just
 * performs one synthesis call and returns the raw mp3 stream.
 */

import { VoiceProviderError, type TtsProvider, type TtsSpeakOptions } from "./types.js";

const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const ELEVENLABS_MODEL = "eleven_multilingual_v2";

export function createElevenLabsTtsProvider(apiKey: string, fetchImpl: typeof fetch = fetch): TtsProvider {
  return {
    async speak(text: string, opts: TtsSpeakOptions): Promise<ReadableStream<Uint8Array>> {
      const url = `${ELEVENLABS_TTS_URL}/${encodeURIComponent(opts.voice)}`;
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text,
            model_id: ELEVENLABS_MODEL,
            voice_settings: { speed: opts.speed },
          }),
        });
      } catch (err) {
        throw new VoiceProviderError(502, `ElevenLabs TTS request failed: ${(err as Error).message}`);
      }

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new VoiceProviderError(res.status || 502, `ElevenLabs TTS returned ${res.status}: ${detail.slice(0, 500)}`);
      }

      return res.body;
    },
  };
}
