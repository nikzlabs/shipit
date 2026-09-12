

// eslint-disable-next-line no-restricted-imports -- useEffect: derived UI-state resets + timeouts
import { useEffect, useState, useRef } from "react";
import { useSessionStore } from "../../stores/session-store.js";
import { useContainerHealthPoll } from "./hooks/useContainerHealthPoll.js";
import { PHASE_LABEL, RESTART_OVERLAY_TIMEOUT_MS } from "./utils/healthState.js";
import { HealthSummary } from "./HealthSummary.js";
import { HealthDetails } from "./HealthDetails.js";
import { RecoveryActions } from "./RecoveryActions.js";
import { DiagnosticsPanel } from "./DiagnosticsPanel.js";

export interface SessionHealthStripProps {

  sessionId: string | undefined;

  onReconnectWs: () => void;
}

export function SessionHealthStrip({ sessionId, onReconnectWs }: SessionHealthStripProps) {
  const [showDetails, setShowDetails] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const rescueState = useSessionStore((s) => s.rescueState);
  const setRescueState = useSessionStore((s) => s.setRescueState);
  const actionError = useSessionStore((s) => s.recoveryActionError);
  const setActionError = useSessionStore((s) => s.setRecoveryActionError);
  const interruptError = useSessionStore((s) => s.interruptError);
  const setInterruptError = useSessionStore((s) => s.setInterruptError);
  const setPauseNotice = useSessionStore((s) => s.setPauseNotice);
  const setMemoryExhausted = useSessionStore((s) => s.setMemoryExhausted);
  const phaseLabel = rescueState ? PHASE_LABEL[rescueState.phase] : null;

  const isRestarting =
    !!rescueState && rescueState.phase !== "ready" && rescueState.phase !== "failed";

  const restartStartedAt = rescueState?.startedAt ?? null;

  const { health, error, poll, setHealth, setError } = useContainerHealthPoll(
    sessionId,
    isRestarting,
  );

  // eslint-disable-next-line no-restricted-syntax -- transient toast auto-dismiss
  useEffect(() => {
    if (!interruptError) return;
    const id = setTimeout(() => setInterruptError(null), 8000);
    return () => clearTimeout(id);
  }, [interruptError, setInterruptError]);

  const prevSessionIdRef = useRef<string | undefined>(sessionId);
  // eslint-disable-next-line no-restricted-syntax -- resetting derived UI state on prop change
  useEffect(() => {
    if (prevSessionIdRef.current === sessionId) return;
    prevSessionIdRef.current = sessionId;
    setHealth(null);
    setError(null);
    setActionError(null);
    setRescueState(null);
    setInterruptError(null);
    setPauseNotice(null);
    setMemoryExhausted(null);
  }, [sessionId, setHealth, setError, setActionError, setRescueState, setInterruptError, setPauseNotice, setMemoryExhausted]);

  // tab switch mid-restart, the timeout must reflect when the user clicked

  // eslint-disable-next-line no-restricted-syntax -- timeout for derived UI state
  useEffect(() => {
    if (!isRestarting || !restartStartedAt) return;
    const elapsed = Date.now() - restartStartedAt;
    const remaining = RESTART_OVERLAY_TIMEOUT_MS - elapsed;
    if (remaining <= 0) {

      setRescueState({
        phase: "failed",
        reason: "timeout",
        message: "Restart timed out — the new container did not become ready. See diagnostics below.",
        startedAt: restartStartedAt,
      });
      setActionError("Restart timed out — the new container did not become ready. See diagnostics below.");
      return;
    }
    const id = setTimeout(() => {
      setRescueState({
        phase: "failed",
        reason: "timeout",
        message: "Restart timed out — the new container did not become ready. See diagnostics below.",
        startedAt: restartStartedAt,
      });
      setActionError("Restart timed out — the new container did not become ready. See diagnostics below.");
    }, remaining);
    return () => clearTimeout(id);
  }, [isRestarting, restartStartedAt, setRescueState, setActionError]);

  if (!sessionId) {
    return (
      <div className="flex items-center justify-between px-3 py-1.5 bg-(--color-bg-secondary) border-b border-(--color-border-secondary) text-xs text-(--color-text-tertiary)">
        <span>No active session</span>
      </div>
    );
  }

  const canKillAgent = !!health?.workerReachable && health.agentRunning === true;

  return (
    <div className="flex flex-col bg-(--color-bg-secondary) border-b border-(--color-border-secondary) text-xs">
      <div className="flex items-center justify-between gap-3 px-3 py-1.5">
        <HealthSummary
          health={health}
          isRestarting={isRestarting}
          phaseLabel={phaseLabel}
          error={error}
          actionError={actionError}
        />
        <RecoveryActions
          key={sessionId}
          sessionId={sessionId}
          isRestarting={isRestarting}
          canKillAgent={canKillAgent}
          poll={poll}
          onReconnectWs={onReconnectWs}
          showDetails={showDetails}
          onToggleDetails={() => setShowDetails((v) => !v)}
          onOpenDiagnostics={() => setDiagnosticsOpen(true)}
        />
      </div>
      <DiagnosticsPanel
        sessionId={sessionId}
        health={health}
        diagnosticsOpen={diagnosticsOpen}
        onDiagnosticsOpenChange={setDiagnosticsOpen}
      />
      {showDetails && (
        <HealthDetails sessionId={sessionId} health={health} error={error} />
      )}
    </div>
  );
}
