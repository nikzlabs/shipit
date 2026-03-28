// eslint-disable-next-line no-restricted-imports -- useEffect: browser event listeners (external system sync)
import { useEffect, useRef } from "react";

/**
 * Tracks user activity (mouse, keyboard, touch, visibility) and sends periodic
 * heartbeats to the server so the PR status poller stays active while the user
 * is engaged. When the user goes idle, heartbeats stop and the server pauses
 * expensive GraphQL polling.
 *
 * Heartbeats are sent at most every HEARTBEAT_INTERVAL_MS while the user is
 * active. Activity is detected via mousemove, keydown, touchstart, and
 * visibilitychange events.
 */

/** How often to send a heartbeat while the user is active (ms). */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** How long after last interaction before we consider the user idle (ms). */
const IDLE_TIMEOUT_MS = 30_000;

export function useActivityTracker(): void {
  const lastActivityRef = useRef(Date.now());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const apiHost = import.meta.env.VITE_API_HOST as string | undefined;
    const baseUrl = apiHost ? `${window.location.protocol}//${apiHost}` : "";

    function markActive() {
      lastActivityRef.current = Date.now();
    }

    function sendHeartbeat() {
      const idle = Date.now() - lastActivityRef.current > IDLE_TIMEOUT_MS;
      if (idle || document.hidden) return;

      fetch(`${baseUrl}/api/activity/heartbeat`, { method: "POST" }).catch(() => {
        // Best-effort — don't surface network errors for heartbeats
      });
    }

    // Send an initial heartbeat on mount
    sendHeartbeat();

    // Periodic heartbeat while active
    intervalRef.current = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

    function handleVisibilityChange() {
      if (!document.hidden) {
        markActive();
        // Send heartbeat immediately when tab becomes visible again
        sendHeartbeat();
      }
    }

    // Track user interactions
    window.addEventListener("mousemove", markActive);
    window.addEventListener("keydown", markActive);
    window.addEventListener("touchstart", markActive);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      window.removeEventListener("mousemove", markActive);
      window.removeEventListener("keydown", markActive);
      window.removeEventListener("touchstart", markActive);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);
}
