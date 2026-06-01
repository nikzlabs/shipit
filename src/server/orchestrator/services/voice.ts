/**
 * Voice service layer (docs/144).
 *
 * Composes the credential store, the Claude OAuth auth manager, the provider
 * registry, and the TTS cache into pure-ish async functions the route calls.
 * Routes never touch providers directly — this is the documented service-layer
 * pattern (CLAUDE.md "Service layer pattern").
 *
 * Provider selection is data-driven: the request names a provider id, the
 * service validates it against the shared catalog and dispatches through the
 * registry. Adding a provider needs no change here.
 */

import type { CredentialStore } from "../credential-store.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import { ServiceError } from "./types.js";
import {
  getVoiceAdapters,
  pickCleanupProvider,
  cleanTranscript,
  stripForTts,
  ttsCacheKey,
  VoiceProviderError,
  type TtsCache,
  type CleanupErrorCode,
  type CleanupProvider,
} from "../voice/index.js";
import {
  getVoiceProvider,
  isValidVoice,
  providerSupports,
} from "../../shared/voice-catalog.js";

const DEFAULT_STT_PROVIDER = "openai";
const DEFAULT_TTS_PROVIDER = "openai";
/** Provider whose key backs the OpenAI cleanup fallback. */
const CLEANUP_OPENAI_PROVIDER = "openai";

export interface VoiceCredentialStatus {
  /** Provider ids that currently have a server-side key. */
  configured: string[];
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
    const detail = err.message.trim().replace(/\s+/g, " ");
    const separator = /[.!?]$/.test(fallback) ? " " : ": ";
    return new ServiceError(status, detail ? `${fallback}${separator}${detail}` : fallback);
  }
  console.warn(`[voice] unexpected error:`, err);
  return new ServiceError(502, fallback);
}

// ---- Credentials ----

export function setVoiceKey(
  credentialStore: CredentialStore,
  providerId: string,
  apiKey: string,
): { ok: true } {
  const provider = getVoiceProvider(providerId);
  if (!provider?.requiresKey) {
    throw new ServiceError(400, `Unknown voice provider: ${providerId}`);
  }
  const trimmed = apiKey.trim();
  if (!trimmed) throw new ServiceError(400, "API key is required");
  credentialStore.setVoiceProviderKey(providerId, trimmed);
  return { ok: true };
}

export function clearVoiceKey(credentialStore: CredentialStore, providerId: string): { ok: true } {
  if (!getVoiceProvider(providerId)) {
    throw new ServiceError(400, `Unknown voice provider: ${providerId}`);
  }
  credentialStore.clearVoiceProviderKey(providerId);
  return { ok: true };
}

export function getVoiceCredentialStatus(credentialStore: CredentialStore): VoiceCredentialStatus {
  return { configured: credentialStore.getConfiguredVoiceProviders() };
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
  const key = credentialStore.getVoiceProviderKey(CLEANUP_OPENAI_PROVIDER);
  const provider = await pickCleanupProvider(authManager, key, fetchImpl);
  return { provider: provider?.id ?? null };
}

// ---- Transcription (STT + cleanup) ----

export async function transcribeVoice(
  credentialStore: CredentialStore,
  authManager: AuthManager,
  input: {
    audio: Buffer;
    mimeType?: string;
    language?: string;
    cleanup: boolean;
    sttProvider?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<TranscribeResult> {
  const providerId = input.sttProvider ?? DEFAULT_STT_PROVIDER;
  if (!providerSupports(providerId, "stt")) {
    throw new ServiceError(400, `Provider does not support transcription: ${providerId}`);
  }
  const adapters = getVoiceAdapters(providerId);
  if (!adapters?.createStt) {
    throw new ServiceError(400, `No transcription adapter for provider: ${providerId}`);
  }

  const key = credentialStore.getVoiceProviderKey(providerId);
  if (!key) throw new ServiceError(400, `No API key configured for ${providerId}`);
  if (input.audio.length === 0) throw new ServiceError(400, "Empty audio");

  const stt = adapters.createStt(key, fetchImpl);
  let raw: string;
  try {
    raw = await stt.transcribe(input.audio, {
      ...(input.language ? { language: input.language } : {}),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    });
  } catch (err) {
    throw mapProviderError(err, "Couldn't transcribe");
  }

  if (!raw) return { text: "", rawText: "" };
  if (!input.cleanup) return { text: raw, rawText: raw };

  const cleanupKey = credentialStore.getVoiceProviderKey(CLEANUP_OPENAI_PROVIDER);
  const provider = await pickCleanupProvider(authManager, cleanupKey, fetchImpl);
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
  input: { text: string; voice: string; speed: number; provider?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ audio: Buffer; contentType: string } | null> {
  const cleaned = stripForTts(input.text);
  if (!cleaned) return null;

  const providerId = input.provider ?? DEFAULT_TTS_PROVIDER;
  const catalogEntry = getVoiceProvider(providerId);
  if (!catalogEntry || !providerSupports(providerId, "tts")) {
    throw new ServiceError(400, `Provider does not support playback: ${providerId}`);
  }
  const adapters = getVoiceAdapters(providerId);
  if (!adapters?.createTts) {
    throw new ServiceError(400, `No playback adapter for provider: ${providerId}`);
  }

  const voice = input.voice;
  if (!isValidVoice(providerId, voice)) {
    throw new ServiceError(400, `Unknown voice: ${voice}`);
  }
  const speed = input.speed;
  const range = catalogEntry.speedRange ?? { min: 0.25, max: 4 };
  if (!Number.isFinite(speed) || speed < range.min || speed > range.max) {
    throw new ServiceError(400, `Speed must be between ${range.min} and ${range.max}`);
  }

  const key = credentialStore.getVoiceProviderKey(providerId);
  if (!key) throw new ServiceError(400, `No API key configured for ${providerId}`);

  const cacheKey = ttsCacheKey(cleaned, voice, speed, providerId);
  const cached = ttsCache.get(cacheKey);
  const contentType = adapters.ttsContentType ?? "audio/mpeg";
  if (cached) return { audio: cached, contentType };

  const tts = adapters.createTts(key, fetchImpl);
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
  return { audio, contentType };
}
