/**
 * OpenAI speech-to-text adapter (docs/144).
 *
 * Whole-utterance transcription: takes a recorded audio blob and returns the
 * raw transcript. No streaming partials (see plan "Why no mid-utterance
 * partials"). The key is supplied by the service layer from the server-side
 * credential store — it never touches the browser.
 */

import { VoiceProviderError, type SttProvider, type SttTranscribeOptions } from "./types.js";
import { CODING_VOCABULARY } from "../vocabulary.js";

const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_TRANSCRIBE_MODEL = "gpt-transcribe";
const TRANSCRIPTION_CONTEXT =
  "Software development dictation. Preserve technical terms, acronyms, product names, punctuation, and capitalization.";

function filenameForMime(mimeType: string | undefined): string {
  if (!mimeType) return "audio.webm";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "audio.mp4";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "audio.mp3";
  if (mimeType.includes("wav")) return "audio.wav";
  if (mimeType.includes("ogg")) return "audio.ogg";
  return "audio.webm";
}

export function createWhisperProvider(apiKey: string, fetchImpl: typeof fetch = fetch): SttProvider {
  return {
    async transcribe(audio: Buffer, opts: SttTranscribeOptions): Promise<string> {
      const form = new FormData();
      const blob = new Blob([new Uint8Array(audio)], { type: opts.mimeType ?? "audio/webm" });
      form.append("file", blob, filenameForMime(opts.mimeType));
      form.append("model", OPENAI_TRANSCRIBE_MODEL);
      // GPT Transcribe accepts language hints as an array. ShipIt's setting is
      // singular, so preserve its leading ISO-639-1 subtag as one hint.
      if (opts.language) form.append("languages[]", opts.language.split("-")[0]);
      form.append("prompt", TRANSCRIPTION_CONTEXT);
      // Literal keyword hints are the model's intended mechanism for domain
      // vocabulary. Cleanup can only fix terms the transcription preserves.
      for (const keyword of CODING_VOCABULARY) form.append("keywords[]", keyword);
      form.append("response_format", "json");

      let res: Response;
      try {
        res = await fetchImpl(OPENAI_TRANSCRIBE_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
        });
      } catch (err) {
        throw new VoiceProviderError(502, `OpenAI transcription request failed: ${(err as Error).message}`);
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new VoiceProviderError(res.status, `OpenAI transcription returned ${res.status}: ${detail.slice(0, 500)}`);
      }

      const data = (await res.json()) as { text?: string };
      return (data.text ?? "").trim();
    },
  };
}
