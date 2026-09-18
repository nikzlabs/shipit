import type { CredentialStore } from "../credential-store.js";
import { ServiceError } from "./types.js";
import {
  getVoiceAdapters,
  cleanTranscript,
  stripForTts,
  ttsCacheKey,
  VoiceProviderError,
  type TtsCache,
  type CleanupErrorCode,
} from "../voice/index.js";
import { planCleanup, type CleanupPlan, type VoiceCleanupDeps } from "./voice-cleanup.js";
import { createStringCredential } from "./credential-routes.js";
import { getHarness, getService, type ConfiguredCredential } from "../../shared/catalogue/index.js";
import { runnerForNonTurnSelection } from "../non-turn-model.js";
import type { CredentialBillingMode, CredentialRoute } from "../../shared/types.js";
import {
  getVoiceProvider,
  isValidVoice,
  providerSupports,
} from "../../shared/voice-catalog.js";

const DEFAULT_STT_PROVIDER = "openai";
const DEFAULT_TTS_PROVIDER = "openai";

export interface VoiceCredentialStatus {
  configured: string[];
}

export interface TranscribeResult {
  text: string;
  rawText: string;
  cleanupErrorCode?: CleanupErrorCode;
}

/** Null where nothing can clean a transcript, so the status line can say so. */
export interface CleanupStatus {
  model: {
    serviceName: string;
    modelId: string;
    modelLabel: string;
    /**
     * What the status line owes the user beyond the model's name: a direct call
     * is quick, a harness takes a few seconds, and a dictation is the one place
     * where several seconds of silence reads as a fault.
     */
    execution: "direct" | "harness";
    harnessName?: string;
  } | null;
  adoptableVoiceKey: VoiceKeyAdoptionOffer | null;
}

export interface VoiceKeyAdoptionOffer {
  providerId: string;
  providerLabel: string;
  serviceName: string;
}

/**
 * A voice key is stored for speech alone and buys no background work, so an
 * install whose only OpenAI key is that one lost cleanup when it moved onto the
 * background-work choice (docs/299-direct-provider-calls req 5). Adopting it as
 * an ordinary model-provider credential is the migration, following the
 * precedent docs/252-custom-models req 20 set for environment-supplied ones.
 *
 * The mapping is declared rather than inferred from ids that happen to match:
 * voice providers and model providers are separate catalogues, and most entries
 * of either appear in only one of them.
 */
const ADOPTABLE_VOICE_KEYS: {
  voiceProviderId: string;
  serviceId: string;
  billingMode: CredentialBillingMode;
}[] = [{ voiceProviderId: "openai", serviceId: "openai", billingMode: "key" }];

type AdoptableVoiceKey = (typeof ADOPTABLE_VOICE_KEYS)[number];

function unadoptedVoiceKeys(credentialStore: CredentialStore): AdoptableVoiceKey[] {
  return ADOPTABLE_VOICE_KEYS.filter((entry) => {
    if (!credentialStore.getVoiceProviderKey(entry.voiceProviderId)?.trim()) return false;
    const stored = credentialStore.listCredentialRoutes(entry.serviceId, entry.billingMode);
    return !stored.some((r) => r.via === "string");
  });
}

/**
 * Adoption seeds background work only when nothing is set, so a pin ShipIt
 * cannot run keeps cleanup broken unless the pin is this very credential.
 * Offering adoption there would promise something it cannot deliver.
 *
 * The question is put to the resolver rather than answered again here: it reads
 * a pin through retirement, so a pin on a retired model that the adopted
 * credential still reaches by its declared successor is runnable, and a rule
 * restated in this file would call it dead.
 */
function adoptionWouldRunCleanup(
  credentialStore: CredentialStore,
  entry: AdoptableVoiceKey,
): boolean {
  const pinned = credentialStore.getNonTurnModel();
  if (!pinned) return true;
  const adopted: ConfiguredCredential = {
    serviceId: entry.serviceId,
    billingMode: entry.billingMode,
    via: "string",
  };
  return !!runnerForNonTurnSelection(pinned, [adopted]);
}

/**
 * The offer the Voice tab renders instead of its "nothing can clean" line. It
 * is a forecast — the tab re-reads this status after adopting, so a run that
 * still cannot clean says so rather than leaving the promise standing.
 */
export function findVoiceKeyAdoptionOffer(
  credentialStore: CredentialStore,
  plan: CleanupPlan | null,
): VoiceKeyAdoptionOffer | null {
  if (plan) return null;
  for (const entry of unadoptedVoiceKeys(credentialStore)) {
    if (!adoptionWouldRunCleanup(credentialStore, entry)) continue;
    const provider = getVoiceProvider(entry.voiceProviderId);
    const service = getService(entry.serviceId);
    if (!provider || !service) continue;
    return {
      providerId: entry.voiceProviderId,
      providerLabel: provider.label,
      serviceName: service.name,
    };
  }
  return null;
}

/**
 * Takes the offer: the key becomes an ordinary model-provider credential —
 * visible, renameable, removable, ordered with the rest — and nothing about the
 * voice key changes, since speech still reads it from where it was.
 *
 * Writing the background-work choice is deliberately NOT done here. The caller
 * runs the existing seeding, which writes only when nothing is set
 * (`seedNonTurnModel`), because choosing a model on the user's behalf is what
 * docs/252-custom-models req 9 reserves for them.
 */
export function adoptVoiceKeyAsCredential(
  credentialStore: CredentialStore,
  providerId: string,
): { route: CredentialRoute; routes: CredentialRoute[] } {
  const entry = unadoptedVoiceKeys(credentialStore).find((e) => e.voiceProviderId === providerId);
  if (!entry) {
    throw new ServiceError(
      409,
      `There is no ${getVoiceProvider(providerId)?.label ?? providerId} voice key left to add as a model provider.`,
    );
  }
  const secret = credentialStore.getVoiceProviderKey(entry.voiceProviderId) ?? "";
  return createStringCredential(credentialStore, {
    serviceId: entry.serviceId,
    billingMode: entry.billingMode,
    secret,
  });
}

function mapProviderError(err: unknown, fallback: string): ServiceError {
  if (err instanceof VoiceProviderError) {
    const status = err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 502;
    console.warn(`[voice] provider error ${err.statusCode}: ${err.message}`);
    const detail = err.message.trim().replace(/\s+/g, " ");
    const separator = /[.!?]$/.test(fallback) ? " " : ": ";
    return new ServiceError(status, detail ? `${fallback}${separator}${detail}` : fallback);
  }
  console.warn(`[voice] unexpected error:`, err);
  return new ServiceError(502, fallback);
}

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
 * What would actually clean the next dictation — the background-work choice, or
 * nothing (docs/299-direct-provider-calls req 5). It reports the same
 * resolution cleanup runs, so the settings line cannot claim a provider that
 * would then fail.
 */
export function getCleanupStatus(deps: VoiceCleanupDeps): CleanupStatus {
  const plan = planCleanup(deps);
  const harnessName = plan?.harnessId
    ? getHarness(plan.harnessId)?.name ?? plan.harnessId
    : undefined;
  return {
    model: plan
      ? {
          serviceName: plan.serviceName,
          modelId: plan.modelId,
          modelLabel: plan.modelLabel,
          execution: plan.execution,
          ...(harnessName ? { harnessName } : {}),
        }
      : null,
    adoptableVoiceKey: findVoiceKeyAdoptionOffer(deps.credentialStore, plan),
  };
}

export async function transcribeVoice(
  deps: VoiceCleanupDeps,
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

  const key = deps.credentialStore.getVoiceProviderKey(providerId);
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

  const result = await cleanTranscript(raw, planCleanup(deps));
  return {
    text: result.text,
    rawText: raw,
    ...(result.cleanupErrorCode ? { cleanupErrorCode: result.cleanupErrorCode } : {}),
  };
}

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
