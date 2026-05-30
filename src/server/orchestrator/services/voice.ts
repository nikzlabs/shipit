/**
 * Voice service layer (docs/144).
 *
 * Composes the credential store, the Claude OAuth auth manager, the provider
 * adapters, and the TTS cache into pure-ish async functions the route calls.
 * Routes never touch providers directly — this is the documented service-layer
 * pattern (CLAUDE.md "Service layer pattern").
 */

import type { CredentialStore } from "../credential-store.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import { ServiceError } from "./types.js";
import {
  createWhisperProvider,
  createOpenAiTtsProvider,
  pickCleanupProvider,
  cleanTranscript,
  stripForTts,
  ttsCacheKey,
  VoiceProviderError,
  type TtsCache,
  type CleanupErrorCode,
  type CleanupProvider,
} from "../voice/index.js";

export const OPENAI_TTS_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;
const TTS_PROVIDER_KEY = "openai-tts";

export interface VoiceCredentialStatus {
  configured: boolean;
  provider?: "openai";
}

export interface TranscribeResult {
  text: string;
  rawText: string;
  cleanupProvider?: CleanupProvider["id"];
  cleanupErrorCode?: CleanupErrorCode;
}

function mapProviderError(err: unknown, fallback: string): ServiceError {
  if (err instanceof VoiceProviderError) {
    // Surface upstream auth/rate-limit/4xx status; collapse 5xx onto 502.
    const status = err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 502;
    console.warn(`[voice] provider error ${err.statusCode}: ${err.message}`);
    return new ServiceError(status, fallback);
  }
  console.warn(`[voice] unexpected error:`, err);
  return new ServiceError(502, fallback);
}

// ---- Credentials ----

export function setVoiceKey(credentialStore: CredentialStore, apiKey: string): { ok: true } {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new ServiceError(400, "API key is required");
  credentialStore.setVoiceProviderApiKey(trimmed, "openai");
  return { ok: true };
}

export function clearVoiceKey(credentialStore: CredentialStore): { ok: true } {
  credentialStore.clearVoiceProviderApiKey();
  return { ok: true };
}

export function getVoiceCredentialStatus(credentialStore: CredentialStore): VoiceCredentialStatus {
  const key = credentialStore.getVoiceProviderApiKey();
  if (!key) return { configured: false };
  return { configured: true, provider: credentialStore.getVoiceProvider() ?? "openai" };
}

/**
 * Which cleanup provider would run, without leaking credentials. Returns the
 * provider id or null when none is available — drives the Settings status
 * string.
 */
export async function getCleanupStatus(
  credentialStore: CredentialStore,
  authManager: AuthManager,
  fetchImpl: typeof fetch = fetch,
): Promise<{ provider: CleanupProvider["id"] | null }> {
  const key = credentialStore.getVoiceProviderApiKey();
  const provider = await pickCleanupProvider(authManager, key, fetchImpl);
  return { provider: provider?.id ?? null };
}

// ---- Transcription (STT + cleanup) ----

export async function transcribeVoice(
  credentialStore: CredentialStore,
  authManager: AuthManager,
  input: { audio: Buffer; mimeType?: string; language?: string; cleanup: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<TranscribeResult> {
  const key = credentialStore.getVoiceProviderApiKey();
  if (!key) throw new ServiceError(400, "No voice API key configured");
  if (input.audio.length === 0) throw new ServiceError(400, "Empty audio");

  const stt = createWhisperProvider(key, fetchImpl);
  let raw: string;
  try {
    raw = await stt.transcribe(input.audio, {
      ...(input.language ? { language: input.language } : {}),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    });
  } catch (err) {
    throw mapProviderError(err, "Couldn't transcribe — try again.");
  }

  if (!raw) return { text: "", rawText: "" };
  if (!input.cleanup) return { text: raw, rawText: raw };

  const provider = await pickCleanupProvider(authManager, key, fetchImpl);
  const result = await cleanTranscript(raw, provider, {
    ...(input.language ? { language: input.language } : {}),
  });
  return {
    text: result.text,
    rawText: raw,
    ...(result.cleanupProvider ? { cleanupProvider: result.cleanupProvider } : {}),
    ...(result.cleanupErrorCode ? { cleanupErrorCode: result.cleanupErrorCode } : {}),
  };
}

// ---- Speech (TTS) ----

/**
 * Synthesize speech for the given prose. Returns null when the stripped text
 * is empty (route replies 204). Cache hit returns immediately without hitting
 * the provider.
 */
export async function speakVoice(
  credentialStore: CredentialStore,
  ttsCache: TtsCache,
  input: { text: string; voice: string; speed: number },
  fetchImpl: typeof fetch = fetch,
): Promise<{ audio: Buffer; contentType: string } | null> {
  const cleaned = stripForTts(input.text);
  if (!cleaned) return null;

  const voice = input.voice;
  if (!OPENAI_TTS_VOICES.includes(voice as (typeof OPENAI_TTS_VOICES)[number])) {
    throw new ServiceError(400, `Unknown voice: ${voice}`);
  }
  const speed = input.speed;
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) {
    throw new ServiceError(400, "Speed must be between 0.25 and 4");
  }

  const key = credentialStore.getVoiceProviderApiKey();
  if (!key) throw new ServiceError(400, "No voice API key configured");

  const cacheKey = ttsCacheKey(cleaned, voice, speed, TTS_PROVIDER_KEY);
  const cached = ttsCache.get(cacheKey);
  if (cached) return { audio: cached, contentType: "audio/mpeg" };

  const tts = createOpenAiTtsProvider(key, fetchImpl);
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = await tts.speak(cleaned, { voice, speed, format: "mp3" });
  } catch (err) {
    throw mapProviderError(err, "Couldn't synthesize speech — try again.");
  }

  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const audio = Buffer.concat(chunks);
  ttsCache.set(cacheKey, audio);
  return { audio, contentType: "audio/mpeg" };
}
