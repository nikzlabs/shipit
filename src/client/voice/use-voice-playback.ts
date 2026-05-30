/**
 * Playback hook (docs/144).
 *
 * Thin ergonomic wrapper over `usePlaybackStore`. The single-audio-element
 * invariant and the blob cache live in the store; this hook just exposes
 * the state + actions in the shape the plan locks. Like the input hook, it
 * is type-locked to "text in, audio out" — no chat-store reference, no
 * ability to mark turns read or trigger a follow-up.
 */

import { usePlaybackStore, type PlaybackState } from "./playback-store.js";

export interface VoicePlaybackApi {
  state: PlaybackState;
  playingTurnId: string | null;
  positionMs: number;
  durationMs: number;
  errorMessage: string | null;
  play: (turnId: string, text: string) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
}

export function useVoicePlayback(): VoicePlaybackApi {
  const state = usePlaybackStore((s) => s.state);
  const playingTurnId = usePlaybackStore((s) => s.playingTurnId);
  const positionMs = usePlaybackStore((s) => s.positionMs);
  const durationMs = usePlaybackStore((s) => s.durationMs);
  const errorMessage = usePlaybackStore((s) => s.errorMessage);
  const play = usePlaybackStore((s) => s.play);
  const pause = usePlaybackStore((s) => s.pause);
  const resume = usePlaybackStore((s) => s.resume);
  const stop = usePlaybackStore((s) => s.stop);

  return { state, playingTurnId, positionMs, durationMs, errorMessage, play, pause, resume, stop };
}
