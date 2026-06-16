/**
 * Health-state types, constants, severity summarization, and format
 * helpers for the SessionHealthStrip. Pure data — no React.
 *
 * See docs/112-container-recovery/plan.md.
 */

import type { RescuePhase } from "../../../../server/shared/types.js";

export type ContainerState =
  | "running"
  | "starting"
  | "stopping"
  | "stopped"
  | "missing"
  | "unknown";

export interface ContainerHealth {
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

export interface RestartContainerResult {
  ok: true;
  noContainer: boolean;
  newContainerState: "running" | "starting" | "missing" | "pending";
  error: string | null;
}

/** Poll interval — short enough to feel responsive, long enough not to spam. */
export const POLL_INTERVAL_MS = 10_000;

/**
 * Faster poll cadence while a restart is in flight, so the user gets quick
 * feedback (the new container typically reaches "running" in 2-5s and we
 * don't want to make them stare at a stale spinner).
 */
export const RESTART_POLL_INTERVAL_MS = 1500;

/**
 * Hard ceiling on the "Restarting…" overlay. If the container still hasn't
 * become healthy after this window, clear the spinner so the user sees the
 * actual diagnostic state (container state, lastCreateError) instead of a
 * forever-spinning UI.
 */
export const RESTART_OVERLAY_TIMEOUT_MS = 60_000;

/** SSE staleness threshold — beyond this, surface a yellow warning. */
export const STALE_EVENT_THRESHOLD_MS = 30_000;

export type Severity = "ok" | "warn" | "error" | "unknown";

/** Human-readable label per Rescue session phase. */
export const PHASE_LABEL: Record<RescuePhase, string> = {
  stopping_stack: "Stopping services…",
  destroying_container: "Destroying container…",
  creating_container: "Recreating container…",
  starting_stack: "Starting services…",
  restarting_agent: "Restarting agent…",
  ready: "Restart complete",
  failed: "Restart failed",
};

export function summarize(
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

export function dotStatus(severity: Severity): "success" | "warning" | "error" | "info" {
  if (severity === "ok") return "success";
  if (severity === "warn") return "warning";
  if (severity === "error") return "error";
  return "info";
}

export function formatLatency(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatIdleDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.round(minutes / 60)}h`;
}

export function formatStaleness(lastEventAt: number | null): string {
  if (lastEventAt === null) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - lastEventAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}
