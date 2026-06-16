/**
 * RecoveryActions — the right side of the SessionHealthStrip top row: the
 * details toggle, the Diagnostics button, and the three recovery actions
 * (Kill agent, Restart agent, Rescue session). Owns the recovery handler
 * logic and the local "killing" spinner state.
 *
 * The recovery actions let the user recover from a hung session without
 * opening a terminal outside ShipIt. See docs/112-container-recovery,
 * docs/124-session-rescue-and-diagnostics, and docs/127-restart-agent.
 */

import { useState, useCallback } from "react";
import {
  ArrowsClockwiseIcon,
  SkullIcon,
  CircleNotchIcon,
  CaretDownIcon,
  CaretUpIcon,
  StethoscopeIcon,
  CpuIcon,
} from "@phosphor-icons/react";
import { Button } from "../ui/button.js";
import { useApi, ApiError } from "../../hooks/useApi.js";
import { ICON_SIZE } from "../../design-tokens.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { RestartContainerResult } from "./utils/healthState.js";

export interface RecoveryActionsProps {
  sessionId: string;
  /** Whether a restart is in flight (disables actions, shows spinners). */
  isRestarting: boolean;
  /** Whether the agent can be killed (worker reachable + agent running). */
  canKillAgent: boolean;
  /** Re-poll container health. Called after kill/restart. */
  poll: () => Promise<void>;
  /**
   * Called after a successful container restart to force the per-session
   * WebSocket to reconnect. Reconnection triggers session activation,
   * which causes the runner factory to create a fresh container.
   */
  onReconnectWs: () => void;
  showDetails: boolean;
  onToggleDetails: () => void;
  onOpenDiagnostics: () => void;
}

export function RecoveryActions({
  sessionId,
  isRestarting,
  canKillAgent,
  poll,
  onReconnectWs,
  showDetails,
  onToggleDetails,
  onOpenDiagnostics,
}: RecoveryActionsProps) {
  const api = useApi();
  const [isKilling, setIsKilling] = useState(false);
  const setRescueState = useSessionStore((s) => s.setRescueState);
  const setActionError = useSessionStore((s) => s.setRecoveryActionError);

  const onKill = useCallback(async () => {
    if (!sessionId) return;
    setIsKilling(true);
    setActionError(null);
    try {
      await api.post(`/api/sessions/${sessionId}/agent/kill`);
      void poll();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setIsKilling(false);
    }
  }, [api, sessionId, poll, setActionError]);

  const onRestart = useCallback(async () => {
    if (!sessionId) return;
    const startedAt = Date.now();
    setActionError(null);
    setRescueState({ phase: "stopping_stack", startedAt });
    try {
      const result = await api.post<RestartContainerResult>(
        `/api/sessions/${sessionId}/container/restart`,
      );
      // Triggering a fresh WS handshake makes the session worker reattach
      // to the new container the recovery service just kicked off.
      onReconnectWs();
      // If the server already saw a definitive outcome inside its readiness
      // window, surface it without waiting for the next poll. We re-read
      // rescueState from the live store so a concurrent poll that flipped
      // it to "ready" doesn't get clobbered here.
      if (result.newContainerState === "running") {
        const rs = useSessionStore.getState().rescueState;
        if (rs && rs.phase !== "ready" && rs.phase !== "failed") {
          setRescueState({ phase: "ready", startedAt });
          setTimeout(() => {
            if (useSessionStore.getState().rescueState?.phase === "ready") {
              setRescueState(null);
            }
          }, 1500);
        }
      } else if (result.newContainerState === "missing" && result.error) {
        setActionError(`Rescue failed: ${result.error}`);
        setRescueState({
          phase: "failed",
          reason: "create_failed",
          message: result.error,
          startedAt,
        });
      }
      void poll();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      setActionError(`Rescue failed: ${msg}`);
      setRescueState({
        phase: "failed",
        reason: "request_error",
        message: msg,
        startedAt,
      });
    }
  }, [api, sessionId, onReconnectWs, poll, setRescueState, setActionError]);

  /**
   * Restart the agent container only — leaves the compose stack running.
   * Lighter-weight than Rescue session; intended for "the agent is wedged
   * but the compose preview is fine." See docs/127-restart-agent.
   *
   * Uses the same overlay state machine as `onRestart` (the new container
   * goes through `destroying_container` → `creating_container` → `ready`
   * server-side) so the strip's existing poll-driven finalize logic
   * applies unchanged.
   */
  const onRestartAgent = useCallback(async () => {
    if (!sessionId) return;
    const startedAt = Date.now();
    setActionError(null);
    setRescueState({ phase: "restarting_agent", startedAt });
    try {
      const result = await api.post<RestartContainerResult>(
        `/api/sessions/${sessionId}/agent/container/restart`,
      );
      onReconnectWs();
      if (result.newContainerState === "running") {
        const rs = useSessionStore.getState().rescueState;
        if (rs && rs.phase !== "ready" && rs.phase !== "failed") {
          setRescueState({ phase: "ready", startedAt });
          setTimeout(() => {
            if (useSessionStore.getState().rescueState?.phase === "ready") {
              setRescueState(null);
            }
          }, 1500);
        }
      } else if (result.newContainerState === "missing" && result.error) {
        setActionError(`Restart agent failed: ${result.error}`);
        setRescueState({
          phase: "failed",
          reason: "create_failed",
          message: result.error,
          startedAt,
        });
      }
      void poll();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      setActionError(`Restart agent failed: ${msg}`);
      setRescueState({
        phase: "failed",
        reason: "request_error",
        message: msg,
        startedAt,
      });
    }
  }, [api, sessionId, onReconnectWs, poll, setRescueState, setActionError]);

  return (
    <div className="flex items-center gap-2 shrink-0">
      <button
        type="button"
        onClick={onToggleDetails}
        className="inline-flex items-center gap-0.5 px-1.5 py-1 rounded text-(--color-text-tertiary) hover:text-(--color-text-primary) hover:bg-(--color-bg-tertiary) transition-colors"
        title={showDetails ? "Hide diagnostics" : "Show diagnostics"}
      >
        details
        {showDetails
          ? <CaretUpIcon size={ICON_SIZE.XS} />
          : <CaretDownIcon size={ICON_SIZE.XS} />}
      </button>
      <Button
        variant="ghost"
        size="md"
        onClick={onOpenDiagnostics}
        title="Open the full diagnostics panel — services, runner, recent logs. Use this for bug reports."
      >
        <StethoscopeIcon size={ICON_SIZE.XS} />
        Diagnostics
      </Button>
      <Button
        variant="ghost"
        size="md"
        onClick={() => void onKill()}
        disabled={isKilling || isRestarting || !canKillAgent}
        title={canKillAgent ? "Force-kill the agent process (SIGKILL). Use when interrupt didn't take." : "No agent running"}
      >
        {isKilling
          ? <CircleNotchIcon size={ICON_SIZE.XS} className="animate-spin" />
          : <SkullIcon size={ICON_SIZE.XS} />}
        Kill agent
      </Button>
      <Button
        variant="ghost"
        size="md"
        onClick={() => void onRestartAgent()}
        disabled={isRestarting}
        title="Destroy and recreate just the agent container. Leaves the compose stack running — use when the agent is wedged but your preview/dev-server are fine."
      >
        {isRestarting
          ? <CircleNotchIcon size={ICON_SIZE.XS} className="animate-spin" />
          : <CpuIcon size={ICON_SIZE.XS} />}
        Restart agent
      </Button>
      <Button
        variant="secondary"
        size="md"
        onClick={() => void onRestart()}
        disabled={isRestarting}
        title="Stop the compose stack, destroy the agent container, then recreate everything from scratch. Use when the session is wedged."
      >
        {isRestarting
          ? <CircleNotchIcon size={ICON_SIZE.XS} className="animate-spin" />
          : <ArrowsClockwiseIcon size={ICON_SIZE.XS} />}
        Rescue session
      </Button>
    </div>
  );
}
