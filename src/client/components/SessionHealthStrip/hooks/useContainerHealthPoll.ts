/**
 * useContainerHealthPoll — owns the container-health poll loop for the
 * SessionHealthStrip: the poll cadence (regular vs. fast while restarting),
 * the late-response stale-session guard, and the poll-driven finalize logic
 * that flips `rescueState` to ready/failed.
 *
 * Health probes are deliberately a separate channel from the worker SSE
 * stream — when SSE breaks (a common hang mode), this poll is the one
 * channel that can still tell the user what's wrong. See
 * docs/112-container-recovery/plan.md and
 * docs/124-session-rescue-and-diagnostics §3.4.
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: health polling interval (external system sync)
import { useEffect, useState, useCallback, useRef } from "react";
import { useApi, ApiError } from "../../../hooks/useApi.js";
import { useSessionStore } from "../../../stores/session-store.js";
import {
  type ContainerHealth,
  POLL_INTERVAL_MS,
  RESTART_POLL_INTERVAL_MS,
} from "../utils/healthState.js";

export interface UseContainerHealthPoll {
  health: ContainerHealth | null;
  error: string | null;
  poll: () => Promise<void>;
  setHealth: (health: ContainerHealth | null) => void;
  setError: (error: string | null) => void;
}

export function useContainerHealthPoll(
  sessionId: string | undefined,
  isRestarting: boolean,
): UseContainerHealthPoll {
  const api = useApi();
  const [health, setHealth] = useState<ContainerHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setRescueState = useSessionStore((s) => s.setRescueState);
  const setPauseNotice = useSessionStore((s) => s.setPauseNotice);
  const setMemoryExhausted = useSessionStore((s) => s.setMemoryExhausted);

  // Use a ref so the polling effect doesn't restart on every health update.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const poll = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const data = await api.get<ContainerHealth>(`/api/sessions/${sid}/container/health`);
      // Guard against late-arriving responses from a previous session.
      // When the user switches sessions, an in-flight fetch for the old
      // session can resolve AFTER the new session's poll has already set
      // fresh state. Without this check we'd overwrite the new state with
      // the previous session's data, causing the strip to flicker between
      // "Idle" / "Agent running" until the stale responses drain. The
      // request URL embeds `sid`, so by the time we land here the response
      // is unambiguously for `sid` — we just have to make sure `sid` is
      // still the active session.
      if (sid !== sessionIdRef.current) return;
      setHealth(data);
      setError(null);
      // Clear the "Restarting…" overlay when we have a definitive outcome:
      //   1. Success — container is running AND worker is reachable.
      //   2. Failure — a fresh creation error landed AFTER the restart click.
      // Without (2) the user was stuck on the spinner forever whenever
      // creation failed (Docker error, image missing, etc.) — the symptom
      // that prompted the bug report.
      //
      // Also drive the phased Rescue session overlay from the poll loop:
      // when the new container is up, transition to ready (and auto-clear);
      // when a fresh create error landed, transition to failed. The WS
      // reconnect path doesn't replay the new runner's turn-event buffer
      // (see index.ts:551), so the strip's poll is the only reliable
      // source of truth for "did the rescue actually finish?". See
      // docs/124-session-rescue-and-diagnostics §3.4.
      if (data.containerState === "running" && data.workerReachable) {
        // The session is back — clear any "paused" banner from the previous
        // disposal so the user doesn't see a stale notice. Same for the
        // OOM-exhausted banner: a running container means the breaker has
        // been reset (by Rescue / restart-agent) and the trip is moot.
        if (useSessionStore.getState().pauseNotice) setPauseNotice(null);
        if (useSessionStore.getState().memoryExhausted) setMemoryExhausted(null);
        const rs = useSessionStore.getState().rescueState;
        if (rs && rs.phase !== "ready" && rs.phase !== "failed") {
          setRescueState({
            phase: "ready",
            ...(rs.startedAt !== undefined ? { startedAt: rs.startedAt } : {}),
          });
          setTimeout(() => {
            if (useSessionStore.getState().rescueState?.phase === "ready") {
              setRescueState(null);
            }
          }, 1500);
        }
      } else {
        // Mirror lastCreateError into rescueState=failed when the error is
        // newer than this restart's startedAt — otherwise a stale error from
        // a prior failed attempt would prematurely flip the UI to "failed".
        // Resolve startedAt off the live store so concurrent renders don't
        // race with a snapshot taken at the top of poll().
        const rs = useSessionStore.getState().rescueState;
        const startedAt = rs?.startedAt;
        if (
          data.lastCreateError &&
          data.lastCreateErrorAt !== null &&
          startedAt &&
          data.lastCreateErrorAt >= startedAt &&
          rs && rs.phase !== "failed"
        ) {
          setRescueState({
            phase: "failed",
            reason: "create_failed",
            message: data.lastCreateError,
            startedAt,
          });
        }
      }
    } catch (e) {
      // Same stale-session guard as the success branch — a failed poll
      // for the previous session shouldn't surface as an error on the
      // newly-active session.
      if (sid !== sessionIdRef.current) return;
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, [api, setRescueState, setPauseNotice, setMemoryExhausted]);

  // Poll on mount; cadence depends on whether a restart is in flight. While
  // restarting, poll fast so the new container's transition to "running"
  // (or the surfaced creation error) is reflected within ~1.5s instead of
  // the regular 10s window.
  // eslint-disable-next-line no-restricted-syntax -- existing usage pattern: polling external state
  useEffect(() => {
    if (!sessionId) return;
    void poll();
    const interval = isRestarting ? RESTART_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
    const id = setInterval(() => void poll(), interval);
    return () => clearInterval(id);
  }, [sessionId, poll, isRestarting]);

  // Re-render once a second when the strip cares about elapsed time
  // (last event "47s ago" needs to tick). Cheap — only this component.
  const [, force] = useState(0);
  const lastEventAt = health?.lastEventAt ?? null;
  // eslint-disable-next-line no-restricted-syntax -- needs to tick the elapsed-time label every second
  useEffect(() => {
    if (lastEventAt === null) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [lastEventAt]);

  return { health, error, poll, setHealth, setError };
}
