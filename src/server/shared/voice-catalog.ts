/**
 * Shared voice provider catalog (docs/144).
 *
 * The single source of truth for which voice providers exist, what each can
 * do (STT / TTS / cleanup), the TTS voices and speed options it offers, and
 * whether it needs its own server-side API key. Both the client (Settings UI,
 * dictation/playback hooks) and the server (service-layer validation, the
 * provider registry) import from here so a new provider is added in one place.
 *
 * This file is pure data + selectors — no network, no node/browser globals —
 * so it is safe to import from either layer.
 */

export type VoiceCapability = "stt" | "tts" | "cleanup";

export interface VoiceProviderVoice {
  /** Provider voice id sent to the upstream API (OpenAI: "alloy"; ElevenLabs: a voice UUID). */
  id: string;
  /** Human label shown in the Settings voice dropdown. */
  label: string;
}

export interface VoiceProviderInfo {
  /** Stable provider id used as the credential-store key and request param. */
  id: string;
  /** Human label shown in Settings. */
  label: string;
  capabilities: VoiceCapability[];
  /** Whether the provider needs its own API key stored server-side. */
  requiresKey: boolean;
  /** Placeholder shown in the key input (hints at the key format). */
  keyPlaceholder?: string;
  /** TTS voices — present only on tts-capable providers. */
  voices?: VoiceProviderVoice[];
  /** Selectable playback speeds — present only on tts-capable providers. */
  speeds?: number[];
  /** Inclusive speed range enforced server-side — present only on tts-capable providers. */
  speedRange?: { min: number; max: number };
}

/**
 * The provider catalog. Order matters: it drives the order of dropdown
 * options in Settings.
 */
export const VOICE_PROVIDERS: VoiceProviderInfo[] = [
  {
    id: "openai",
    label: "OpenAI",
    capabilities: ["stt", "tts", "cleanup"],
    requiresKey: true,
    keyPlaceholder: "sk-…",
    voices: [
      { id: "alloy", label: "Alloy" },
      { id: "echo", label: "Echo" },
      { id: "fable", label: "Fable" },
      { id: "onyx", label: "Onyx" },
      { id: "nova", label: "Nova" },
      { id: "shimmer", label: "Shimmer" },
    ],
    speeds: [1, 1.25, 1.5, 2],
    speedRange: { min: 0.25, max: 4 },
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    capabilities: ["tts"],
    requiresKey: true,
    keyPlaceholder: "ElevenLabs API key",
    voices: [
      { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel" },
      { id: "AZnzlk1XvdvUeBnXmlld", label: "Domi" },
      { id: "EXAVITQu4vr4xnSDxMaL", label: "Bella" },
      { id: "ErXwobaYiN019PkySvjV", label: "Antoni" },
      { id: "MF3mGyEYCl7XYWbV9V6O", label: "Elli" },
      { id: "pNInz6obpgDQGcFmaJgB", label: "Adam" },
    ],
    speeds: [0.8, 0.9, 1, 1.1, 1.2],
    speedRange: { min: 0.7, max: 1.2 },
  },
  {
    id: "deepgram",
    label: "Deepgram",
    capabilities: ["stt"],
    requiresKey: true,
    keyPlaceholder: "Deepgram API key",
  },
];

export function getVoiceProvider(id: string): VoiceProviderInfo | undefined {
  return VOICE_PROVIDERS.find((p) => p.id === id);
}

function withCapability(cap: VoiceCapability): VoiceProviderInfo[] {
  return VOICE_PROVIDERS.filter((p) => p.capabilities.includes(cap));
}

export const sttProviders = (): VoiceProviderInfo[] => withCapability("stt");
export const ttsProviders = (): VoiceProviderInfo[] => withCapability("tts");

/** Providers that need a server-side API key (drives the Settings key fields). */
export const keyRequiringProviders = (): VoiceProviderInfo[] => VOICE_PROVIDERS.filter((p) => p.requiresKey);

export function providerVoices(id: string): VoiceProviderVoice[] {
  return getVoiceProvider(id)?.voices ?? [];
}

export function providerSupports(id: string, cap: VoiceCapability): boolean {
  return getVoiceProvider(id)?.capabilities.includes(cap) ?? false;
}

/** Whether `voiceId` is a known voice for the given TTS provider. */
export function isValidVoice(providerId: string, voiceId: string): boolean {
  return providerVoices(providerId).some((v) => v.id === voiceId);
}

/** Default TTS voice for a provider (first in its list), or "" if it has none. */
export function defaultVoiceFor(providerId: string): string {
  return providerVoices(providerId)[0]?.id ?? "";
}

/** Selectable playback speeds for a provider, or a sensible default set. */
export function providerSpeeds(providerId: string): number[] {
  return getVoiceProvider(providerId)?.speeds ?? [1];
}
