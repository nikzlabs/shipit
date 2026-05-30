/**
 * Client voice module barrel (docs/144).
 */

export { useVoiceInput, eventMatchesPtt } from "./use-voice-input.js";
export type { VoiceInputApi, VoiceInputState, UseVoiceInputOptions } from "./use-voice-input.js";
export { spliceTranscript } from "./insert-transcript.js";
export type { SpliceInput, SpliceResult } from "./insert-transcript.js";
export { startCapture, MicPermissionError } from "./capture.js";
export type { ActiveCapture, CaptureResult } from "./capture.js";
export { useVoicePlayback } from "./use-voice-playback.js";
export type { VoicePlaybackApi } from "./use-voice-playback.js";
export { usePlaybackStore } from "./playback-store.js";
export type { PlaybackState } from "./playback-store.js";
export { extractTurnProse, hasSpeakableProse } from "./extract-turn-prose.js";
