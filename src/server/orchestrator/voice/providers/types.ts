export interface SttTranscribeOptions {
  /** BCP-47 language hint. */
  language?: string;
  mimeType?: string;
}

export interface SttProvider {
  transcribe(audio: Buffer, opts: SttTranscribeOptions): Promise<string>;
}

export interface CleanupOptions {
  language?: string;
  signal?: AbortSignal;
}

export interface CleanupProvider {
  readonly id: "claude-oauth" | "openai-cleanup";
  clean(rawTranscript: string, opts: CleanupOptions): Promise<string>;
}

export interface TtsSpeakOptions {
  voice: string;
  speed: number;
  format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
}

export interface TtsProvider {
  speak(text: string, opts: TtsSpeakOptions): Promise<ReadableStream<Uint8Array>>;
}

export class VoiceProviderError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "VoiceProviderError";
  }
}
