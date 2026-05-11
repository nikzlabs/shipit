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
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: health polling interval (external system sync)
import { useEffect, useState, useCallback, useRef } from "react";
import {
  ArrowsClockwiseIcon,
  SkullIcon,
  CircleNotchIcon,
  CaretDownIcon,
  CaretUpIcon,
  StethoscopeIcon,
  CpuIcon,
} from "@phosphor-icons/react";
import { Button } from "./ui/button.js";
import { StatusDot } from "./ui/status-dot.js";
import { useApi, ApiError } from "../hooks/useApi.js";
import { ICON_SIZE } from "../design-tokens.js";
import { SessionDiagnosticsPanel } from "./SessionDiagnosticsPanel.js";
import { useSessionStore } from "../stores/session-store.js";
import type { RescuePhase } from "../../server/shared/types.js";

type ContainerState = "running" | "starting" | "stopping" | "stopped" | "missing" | "unknown";

interface ContainerHealth {
  containerState: ContainerState;
  workerReachable: boolean;
  workerLatencyMs: number | null;
  agentRunning: boolean | null;
  lastEventAt: number | null;
  runnerRunningFlag: boolean | null;
  viewerCount: number | null;
  lastCreateError: string | null;
  lastCreateErrorAt: number | null;
  workerUrl: string | null;
  containerId: string | null;
}

interface RestartContainerResult {
  ok: true;
  noContainer: boolean;
  newContainerState: "running" | "starting" | "missing" | "pending";
  error: string | null;
}

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

/** Poll interval — short enough to feel responsive, long enough not to spam. */
const POLL_INTERVAL_MS = 10_000;

/**
 * Faster poll cadence while a restart is in flight, so the user gets quick
 * feedback (the new container typically reaches "running" in 2-5s and we
 * don't want to make them stare at a stale spinner).
 */
const RESTART_POLL_INTERVAL_MS = 1500;

/**
 * Hard ceiling on the "Restarting…" overlay. If the container still hasn't
 * become healthy after this window, clear the spinner so the user sees the
 * actual diagnostic state (container state, lastCreateError) instead of a
 * forever-spinning UI.
 */
const RESTART_OVERLAY_TIMEOUT_MS = 60_000;

/** SSE staleness threshold — beyond this, surface a yellow warning. */
const STALE_EVENT_THRESHOLD_MS = 30_000;

type Severity = "ok" | "warn" | "error" | "unknown";

/** Human-readable label per Rescue session phase. */
const PHASE_LABEL: Record<RescuePhase, string> = {
  stopping_stack: "Stopping services…",
  destroying_container: "Destroying container…",
  creating_container: "Recreating container…",
  starting_stack: "Starting services…",
  restarting_agent: "Restarting agent…",
  ready: "Restart complete",
  failed: "Restart failed",
};

function summarize(
  health: ContainerHealth | null,
  isRestarting: boolean,
  phaseLabel: string | null,
): { severity: Severity; label: string } {
  if (isRestarting) return { severity: "warn", label: phaseLabel ?? "Rescuing…" };
  if (!health) return { severity: "unknown", label: "Checking…" };

  // Container is gone or not running → error.
  if (health.containerState !== "running") {
    return { severity: "error", label: `Container ${health.containerState}` };
  }

  // Container running but worker is unreachable → error (this is mode 2).
  if (!health.workerReachable) {
    return { severity: "error", label: "Worker unreachable" };
  }

  // Worker reachable but state out of sync → warn.
  if (health.runnerRunningFlag === true && health.agentRunning === false) {
    return { severity: "warn", label: "Agent state out of sync" };
  }

  // Stale SSE → warn.
  if (
    health.lastEventAt !== null &&
    Date.now() - health.lastEventAt > STALE_EVENT_THRESHOLD_MS
  ) {
    return { severity: "warn", label: "Events stale" };
  }

  return { severity: "ok", label: health.agentRunning ? "Agent running" : "Idle" };
}

function dotStatus(severity: Severity): "success" | "warning" | "error" | "info" {
  if (severity === "ok") return "success";
  if (severity === "warn") return "warning";
  if (severity === "error") return "error";
  return "info";
}

function formatLatency(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatIdleDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.round(minutes / 60)}h`;
}

function formatStaleness(lastEventAt: number | null): string {
  if (lastEventAt === null) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - lastEventAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export function SessionHealthStrip({ sessionId, onReconnectWs }: SessionHealthStripProps) {
  const api = useApi();
  const [health, setHealth] = useState<ContainerHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isKilling, setIsKilling] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const rescueState = useSessionStore((s) => s.rescueState);
  const setRescueState = useSessionStore((s) => s.setRescueState);
  const actionError = useSessionStore((s) => s.recoveryActionError);
  const setActionError = useSessionStore((s) => s.setRecoveryActionError);
  const interruptError = useSessionStore((s) => s.interruptError);
  const setInterruptError = useSessionStore((s) => s.setInterruptError);
  const pauseNotice = useSessionStore((s) => s.pauseNotice);
  const setPauseNotice = useSessionStore((s) => s.setPauseNotice);
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

  // Auto-dismiss the interrupt-error toast after 8s — non-blocking by design.
  // eslint-disable-next-line no-restricted-syntax -- transient toast auto-dismiss
  useEffect(() => {
    if (!interruptError) return;
    const id = setTimeout(() => setInterruptError(null), 8000);
    return () => clearTimeout(id);
  }, [interruptError, setInterruptError]);

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
        // disposal so the user doesn't see a stale notice.
        if (useSessionStore.getState().pauseNotice) setPauseNotice(null);
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
  }, [api, setRescueState, setPauseNotice]);

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
  const prevSessionIdRef = useRef<string | undefined>(sessionId);
  // eslint-disable-next-line no-restricted-syntax -- resetting derived UI state on prop change
  useEffect(() => {
    if (prevSessionIdRef.current === sessionId) return;
    prevSessionIdRef.current = sessionId;
    setHealth(null);
    setError(null);
    setActionError(null);
    setIsKilling(false);
    setRescueState(null);
    setInterruptError(null);
    setPauseNotice(null);
  }, [sessionId, setActionError, setRescueState, setInterruptError, setPauseNotice]);

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
  }, [api, sessionId, poll]);

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

  if (!sessionId) {
    return (
      <div className="flex items-center justify-between px-3 py-1.5 bg-(--color-bg-secondary) border-b border-(--color-border-secondary) text-xs text-(--color-text-tertiary)">
        <span>No active session</span>
      </div>
    );
  }

  const summary = summarize(health, isRestarting, phaseLabel);
  const canKillAgent = !!health?.workerReachable && health.agentRunning === true;
  // Surface a creation error from the server alongside any client-side
  // action error. The server-side error is the primary signal when the
  // factory's async create failed (Docker error, image missing, etc.).
  const createError = health?.lastCreateError ?? null;

  return (
    <div className="flex flex-col bg-(--color-bg-secondary) border-b border-(--color-border-secondary) text-xs">
      <div className="flex items-center justify-between gap-3 px-3 py-1.5">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span className="flex items-center gap-1.5 shrink-0">
            <StatusDot status={dotStatus(summary.severity)} />
            <span className="font-medium text-(--color-text-primary)">{summary.label}</span>
          </span>
          {health && !isRestarting && (
            <>
              <span className="text-(--color-text-tertiary) truncate">
                container: <span className="text-(--color-text-secondary)">{health.containerState}</span>
              </span>
              <span className="text-(--color-text-tertiary) truncate">
                worker:{" "}
                <span className={health.workerReachable ? "text-(--color-text-secondary)" : "text-(--color-error)"}>
                  {health.workerReachable ? formatLatency(health.workerLatencyMs) : "unreachable"}
                </span>
              </span>
              <span className="text-(--color-text-tertiary) truncate">
                agent:{" "}
                <span className="text-(--color-text-secondary)">
                  {health.agentRunning === null ? "—" : health.agentRunning ? "running" : "idle"}
                </span>
              </span>
              {health.lastEventAt !== null && (
                <span className="text-(--color-text-tertiary) truncate">
                  last event:{" "}
                  <span className="text-(--color-text-secondary)">{formatStaleness(health.lastEventAt)}</span>
                </span>
              )}
            </>
          )}
          {error && !health && (
            <span className="text-(--color-error) truncate">{error}</span>
          )}
          {actionError && (
            <span className="text-(--color-error) truncate" title={actionError}>
              {actionError}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
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
            size="sm"
            onClick={() => setDiagnosticsOpen(true)}
            title="Open the full diagnostics panel — services, runner, recent logs. Use this for bug reports."
          >
            <StethoscopeIcon size={ICON_SIZE.XS} />
            Diagnostics
          </Button>
          <Button
            variant="ghost"
            size="sm"
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
            size="sm"
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
            size="sm"
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
      </div>
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
              ? "Session paused under memory pressure."
              : pauseNotice.idleMs && pauseNotice.idleMs > 0
                ? `Session paused after ${formatIdleDuration(pauseNotice.idleMs)} idle.`
                : "Session paused after idle timeout."}
            <span className="ml-1 text-(--color-text-secondary)">Send a message to resume.</span>
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
              setDiagnosticsOpen(true);
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
        onOpenChange={setDiagnosticsOpen}
      />
      {showDetails && (
        <div className="px-3 py-2 border-t border-(--color-border-secondary) bg-(--color-bg-tertiary) font-mono text-[11px] leading-relaxed">
          <DetailRow label="session" value={sessionId} />
          <DetailRow label="container" value={health?.containerState ?? "—"} />
          <DetailRow label="container id" value={health?.containerId ?? "—"} />
          <DetailRow label="worker url" value={health?.workerUrl ?? "—"} />
          <DetailRow
            label="worker"
            value={
              health
                ? health.workerReachable
                  ? `reachable (${formatLatency(health.workerLatencyMs)})`
                  : "unreachable"
                : "—"
            }
          />
          <DetailRow
            label="agent (worker)"
            value={
              health?.agentRunning === null || health?.agentRunning === undefined
                ? "—"
                : health.agentRunning ? "running" : "idle"
            }
          />
          <DetailRow
            label="runner.running"
            value={
              health?.runnerRunningFlag === null || health?.runnerRunningFlag === undefined
                ? "—"
                : String(health.runnerRunningFlag)
            }
          />
          <DetailRow
            label="viewers"
            value={
              health?.viewerCount === null || health?.viewerCount === undefined
                ? "—"
                : String(health.viewerCount)
            }
          />
          <DetailRow
            label="last sse event"
            value={health?.lastEventAt ? formatStaleness(health.lastEventAt) : "—"}
          />
          {error && <DetailRow label="poll error" value={error} valueClass="text-(--color-error)" />}
        </div>
      )}
    </div>
  );
}

function DetailRow({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex gap-2">
      <span className="text-(--color-text-tertiary) shrink-0 w-32">{label}</span>
      <span className={`text-(--color-text-secondary) break-all ${valueClass ?? ""}`}>{value}</span>
    </div>
  );
}
