/**
 * Voice-note payload + delivery types (docs/163).
 *
 * One payload contract, identical regardless of source (the built-in voice
 * tool, or a derived AskUserQuestion / ExitPlanMode headline) or sink (the
 * native inline note, or the external webhook).
 *
 * A voice note means exactly one thing: **the agent needs the user**. There is
 * no silent/FYI mode — the former `needsAttention` gate was removed because a
 * `false` note produced no audio and no webhook, leaving a transcript bubble
 * that only restated prose already on screen. The webhook body still carries a
 * constant `needsAttention: true` for `v: 1` receiver compatibility.
 */

/**
 * Display-only metadata that travels with a voice note. Mirrors the docs/159
 * `context` object: a webhook receiver renders `prTitle` + `prUrl` as a single
 * link on text channels and never speaks `prUrl`.
 */
export interface VoiceNoteContext {
  repo?: string;
  prUrl?: string;
  prTitle?: string;
  /** Left unset by the agent; the router may fill it from session metadata. */
  sessionName?: string;
}

/**
 * Where a voice note came from. `authored` is the agent calling the built-in
 * `voice_note` tool directly; `ask` / `plan` are headlines ShipIt *derived*
 * from an observed `AskUserQuestion` / `ExitPlanMode` interrupt when the agent
 * reached the interrupt without authoring a note first (the fallback floor).
 */
export type VoiceNoteSource = "authored" | "ask" | "plan";

/**
 * The one payload contract. `summary` is an ear-shaped one-or-two-sentence
 * headline. Every note is attention-worthy by construction, so there is no
 * gate field.
 */
export interface VoiceNotePayload {
  summary: string;
  context?: VoiceNoteContext;
}

/**
 * The user's delivery setting — the single place "the user chooses the
 * mechanism" lives. The agent never knows which of these is active.
 */
export type VoiceDeliveryMode = "native" | "external" | "both";

/** Default delivery: inline note only, no external dependency. */
export const DEFAULT_VOICE_DELIVERY_MODE: VoiceDeliveryMode = "native";

/** Webhook body version. Receivers branch on it and may reject unknown majors. */
export const VOICE_WEBHOOK_BODY_VERSION = 1;
