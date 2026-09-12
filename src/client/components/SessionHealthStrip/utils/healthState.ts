

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

export const POLL_INTERVAL_MS = 10_000;

export const RESTART_POLL_INTERVAL_MS = 1500;

export const RESTART_OVERLAY_TIMEOUT_MS = 60_000;

export const STALE_EVENT_THRESHOLD_MS = 30_000;

export type Severity = "ok" | "warn" | "error" | "unknown";

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

  if (health.containerState !== "running") {
    return { severity: "error", label: `Container ${health.containerState}` };
  }

  if (!health.workerReachable) {
    return { severity: "error", label: "Worker unreachable" };
  }

  if (health.runnerRunningFlag === true && health.agentRunning === false) {
    return { severity: "warn", label: "Agent state out of sync" };
  }

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
