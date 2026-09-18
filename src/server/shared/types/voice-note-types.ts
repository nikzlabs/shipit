export interface VoiceNoteContext {
  repo?: string;
  prUrl?: string;
  prTitle?: string;
  /** The router fills this; the agent leaves it unset. */
  sessionName?: string;
}

export type VoiceNoteSource = "authored" | "ask" | "plan";

/** Every note asks for user attention; summary is a short spoken headline. */
export interface VoiceNotePayload {
  summary: string;
  context?: VoiceNoteContext;
}

export type VoiceDeliveryMode = "native" | "external" | "both";

export const DEFAULT_VOICE_DELIVERY_MODE: VoiceDeliveryMode = "native";

export const VOICE_WEBHOOK_BODY_VERSION = 1;
