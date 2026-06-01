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

/** One chime per this quiet window. Resets after this long with no notes. */
export const CHIME_QUIET_WINDOW_MS = 20_000;

// Module-level state — deliberately not React state. Mirrors playback-store.
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

/** True once autoplay has been unlocked by a user gesture this page load. */
export function isAutoplayUnlocked(): boolean {
  return unlocked;
}

/**
 * Prime autoplay on a user gesture (the hands-free toggle, or a tap-to-play
 * click). Resumes the shared AudioContext so later chimes + autoplay are
 * permitted by browser policy.
 */
export function armAutoplay(): void {
  unlocked = true;
  const ctx = getAudioCtx();
  if (ctx?.state === "suspended") {
    void ctx.resume().catch(() => {
      /* best-effort; play() rejection later falls back to tap-to-play */
    });
  }
}

/**
 * Play a short attention chime, debounced to once per quiet window. Called
 * before autoplaying speech to re-grab an eyes-off user after silence — not on
 * every note in a burst.
 */
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

/**
 * Decide whether to autoplay an incoming native voice note. Returns true when
 * autoplay was triggered (so the bubble can suppress the tap-to-play prompt).
 *
 * `nowMs` is injectable for tests.
 */
export function autoplayVoiceNote(
  note: { id: string; headline: string; needsAttention: boolean },
  nowMs: number = Date.now(),
): boolean {
  // Silent notes (needsAttention: false) never grab attention.
  if (!note.needsAttention) return false;
  const handsFree = useSettingsStore.getState().voiceHandsFree;
  if (!handsFree || !unlocked) return false;

  maybeChime(nowMs);
  lastNoteAt = nowMs;

  // Latest-wins: playback-store.play stops any current audio and starts this
  // one. A superseded note remains tap-to-replay in its bubble.
  void usePlaybackStore.getState().play(note.id, note.headline);
  return true;
}

/** Test-only reset of module state. */
export function __resetVoiceNotesStateForTest(): void {
  unlocked = false;
  lastNoteAt = 0;
  audioCtx = null;
}
