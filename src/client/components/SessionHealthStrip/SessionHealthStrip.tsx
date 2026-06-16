/**
 * SessionHealthStrip — diagnostic + recovery affordances for a session's
 * agent container.
 *
 * See docs/112-container-recovery/plan.md. Surfaces four signals
 * (container state, worker reachability + latency, agent state, last
 * SSE event) by polling `GET /api/sessions/:id/container/health` every
 * 10s. Hosts two recovery actions (Kill agent, Restart container) so
 * the user can recover from a hung session without opening a terminal
 * outside ShipIt.
 *
 * Health probes are deliberately a separate channel from the worker
 * SSE stream — when SSE breaks (a common hang mode), this poll is the
 * one channel that can still tell the user what's wrong.
 *
 * This file is the container: it composes the poll hook
 * (`useContainerHealthPoll`), the summary/details/recovery rows, and the
 * diagnostics/notice region (`DiagnosticsPanel`). Severity mapping and
 * format helpers live in `utils/healthState.ts`.
 */

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
  /** Active session ID. When undefined, the strip renders a placeholder. */
  sessionId: string | undefined;
  /**
   * Called after a successful container restart to force the per-session
   * WebSocket to reconnect. Reconnection triggers session activation,
   * which causes the runner factory to create a fresh container.
   */
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

  /**
   * Whether a restart is in flight. Derived from `rescueState` rather than a
   * local `useState` so the in-flight indicator survives the SessionHealthStrip
   * being unmounted+remounted by a right-panel tab switch. Terminal phases
   * (`ready`, `failed`) are NOT in flight — the user has the final outcome.
   */
  const isRestarting =
    !!rescueState && rescueState.phase !== "ready" && rescueState.phase !== "failed";

  /**
   * Wall-clock timestamp when the most recent restart was issued. Used to
   * decide whether a server-side `lastCreateError` belongs to THIS restart
   * (newer than the click) vs. a stale error from before. Without this,
   * a leftover error from a previous attempt would prematurely clear the
   * spinner. Lives on `rescueState.startedAt` (Zustand) so a tab switch
   * during the 8-30 s creation window can't lose it.
   */
  const restartStartedAt = rescueState?.startedAt ?? null;

  const { health, error, poll, setHealth, setError } = useContainerHealthPoll(
    sessionId,
    isRestarting,
  );

  // Auto-dismiss the interrupt-error toast after 8s — non-blocking by design.
  // eslint-disable-next-line no-restricted-syntax -- transient toast auto-dismiss
  useEffect(() => {
    if (!interruptError) return;
    const id = setTimeout(() => setInterruptError(null), 8000);
    return () => clearTimeout(id);
  }, [interruptError, setInterruptError]);

  // Reset all per-session UI state when the active session changes. Without
  // this, an "actionError" or rescue overlay from a previous session bleeds
  // into the next one (the component is mounted once in TerminalPanel without
  // a key prop, so React reuses the same instance across session switches).
  //
  // CRITICAL: gate on an ACTUAL session-id change. Plain `useEffect(…, [sid])`
  // also fires on mount, which used to wipe in-flight rescue state every
  // time the SessionHealthStrip remounted — and the right-panel tabs
  // (Terminal / Preview / Docs) render via ternary, so any tab switch
  // during a restart caused a remount and an unwanted reset. The bug
  // surfaced as "click Restart agent → tab switch → comes back to
  // 'Container missing' with no overlay, no error, no logs."
  //
  // The recovery actions' local "killing" spinner is reset by keying
  // <RecoveryActions> on sessionId (it remounts on an actual switch).
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

  // Hard timeout on the "Restarting…" overlay so it can't get stuck
  // indefinitely if neither success nor a creation error ever lands
  // (e.g., the orchestrator is wedged or the container is in some
  // exotic intermediate state). The diagnostic strip below the spinner
  // will still be live, so the user has actionable info.
  //
  // Anchored to `rescueState.startedAt` (Zustand) rather than wall-clock from
  // a mount-time `Date.now()` — when the strip is unmounted+remounted by a
  // tab switch mid-restart, the timeout must reflect when the user clicked
  // the button, not when the component remounted. Otherwise a remount would
  // refresh the timer and the overlay could spin for 60s after a remount on
  // top of however long the original click was waiting.
  // eslint-disable-next-line no-restricted-syntax -- timeout for derived UI state
  useEffect(() => {
    if (!isRestarting || !restartStartedAt) return;
    const elapsed = Date.now() - restartStartedAt;
    const remaining = RESTART_OVERLAY_TIMEOUT_MS - elapsed;
    if (remaining <= 0) {
      // Already past the deadline (e.g. component remounted after the
      // timeout fired in a previous mount). Flip to failed immediately.
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
