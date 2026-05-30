/**
 * Provider contracts for the voice feature (docs/144).
 *
 * Three directions, three interfaces. Each adapter is a thin wrapper over an
 * upstream HTTP API that takes the minimum it needs (audio/text + a key) and
 * returns a normalized result. Selection and orchestration live in the
 * service layer, not here — adapters never read the credential store or pick
 * between providers.
 */

export interface SttTranscribeOptions {
  /** BCP-47 language hint (e.g. "en", "en-US"). Optional — provider may auto-detect. */
  language?: string;
  /** MIME type of the audio blob (e.g. "audio/webm", "audio/mp4"). */
  mimeType?: string;
}

export interface SttProvider {
  transcribe(audio: Buffer, opts: SttTranscribeOptions): Promise<string>;
}

export interface CleanupOptions {
  /** Language hint passed through to the cleanup model where useful. */
  language?: string;
  /** Abort signal so the service layer can enforce its own timeout. */
  signal?: AbortSignal;
}

export interface CleanupProvider {
  /** Stable id surfaced to the client so Settings can show which path ran. */
  readonly id: "claude-oauth" | "openai-cleanup";
  clean(rawTranscript: string, opts: CleanupOptions): Promise<string>;
}

export interface TtsSpeakOptions {
  /** Provider voice id (OpenAI: alloy/echo/fable/onyx/nova/shimmer). */
  voice: string;
  /** Playback speed baked into synthesis (0.25–4.0 for OpenAI). */
  speed: number;
  /** Output container; defaults to "mp3" for broad <audio> compatibility. */
  format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
}

export interface TtsProvider {
  speak(text: string, opts: TtsSpeakOptions): Promise<ReadableStream<Uint8Array>>;
}

/**
 * Thrown by adapters when the upstream API rejects a request. Carries the
 * upstream status so the service layer can map it onto a `ServiceError` with
 * a sanitized, user-facing message while logging the detail.
 */
export class VoiceProviderError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "VoiceProviderError";
  }
}
