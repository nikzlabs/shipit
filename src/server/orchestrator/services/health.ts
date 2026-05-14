/**
 * Container health service — aggregates the four signals the
 * SessionHealthStrip needs into one HTTP response.
 *
 * Used by the recovery flow (docs/112-container-recovery): when a
 * session feels "stuck," the user (and we) need to know which layer
 * is broken — Docker container, worker HTTP, agent process, or SSE
 * stream — to pick the right recovery action.
 *
 * The health probes are isolated from the worker SSE stream by design:
 * when SSE breaks (a common hang mode), this poll is exactly the
 * channel the user needs to see status. Each worker HTTP call is
 * bounded by a short timeout so a wedged worker can't make this
 * endpoint hang.
 */

import type { SessionContainerManager } from "../session-container.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import { workerGet } from "../worker-http.js";
import { ServiceError } from "./types.js";

/** Short timeout for health probes — a wedged worker should fail fast. */
const HEALTH_PROBE_TIMEOUT_MS = 3000;

export type ContainerState = "running" | "starting" | "stopping" | "stopped" | "missing" | "unknown";

export interface ContainerHealth {
  /** Container lifecycle status as Docker reports it, plus "missing" when no container is tracked. */
  containerState: ContainerState;
  /** Whether the worker `/health` endpoint responded within the probe timeout. */
  workerReachable: boolean;
  /** Round-trip latency of the `/health` probe in ms, or null when unreachable. */
  workerLatencyMs: number | null;
  /** Whether the worker reports an agent is currently running. Null when worker is unreachable. */
  agentRunning: boolean | null;
  /**
   * Timestamp (Date.now()) of the most recent SSE event the orchestrator
   * received from the worker. 0 when no event has ever arrived. Compare
   * against `Date.now()` to compute "events stale 47s." Null for non-container
   * runners (no SSE stream).
   */
  lastEventAt: number | null;
  /**
   * Local view of the runner: is the orchestrator's `running` flag set?
   * Useful to surface mode-1 bugs where the worker thinks no agent is
   * running but the orchestrator's flag is stuck `true`.
   */
  runnerRunningFlag: boolean | null;
  /** Number of attached viewers (browsers connected via WS). */
  viewerCount: number | null;
  /**
   * Most recent container creation failure recorded by the runner factory.
   * Populated when async creation throws (Docker error, image missing,
   * resource exhaustion). Cleared on the next successful create or on
   * destroy. Surfaces the error message to the UI so the user can see why
   * "Restart container" didn't bring a container back.
   */
  lastCreateError: string | null;
  /** Timestamp (Date.now()) of `lastCreateError`, or null when no error. */
  lastCreateErrorAt: number | null;
  /** The container's worker URL, when known. Useful for debug display. */
  workerUrl: string | null;
  /** The container's Docker ID (short-prefix), when known. Useful for debug display. */
  containerId: string | null;
  /**
   * Resource limits the container was *actually created with*, in Docker
   * units (memory bytes, CPU quota µs per 100 ms period, pids count).
   * Null for non-container runners and for rediscovered/re-adopted
   * containers whose booted limits aren't known.
   *
   * Surfaced so the diagnostics panel can show booted-vs-parsed side by
   * side: the parsed `shipit.yaml` is read at request time and can
   * disagree with what the container booted on — exactly the
   * warm→claim incident where diagnostics showed `memory: 3072` while the
   * container ran on a 1 GiB cgroup.
   */
  bootedLimits: { memoryLimit: number; cpuQuota: number; pidsLimit: number } | null;
}

export interface ContainerHealthDeps {
  containerManager: SessionContainerManager | null;
  runnerRegistry: SessionRunnerRegistry;
}

/**
 * Probe the four health signals for a session. Returns a snapshot
 * suitable for direct serialization to the client.
 *
 * Throws ServiceError(404) if the session has no container manager
 * configured (e.g., test mode without Docker).
 */
export async function getContainerHealth(
  deps: ContainerHealthDeps,
  sessionId: string,
): Promise<ContainerHealth> {
  const { containerManager, runnerRegistry } = deps;
  if (!containerManager) {
    throw new ServiceError(404, "Container manager not available");
  }

  const sc = containerManager.get(sessionId);
  const runner = runnerRegistry.get(sessionId);
  const lastErr = containerManager.getLastCreateError(sessionId);

  // Container state — Docker is authoritative for this signal.
  let containerState: ContainerState = "missing";
  if (sc) containerState = sc.status;

  // No container yet → nothing to probe. Return early.
  if (sc?.status !== "running") {
    return {
      containerState,
      workerReachable: false,
      workerLatencyMs: null,
      agentRunning: null,
      lastEventAt: runner ? readLastEventAt(runner) : null,
      runnerRunningFlag: runner?.running ?? null,
      viewerCount: runner?.viewerCount ?? null,
      lastCreateError: lastErr?.error ?? null,
      lastCreateErrorAt: lastErr?.at ?? null,
      workerUrl: sc?.workerUrl ?? null,
      containerId: sc?.id ? sc.id.slice(0, 12) : null,
      bootedLimits: sc?.bootedLimits ?? null,
    };
  }

  // Probe worker /health and /agent/status in parallel with a short timeout.
  const probeStart = Date.now();
  const probeLatency = async (): Promise<number | null> => {
    try {
      await workerGet(sc.workerUrl, "/health", { timeoutMs: HEALTH_PROBE_TIMEOUT_MS });
      return Date.now() - probeStart;
    } catch {
      return null;
    }
  };
  const probeAgent = async (): Promise<boolean | null> => {
    try {
      const res = await workerGet(sc.workerUrl, "/agent/status", { timeoutMs: HEALTH_PROBE_TIMEOUT_MS });
      const r = (res as { running?: unknown }).running;
      return typeof r === "boolean" ? r : null;
    } catch {
      return null;
    }
  };
  const [latency, agentRunning] = await Promise.all([probeLatency(), probeAgent()]);

  return {
    containerState,
    workerReachable: latency !== null,
    workerLatencyMs: latency,
    agentRunning,
    lastEventAt: runner ? readLastEventAt(runner) : null,
    runnerRunningFlag: runner?.running ?? null,
    viewerCount: runner?.viewerCount ?? null,
    lastCreateError: lastErr?.error ?? null,
    lastCreateErrorAt: lastErr?.at ?? null,
    workerUrl: sc.workerUrl,
    containerId: sc.id ? sc.id.slice(0, 12) : null,
    bootedLimits: sc.bootedLimits ?? null,
  };
}

/**
 * Read `lastSseEventAt` from a runner without forcing every implementation
 * to expose it. Direct (in-process) runners don't have an SSE stream at
 * all — for them this is always null.
 */
function readLastEventAt(runner: { lastSseEventAt?: number }): number | null {
  return typeof runner.lastSseEventAt === "number" && runner.lastSseEventAt > 0
    ? runner.lastSseEventAt
    : null;
}
