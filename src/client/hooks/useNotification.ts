// eslint-disable-next-line no-restricted-imports -- useEffect: document visibilitychange listener with cleanup (browser API subscription)
import { useEffect, useRef, useCallback } from "react";
import { useSettingsStore } from "../stores/settings-store.js";

const DEFAULT_TITLE = "ShipIt";

function doneTitle(sessionName?: string): string {
  if (sessionName) return `\u25cf ${sessionName} \u2014 ShipIt`;
  return "\u25cf Needs attention \u2014 ShipIt";
}

export interface NotifyContext {
  /** Session display name / title. */
  sessionName?: string;
  /** Repo label, e.g. "owner/repo". */
  repoLabel?: string;
}

/**
 * Attempt to play a short notification sound using the Web Audio API.
 * Falls back silently if AudioContext is unavailable.
 */
function playNotificationSound(): void {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;

    // A pleasant two-tone chime (C5 → E5)
    const notes = [
      { freq: 523.25, start: 0, duration: 0.15 },   // C5
      { freq: 659.25, start: 0.15, duration: 0.25 }, // E5
    ];

    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = note.freq;
      gain.gain.setValueAtTime(0.3, now + note.start);
      gain.gain.exponentialRampToValueAtTime(0.001, now + note.start + note.duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + note.start);
      osc.stop(now + note.start + note.duration);
    }

    // Close audio context after the sound finishes
    setTimeout(() => void ctx.close(), 600);
  } catch {
    // AudioContext may be unavailable or blocked
  }
}

/**
 * Tracks tab visibility and provides a `notify` function that:
 * 1. Changes the document title when the tab is hidden
 * 2. Sends a browser Notification (if permission was granted and setting is on)
 * 3. Plays a notification sound (if setting is on)
 *
 * The title reverts when the user returns to the tab.
 */
export function useNotification() {
  const hiddenRef = useRef(document.hidden);
  const titleChangedRef = useRef(false);

  // Track tab visibility
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const onVisibilityChange = () => {
      hiddenRef.current = document.hidden;

      // Restore title when user returns to the tab
      if (!document.hidden && titleChangedRef.current) {
        document.title = DEFAULT_TITLE;
        titleChangedRef.current = false;
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const notify = useCallback((body: string, context?: NotifyContext) => {
    const { notifyOnFinish, soundOnFinish } = useSettingsStore.getState();

    // Sound plays regardless of tab visibility
    if (soundOnFinish) {
      playNotificationSound();
    }

    if (!hiddenRef.current) return;

    // Tab title change (always, when hidden)
    document.title = doneTitle(context?.sessionName);
    titleChangedRef.current = true;

    // Browser notification — include repo and session context
    if (notifyOnFinish && typeof Notification !== "undefined" && Notification.permission === "granted") {
      const title = context?.repoLabel ? `ShipIt · ${context.repoLabel}` : "ShipIt";
      const fullBody = context?.sessionName ? `[${context.sessionName}] ${body}` : body;
      const n = new Notification(title, { body: fullBody });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    }
  }, []);

  const requestPermission = useCallback(() => {
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      void Notification.requestPermission();
    }
  }, []);

  return { notify, requestPermission };
}
