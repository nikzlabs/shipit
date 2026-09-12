/**
 * Voice-note autoplay coordination (docs/163, Native sink, foreground-only).
 *
 * Layered on top of the docs/144 `playback-store` single-audio-element
 * invariant. The server always produces the note; this module decides whether
 * to *autoplay* it, gated by hands-free mode:
 *
 *   - Hands-free OFF (default) → no autoplay; the voice-note bubble shows a
 *     prominent tap-to-play prompt.
 *   - Hands-free ON → autoplay the speech, with a debounced attention chime
 *     (one chime per 20s quiet window). Mid-playback arrival is latest-wins
 *     (playback-store stops the current audio and starts the new note).
 *
 * Autoplay-unlock: browser policy blocks fresh audio from a page with no user
 * gesture. The hands-free toggle interaction is that gesture — `armAutoplay()`
 * primes a shared AudioContext on the click so later server-driven autoplay is
 * permitted. If the page reloads, the unlock is lost; the next note falls back
 * to tap-to-play and re-arms on that tap.
 */

import { usePlaybackStore } from "./playback-store.js";
import { useSettingsStore } from "../stores/settings-store.js";

export const CHIME_QUIET_WINDOW_MS = 20_000;

let unlocked = false;
let lastNoteAt = 0;
let audioCtx: AudioContext | null = null;

function getAudioCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  audioCtx ??= new Ctor();
  return audioCtx;
}

export function armAutoplay(): void {
  unlocked = true;
  const ctx = getAudioCtx();
  if (ctx?.state === "suspended") {
    void ctx.resume().catch(() => {
      /* best-effort; play() rejection later falls back to tap-to-play */
    });
  }
}

function maybeChime(now: number): void {
  if (now - lastNoteAt < CHIME_QUIET_WINDOW_MS) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  } catch {
    /* chime is non-essential */
  }
}

export function autoplayVoiceNote(
  note: { id: string; headline: string },
  nowMs: number = Date.now(),
): boolean {
  const handsFree = useSettingsStore.getState().voiceHandsFree;
  if (!handsFree || !unlocked) return false;

  maybeChime(nowMs);
  lastNoteAt = nowMs;

  void usePlaybackStore.getState().play(note.id, note.headline);
  return true;
}

export function __resetVoiceNotesStateForTest(): void {
  unlocked = false;
  lastNoteAt = 0;
  audioCtx = null;
}
