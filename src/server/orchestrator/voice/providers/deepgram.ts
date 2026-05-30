/**
 * Deepgram STT adapter (docs/144).
 *
 * Whole-utterance transcription via the pre-recorded `/v1/listen` endpoint:
 * takes a recorded audio buffer and returns the raw transcript. No streaming
 * partials (see plan "Why no mid-utterance partials"). The key is supplied by
 * the service layer from the server-side credential store — it never touches
 * the browser.
 */

import { VoiceProviderError, type SttProvider, type SttTranscribeOptions } from "./types.js";

const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen";
const DEEPGRAM_MODEL = "nova-2";

export function createDeepgramProvider(apiKey: string, fetchImpl: typeof fetch = fetch): SttProvider {
  return {
    async transcribe(audio: Buffer, opts: SttTranscribeOptions): Promise<string> {
      const params = new URLSearchParams({ model: DEEPGRAM_MODEL, smart_format: "true" });
      // Deepgram expects a 2-letter ISO-639-1 hint; pass the leading subtag.
      if (opts.language) params.set("language", opts.language.split("-")[0]);
      const url = `${DEEPGRAM_LISTEN_URL}?${params.toString()}`;

      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Token ${apiKey}`,
            "Content-Type": opts.mimeType ?? "audio/webm",
          },
          body: new Uint8Array(audio),
        });
      } catch (err) {
        throw new VoiceProviderError(502, `Deepgram request failed: ${(err as Error).message}`);
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new VoiceProviderError(res.status, `Deepgram returned ${res.status}: ${detail.slice(0, 500)}`);
      }

      const data = (await res.json()) as {
        results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
      };
      return (data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "").trim();
    },
  };
}
