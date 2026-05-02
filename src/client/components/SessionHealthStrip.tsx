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
import { ArrowsClockwiseIcon, SkullIcon, CircleNotchIcon } from "@phosphor-icons/react";
import { Button } from "./ui/button.js";
import { StatusDot } from "./ui/status-dot.js";
import { useApi, ApiError } from "../hooks/useApi.js";
import { ICON_SIZE } from "../design-tokens.js";

type ContainerState = "running" | "starting" | "stopping" | "stopped" | "missing" | "unknown";

interface ContainerHealth {
  containerState: ContainerState;
  workerReachable: boolean;
  workerLatencyMs: number | null;
  agentRunning: boolean | null;
  lastEventAt: number | null;
  runnerRunningFlag: boolean | null;
  viewerCount: number | null;
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

/** SSE staleness threshold — beyond this, surface a yellow warning. */
const STALE_EVENT_THRESHOLD_MS = 30_000;

type Severity = "ok" | "warn" | "error" | "unknown";

function summarize(health: ContainerHealth | null, isRestarting: boolean): { severity: Severity; label: string } {
  if (isRestarting) return { severity: "warn", label: "Restarting…" };
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
  const [isRestarting, setIsRestarting] = useState(false);
  const [isKilling, setIsKilling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Use a ref so the polling effect doesn't restart on every health update.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const poll = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const data = await api.get<ContainerHealth>(`/api/sessions/${sid}/container/health`);
      setHealth(data);
      setError(null);
      // If a restart was in flight and the container is back up, clear
      // the overlay. The fresh container won't necessarily have the
      // worker reachable yet on the first probe after reconnect —
      // require both signals to be green.
      if (data.containerState === "running" && data.workerReachable) {
        setIsRestarting(false);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, [api]);

  // Reset all per-session UI state when the active session changes. Without
  // this, an "actionError" or "isRestarting" overlay from a previous session
  // bleeds into the next one (the component is mounted once in TerminalPanel
  // without a key prop, so React reuses the same instance across switches).
  // eslint-disable-next-line no-restricted-syntax -- resetting derived UI state on prop change
  useEffect(() => {
    setHealth(null);
    setError(null);
    setActionError(null);
    setIsRestarting(false);
    setIsKilling(false);
  }, [sessionId]);

  // Poll on mount and every POLL_INTERVAL_MS while a session is selected.
  // eslint-disable-next-line no-restricted-syntax -- existing usage pattern: polling external state
  useEffect(() => {
    if (!sessionId) return;
    void poll();
    const id = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [sessionId, poll]);

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
    setIsRestarting(true);
    setActionError(null);
    try {
      await api.post(`/api/sessions/${sessionId}/container/restart`);
      // Triggering a fresh WS handshake makes the session worker spin up
      // a new container via the runner factory. Without this, the WS
      // sits idle on a disposed runner.
      onReconnectWs();
      void poll();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
      setIsRestarting(false);
    }
  }, [api, sessionId, onReconnectWs, poll]);

  if (!sessionId) {
    return (
      <div className="flex items-center justify-between px-3 py-1.5 bg-(--color-bg-secondary) border-b border-(--color-border-secondary) text-xs text-(--color-text-tertiary)">
        <span>No active session</span>
      </div>
    );
  }

  const summary = summarize(health, isRestarting);
  const canKillAgent = !!health?.workerReachable && health.agentRunning === true;

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5 bg-(--color-bg-secondary) border-b border-(--color-border-secondary) text-xs">
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
          variant="secondary"
          size="sm"
          onClick={() => void onRestart()}
          disabled={isRestarting}
          title="Stop and recreate this session's container. Use when the worker is unresponsive."
        >
          {isRestarting
            ? <CircleNotchIcon size={ICON_SIZE.XS} className="animate-spin" />
            : <ArrowsClockwiseIcon size={ICON_SIZE.XS} />}
          Restart container
        </Button>
      </div>
    </div>
  );
}
