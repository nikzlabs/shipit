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
