// Probe health over HTTP so status remains available when the worker SSE stream fails.

import type { SessionContainerManager } from "../session-container.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import { workerGet } from "../worker-http.js";
import { ServiceError } from "./types.js";

const HEALTH_PROBE_TIMEOUT_MS = 3000;

export type ContainerState = "running" | "starting" | "stopping" | "stopped" | "missing" | "unknown";

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
  /** Creation-time limits: memory bytes, CPU µs per 100 ms, and PID count. */
  bootedLimits: { memoryLimit: number; cpuQuota: number; pidsLimit: number } | null;
}

export interface ContainerHealthDeps {
  containerManager: SessionContainerManager | null;
  runnerRegistry: SessionRunnerRegistry;
}

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

  let containerState: ContainerState = "missing";
  if (sc) containerState = sc.status;

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

function readLastEventAt(runner: { lastSseEventAt?: number }): number | null {
  return typeof runner.lastSseEventAt === "number" && runner.lastSseEventAt > 0
    ? runner.lastSseEventAt
    : null;
}
