export type VoiceCapability = "stt" | "tts" | "cleanup";

export interface VoiceProviderVoice {
  id: string;
  label: string;
}

export interface VoiceProviderInfo {
  id: string;
  label: string;
  capabilities: VoiceCapability[];
  requiresKey: boolean;
  keyPlaceholder?: string;
  voices?: VoiceProviderVoice[];
  speeds?: number[];
  speedRange?: { min: number; max: number };
}

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

export const keyRequiringProviders = (): VoiceProviderInfo[] => VOICE_PROVIDERS.filter((p) => p.requiresKey);

export function providerVoices(id: string): VoiceProviderVoice[] {
  return getVoiceProvider(id)?.voices ?? [];
}

export function providerSupports(id: string, cap: VoiceCapability): boolean {
  return getVoiceProvider(id)?.capabilities.includes(cap) ?? false;
}

export function isValidVoice(providerId: string, voiceId: string): boolean {
  return providerVoices(providerId).some((v) => v.id === voiceId);
}

export function defaultVoiceFor(providerId: string): string {
  return providerVoices(providerId)[0]?.id ?? "";
}

export function providerSpeeds(providerId: string): number[] {
  return getVoiceProvider(providerId)?.speeds ?? [1];
}
