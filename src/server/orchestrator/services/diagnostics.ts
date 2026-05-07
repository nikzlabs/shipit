/**
 * Session diagnostics service — single aggregate view of everything the
 * orchestrator knows about a session, suitable for either an interactive
 * panel or a one-shot bug-report payload.
 *
 * See docs/124-session-rescue-and-diagnostics §3.1 / §3.3.
 *
 * Composes:
 *   - {@link getContainerHealth}      → container/worker/SSE state
 *   - ServiceManager service map      → compose service status + log tails
 *   - SessionRunner state             → running flag, viewer count, queue
 *   - per-session log ring            → last N orchestrator log entries
 *
 * The endpoint is read-only and safe to call repeatedly. Worker probes
 * inherit the short timeout from `getContainerHealth` so a wedged worker
 * can't hang the request.
 */

import type { SessionContainerManager } from "../session-container.js";
import type { SessionRunnerRegistry, SessionRunnerInterface } from "../session-runner.js";
import type { ServiceManager, ManagedService } from "../service-manager.js";
import type { WsLogEntry } from "../../shared/types.js";
import { getContainerHealth, type ContainerHealth } from "./health.js";
import { ServiceError } from "./types.js";

/** Tail of the per-service compose log buffer included in diagnostics. */
const SERVICE_LOG_TAIL_LINES = 20;
/** Tail of the per-session orchestrator log ring included in diagnostics. */
const RECENT_LOG_LINES = 50;

export interface ServiceDiagnostic {
  name: string;
  status: ManagedService["status"];
  preview: ManagedService["preview"];
  port: number | null;
  containerIp: string | null;
  error: string | null;
  /** Tail of stdout/stderr captured by `docker compose logs -f`. */
  logTail: string;
}

export interface RunnerDiagnostic {
  /** Whether the runner thinks an agent is currently running. */
  running: boolean;
  /** Attached browser viewers. */
  viewerCount: number;
  /** Queued messages waiting for the agent to be free. */
  queueLength: number;
  /** Most recent SSE event timestamp (ms epoch). 0 = never. */
  lastSseEventAt: number;
  /** Number of events buffered for reconnecting viewers in the current turn. */
  turnEventBufferSize: number;
  /** Whether the runner has been disposed. */
  disposed: boolean;
}

export interface SessionDiagnostics {
  sessionId: string;
  /** Server-side ms epoch when this snapshot was assembled. */
  generatedAt: number;
  /**
   * Container/worker/SSE summary. When the container manager isn't
   * configured (test-mode / local runtime) this carries `{ error }` so
   * the panel can render the rest of the diagnostics anyway.
   */
  health: ContainerHealth | { error: string };
  /** One entry per compose-managed service. Empty when no compose stack. */
  services: ServiceDiagnostic[];
  /** Compose stack-level start error, if any. */
  stackStartError: string | null;
  runner: RunnerDiagnostic | null;
  /** Last {@link RECENT_LOG_LINES} orchestrator log entries for this session. */
  recentLogs: WsLogEntry[];
}

export interface DiagnosticsDeps {
  containerManager: SessionContainerManager | null;
  runnerRegistry: SessionRunnerRegistry;
  serviceManagers: Map<string, ServiceManager>;
  getLogBuffer: (sessionId: string) => WsLogEntry[];
}

/**
 * Get the full diagnostics payload for a session.
 *
 * Throws ServiceError(404) if the session doesn't exist (caller should
 * have validated, but we double-check via the runner registry).
 */
export async function getSessionDiagnostics(
  deps: DiagnosticsDeps,
  sessionId: string,
): Promise<SessionDiagnostics> {
  const { containerManager, runnerRegistry, serviceManagers, getLogBuffer } = deps;

  // Health probe — gracefully degrade when no container manager is
  // configured. The panel still has value for service + runner state.
  let health: ContainerHealth | { error: string };
  try {
    health = await getContainerHealth({ containerManager, runnerRegistry }, sessionId);
  } catch (err) {
    if (err instanceof ServiceError) {
      health = { error: err.message };
    } else {
      health = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  const mgr = serviceManagers.get(sessionId);
  const services: ServiceDiagnostic[] = mgr
    ? mgr.getServices().map((svc) => ({
        name: svc.name,
        status: svc.status,
        preview: svc.preview,
        port: svc.port ?? null,
        containerIp: svc.containerIp ?? null,
        error: svc.error ?? null,
        logTail: tailLines(mgr.getLogBuffer(svc.name), SERVICE_LOG_TAIL_LINES),
      }))
    : [];
  const stackStartError = mgr?.startError ?? null;

  const runner = runnerRegistry.get(sessionId);
  const runnerDiagnostic: RunnerDiagnostic | null = runner
    ? {
        running: runner.running,
        viewerCount: runner.viewerCount,
        queueLength: runner.queueLength,
        lastSseEventAt: typeof runner.lastSseEventAt === "number" ? runner.lastSseEventAt : 0,
        turnEventBufferSize: runner.getTurnEventBuffer().length,
        disposed: readDisposed(runner),
      }
    : null;

  const allLogs = getLogBuffer(sessionId);
  const recentLogs = allLogs.length > RECENT_LOG_LINES
    ? allLogs.slice(-RECENT_LOG_LINES)
    : allLogs.slice();

  return {
    sessionId,
    generatedAt: Date.now(),
    health,
    services,
    stackStartError,
    runner: runnerDiagnostic,
    recentLogs,
  };
}

/**
 * Return the last `n` lines of `text`. Trailing newline (if any) is
 * preserved on the last line. Empty input → empty string.
 */
function tailLines(text: string, n: number): string {
  if (!text) return "";
  const lines = text.split("\n");
  // split on a trailing "\n" produces an empty final element — drop it
  // so the count reflects real lines, then re-join with newlines.
  const trimmed = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  return trimmed.slice(-n).join("\n");
}

/**
 * `disposed` is private on ContainerSessionRunner but exposed via the
 * `disposed` getter. The SessionRunner interface doesn't promise it, so
 * read defensively.
 */
function readDisposed(runner: SessionRunnerInterface): boolean {
  const r = runner as { disposed?: boolean };
  return r.disposed === true;
}
