import { useRef, useCallback } from "react";
import { useSettingsStore } from "../stores/settings-store.js";
import { useEventListener } from "./useEventListener.js";

const DEFAULT_TITLE = "ShipIt";

function doneTitle(sessionName?: string): string {
  if (sessionName) return `\u25cf ${sessionName} \u2014 ShipIt`;
  return "\u25cf Needs attention \u2014 ShipIt";
}

export interface NotifyContext {

  sessionName?: string;

  repoLabel?: string;
}

function playNotificationSound(): void {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;

    const notes = [
      { freq: 523.25, start: 0, duration: 0.15 },        
      { freq: 659.25, start: 0.15, duration: 0.25 },      
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

    setTimeout(() => void ctx.close(), 600);
  } catch {
    // AudioContext may be unavailable or blocked
  }
}

export function useNotification() {
  const hiddenRef = useRef(document.hidden);
  const titleChangedRef = useRef(false);
  const batchRef = useRef<{ count: number; timer: ReturnType<typeof setTimeout> | null }>({ count: 0, timer: null });

  useEventListener(document, "visibilitychange", () => {
    hiddenRef.current = document.hidden;

    if (!document.hidden && titleChangedRef.current) {
      document.title = DEFAULT_TITLE;
      titleChangedRef.current = false;
    }
  });

  const emitNotification = useCallback((body: string, context?: NotifyContext) => {
    const { notifyOnFinish, soundOnFinish } = useSettingsStore.getState();

    if (soundOnFinish) {
      playNotificationSound();
    }

    if (!hiddenRef.current) return;

    document.title = doneTitle(context?.sessionName);
    titleChangedRef.current = true;

    if (notifyOnFinish && typeof Notification !== "undefined" && Notification.permission === "granted") {
      const title = context?.repoLabel ? `ShipIt · ${context.repoLabel}` : "ShipIt";
      const fullBody = context?.sessionName ? `[${context.sessionName}] ${body}` : body;
      // Mobile Chrome throws "Illegal constructor" — there `Notification` must

      try {
        const n = new Notification(title, { body: fullBody });
        n.onclick = () => {
          window.focus();
          n.close();
        };
      } catch {
        // no-op on platforms that disallow direct construction
      }
    }
  }, []);

  const notify = useCallback((body: string, context?: NotifyContext) => {
    const batch = batchRef.current;
    batch.count += 1;
    if (batch.count === 1) {
      batch.timer = setTimeout(() => {
        batchRef.current = { count: 0, timer: null };
      }, 3000);
      emitNotification(body, context);
      return;
    }

    if (batch.timer) clearTimeout(batch.timer);
    const count = batch.count;
    batch.timer = setTimeout(() => {
      const { notifyOnFinish } = useSettingsStore.getState();
      batchRef.current = { count: 0, timer: null };
      if (hiddenRef.current) {
        document.title = `\u25cf ${count} sessions need attention \u2014 ShipIt`;
        titleChangedRef.current = true;
        if (notifyOnFinish && typeof Notification !== "undefined" && Notification.permission === "granted") {
          try {
            const n = new Notification("ShipIt", { body: `${count} sessions finished` });
            n.onclick = () => {
              window.focus();
              n.close();
            };
          } catch {
            // mobile Chrome disallows direct Notification construction
          }
        }
      }
    }, 3000);
  }, [emitNotification]);

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
