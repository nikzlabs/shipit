

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

  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const poll = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const data = await api.get<ContainerHealth>(`/api/sessions/${sid}/container/health`);

      if (sid !== sessionIdRef.current) return;
      setHealth(data);
      setError(null);

      if (data.containerState === "running" && data.workerReachable) {

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

      if (sid !== sessionIdRef.current) return;
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, [api, setRescueState, setPauseNotice, setMemoryExhausted]);

  // eslint-disable-next-line no-restricted-syntax -- existing usage pattern: polling external state
  useEffect(() => {
    if (!sessionId) return;
    void poll();
    const interval = isRestarting ? RESTART_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
    const id = setInterval(() => void poll(), interval);
    return () => clearInterval(id);
  }, [sessionId, poll, isRestarting]);

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
