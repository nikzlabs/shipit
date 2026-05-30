/**
 * Playback store (docs/144).
 *
 * Owns the single `HTMLAudioElement` invariant: at most one turn plays at
 * a time, backed by one audio element. Pressing Play on a new turn stops
 * and frees the previous one. Synthesized audio blobs are cached per
 * `(turnId, voice, speed)` so re-pressing Play is instant and doesn't
 * re-hit the TTS endpoint.
 *
 * The store is locked by type to the same contract as the input hook: it
 * accepts a turn id and text, nothing else. It has no reference to the
 * chat store and cannot mark turns read or trigger follow-ups — its only
 * job is producing audio from text.
 */

import { create } from "zustand";
import { useSettingsStore } from "../stores/settings-store.js";

export type PlaybackState = "idle" | "loading" | "playing" | "paused" | "error";

interface PlaybackStore {
  playingTurnId: string | null;
  state: PlaybackState;
  positionMs: number;
  durationMs: number;
  errorMessage: string | null;
  play: (turnId: string, text: string) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
}

// Module-level singletons — deliberately NOT React state. There is exactly
// one audio element in the app; the blob cache survives turn switches so
// replays are free.
let audioEl: HTMLAudioElement | null = null;
const blobCache = new Map<string, string>();
// Bound the cache so a long session replaying many turns/speeds doesn't leak
// object URLs — each entry pins its audio blob in memory until revoked.
const MAX_CACHED_BLOBS = 32;

function cacheKey(turnId: string, voice: string, speed: number): string {
  return `${turnId}:${voice}:${speed}`;
}

function rememberBlobUrl(key: string, url: string): void {
  blobCache.set(key, url);
  while (blobCache.size > MAX_CACHED_BLOBS) {
    const oldestKey = blobCache.keys().next().value;
    if (oldestKey === undefined) break;
    const stale = blobCache.get(oldestKey);
    if (stale) URL.revokeObjectURL(stale);
    blobCache.delete(oldestKey);
  }
}

export const usePlaybackStore = create<PlaybackStore>((set, get) => {
  function teardownAudio(): void {
    if (audioEl) {
      audioEl.ontimeupdate = null;
      audioEl.onloadedmetadata = null;
      audioEl.onended = null;
      audioEl.onerror = null;
      audioEl.pause();
      audioEl = null;
    }
  }

  function attachListeners(el: HTMLAudioElement): void {
    el.onloadedmetadata = () => {
      set({ durationMs: Number.isFinite(el.duration) ? el.duration * 1000 : 0 });
    };
    el.ontimeupdate = () => {
      set({ positionMs: el.currentTime * 1000 });
    };
    el.onended = () => {
      teardownAudio();
      set({ state: "idle", playingTurnId: null, positionMs: 0 });
    };
    el.onerror = () => {
      teardownAudio();
      set({ state: "error", errorMessage: "Playback failed" });
    };
  }

  return {
    playingTurnId: null,
    state: "idle",
    positionMs: 0,
    durationMs: 0,
    errorMessage: null,

    play: async (turnId, text) => {
      const { ttsVoice, ttsSpeed } = useSettingsStore.getState();
      // Switching turns stops and frees the previous element.
      teardownAudio();
      set({ state: "loading", playingTurnId: turnId, positionMs: 0, durationMs: 0, errorMessage: null });

      const key = cacheKey(turnId, ttsVoice, ttsSpeed);
      let url = blobCache.get(key);
      if (url) {
        // LRU touch: move to most-recently-used so it survives eviction.
        blobCache.delete(key);
        blobCache.set(key, url);
      }

      if (!url) {
        try {
          const res = await fetch("/api/voice/speak", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, voice: ttsVoice, speed: ttsSpeed }),
          });
          if (res.status === 204) {
            set({ state: "idle", playingTurnId: null });
            return;
          }
          if (!res.ok) {
            let detail = "";
            try { detail = ((await res.json()) as { error?: string }).error ?? ""; } catch { /* ignore */ }
            console.error(`Voice speak failed (${res.status})`, detail);
            set({ state: "error", errorMessage: "Couldn't play — try again", playingTurnId: null });
            return;
          }
          const blob = await res.blob();
          url = URL.createObjectURL(blob);
          rememberBlobUrl(key, url);
        } catch (err) {
          console.error("Voice speak error", err);
          set({ state: "error", errorMessage: "Couldn't play — try again", playingTurnId: null });
          return;
        }
      }

      // A newer play() may have superseded this one while we awaited.
      if (get().playingTurnId !== turnId) return;

      const el = new Audio(url);
      audioEl = el;
      attachListeners(el);
      try {
        await el.play();
        if (get().playingTurnId === turnId) set({ state: "playing" });
      } catch (err) {
        console.error("Audio play() rejected", err);
        teardownAudio();
        set({ state: "error", errorMessage: "Couldn't play — try again", playingTurnId: null });
      }
    },

    pause: () => {
      if (audioEl && get().state === "playing") {
        audioEl.pause();
        set({ state: "paused" });
      }
    },

    resume: () => {
      if (audioEl && get().state === "paused") {
        void audioEl.play();
        set({ state: "playing" });
      }
    },

    stop: () => {
      teardownAudio();
      set({ state: "idle", playingTurnId: null, positionMs: 0, durationMs: 0 });
    },
  };
});
