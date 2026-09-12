

import { useState, useCallback } from "react";
import { Spinner } from "../Spinner.js";
import {
  ArrowsClockwiseIcon,
  SkullIcon, CaretDownIcon,
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

  isRestarting: boolean;

  canKillAgent: boolean;

  poll: () => Promise<void>;

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
          ? <Spinner size={ICON_SIZE.XS} />
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
          ? <Spinner size={ICON_SIZE.XS} />
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
          ? <Spinner size={ICON_SIZE.XS} />
          : <ArrowsClockwiseIcon size={ICON_SIZE.XS} />}
        Rescue session
      </Button>
    </div>
  );
}
