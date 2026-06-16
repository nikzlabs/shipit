/**
 * DiagnosticsPanel — the diagnostic/notice output region rendered below the
 * SessionHealthStrip's top row: the OOM circuit-breaker banner, the idle /
 * memory-pressure pause notice, the interrupt-error toast, the phased
 * recovery-failure banner, the inline container-creation error, and the
 * mount point for the full SessionDiagnosticsPanel modal.
 *
 * See docs/124-session-rescue-and-diagnostics.
 */

import { SessionDiagnosticsPanel } from "../SessionDiagnosticsPanel.js";
import { useSessionStore } from "../../stores/session-store.js";
import {
  type ContainerHealth,
  formatIdleDuration,
  formatStaleness,
} from "./utils/healthState.js";

export interface DiagnosticsPanelProps {
  sessionId: string;
  health: ContainerHealth | null;
  diagnosticsOpen: boolean;
  onDiagnosticsOpenChange: (open: boolean) => void;
}

export function DiagnosticsPanel({
  sessionId,
  health,
  diagnosticsOpen,
  onDiagnosticsOpenChange,
}: DiagnosticsPanelProps) {
  const rescueState = useSessionStore((s) => s.rescueState);
  const setRescueState = useSessionStore((s) => s.setRescueState);
  const interruptError = useSessionStore((s) => s.interruptError);
  const setInterruptError = useSessionStore((s) => s.setInterruptError);
  const pauseNotice = useSessionStore((s) => s.pauseNotice);
  const setPauseNotice = useSessionStore((s) => s.setPauseNotice);
  const memoryExhausted = useSessionStore((s) => s.memoryExhausted);
  const setMemoryExhausted = useSessionStore((s) => s.setMemoryExhausted);

  // Surface a creation error from the server alongside any client-side
  // action error. The server-side error is the primary signal when the
  // factory's async create failed (Docker error, image missing, etc.).
  const createError = health?.lastCreateError ?? null;

  return (
    <>
      {/* OOM circuit breaker tripped — the orchestrator has stopped
          recreating the container after repeated agent-container OOM
          kills. Without this banner the user only sees a stuck spinner
          plus a buried Logs entry; with it they get the actionable retry
          path (raise `agent.memory` + Rescue session) up front. Cleared
          automatically when the container is running again (which happens
          after Rescue resets the breaker). */}
      {memoryExhausted && (
        <div
          role="status"
          className="px-3 py-1.5 border-t border-(--color-error)/40 bg-(--color-error)/10 flex items-center gap-2"
        >
          <span className="flex-1 text-(--color-text-primary)">
            <strong className="text-(--color-error)">Session disabled — agent container OOM-killed {memoryExhausted.countInWindow} times.</strong>
            <span className="ml-1 text-(--color-text-secondary)">
              Increase <code className="px-1 rounded bg-(--color-surface-2)">agent.memory</code> in <code className="px-1 rounded bg-(--color-surface-2)">shipit.yaml</code>, then use <strong>Rescue session</strong> to retry.
            </span>
          </span>
          <button
            type="button"
            onClick={() => setMemoryExhausted(null)}
            className="text-(--color-text-tertiary) hover:text-(--color-text-primary) text-xs"
          >
            Dismiss
          </button>
        </div>
      )}
      {/* Idle / memory-pressure pause notice — converts the silent
          "container went away" state into an explicit "send a message to
          resume" banner. Cleared automatically when the container is
          running again. See docs/124-session-rescue-and-diagnostics §1.6. */}
      {pauseNotice && (
        <div
          role="status"
          className="px-3 py-1.5 border-t border-(--color-warning)/40 bg-(--color-warning)/10 flex items-center gap-2"
        >
          <span className="flex-1 text-(--color-text-primary)">
            {pauseNotice.reason === "memory-pressure"
              ? "Session container shut down to reclaim memory."
              : pauseNotice.idleMs && pauseNotice.idleMs > 0
                ? `Session container shut down after ${formatIdleDuration(pauseNotice.idleMs)} idle.`
                : "Session container shut down after idle timeout."}
            <span className="ml-1 text-(--color-text-secondary)">Your workspace is preserved — send a message to resume.</span>
          </span>
          <button
            type="button"
            onClick={() => setPauseNotice(null)}
            className="text-(--color-text-tertiary) hover:text-(--color-text-primary) text-xs"
          >
            Dismiss
          </button>
        </div>
      )}
      {/* Non-blocking interrupt-error toast — best-effort kill failures
          (Rescue session pre-destroy kill, Interrupt on a wedged worker)
          land here so the user gets feedback without a hard error block.
          See docs/124-session-rescue-and-diagnostics §1.4. */}
      {interruptError && (
        <div
          role="status"
          className="px-3 py-1.5 border-t border-(--color-warning)/40 bg-(--color-warning)/10 flex items-center gap-2"
        >
          <span className="flex-1 text-(--color-text-primary) truncate" title={interruptError}>
            {interruptError}
          </span>
          <button
            type="button"
            onClick={() => setInterruptError(null)}
            className="text-(--color-text-tertiary) hover:text-(--color-text-primary) text-xs"
          >
            Dismiss
          </button>
        </div>
      )}
      {/* Phased recovery failure — deep-links to the diagnostics panel
          so the user can see *which* phase hung. Shared between Rescue
          session and Restart agent (both surface phased progress via
          `container_restarting` / `rescueState`); copy stays neutral so
          it makes sense for either action's failure. */}
      {rescueState?.phase === "failed" && (
        <div className="px-3 py-1.5 border-t border-(--color-border-secondary) bg-(--color-bg-tertiary) flex items-center gap-2">
          <span className="text-(--color-error) font-medium">
            Recovery failed{rescueState.reason ? ` (${rescueState.reason})` : ""}
          </span>
          {rescueState.message && (
            <span className="text-(--color-text-secondary) font-mono truncate">{rescueState.message}</span>
          )}
          <button
            type="button"
            onClick={() => {
              setRescueState(null);
              onDiagnosticsOpenChange(true);
            }}
            className="ml-auto text-(--color-text-primary) underline hover:text-(--color-text-secondary)"
          >
            Open diagnostics
          </button>
        </div>
      )}
      {/* Server-side creation error always renders inline (no toggle) — it's
          the most actionable signal when the container is missing. */}
      {createError && (
        <div className="px-3 py-1.5 border-t border-(--color-border-secondary) bg-(--color-bg-tertiary)">
          <div className="text-(--color-error) font-medium mb-0.5">
            Container creation failed
            {health?.lastCreateErrorAt && (
              <span className="font-normal text-(--color-text-tertiary) ml-1.5">
                ({formatStaleness(health.lastCreateErrorAt)})
              </span>
            )}
          </div>
          <div className="text-(--color-text-secondary) font-mono whitespace-pre-wrap break-all">
            {createError}
          </div>
        </div>
      )}
      <SessionDiagnosticsPanel
        sessionId={sessionId}
        open={diagnosticsOpen}
        onOpenChange={onDiagnosticsOpenChange}
      />
    </>
  );
}
