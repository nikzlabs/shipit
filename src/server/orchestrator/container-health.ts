/**
 * Container health monitoring via Docker event stream.
 *
 * Extracted from SessionContainerManager for single-responsibility modules.
 */

import type Docker from "dockerode";
import type { EventEmitter } from "node:events";
import type {
  SessionContainer,
  SessionContainerManagerEvents,
} from "./session-container.js";
import { CONTAINER_SESSION_ID_LABEL } from "./session-container.js";

// ---------------------------------------------------------------------------
// Internal types for dependency injection
// ---------------------------------------------------------------------------

export interface HealthDeps {
  docker: Docker;
  containers: Map<string, SessionContainer>;
  standbySessionIds: Set<string>;
  emitter: EventEmitter<SessionContainerManagerEvents>;
  labelFilters: () => string[];
}

// ---------------------------------------------------------------------------
// Event stream state
// ---------------------------------------------------------------------------

export interface HealthMonitorState {
  eventStream: (NodeJS.ReadableStream & { destroy?: () => void }) | null;
  /**
   * `true` when `stopHealthMonitor()` has been called explicitly (e.g.
   * during shutdown). Used to distinguish a deliberate stop from a
   * transient stream error so the auto-restart path knows when to
   * give up.
   */
  stopped: boolean;
  /**
   * Pending auto-restart timer scheduled after the Docker event stream
   * errors out. Cleared on `stopHealthMonitor()` and replaced on each
   * subsequent failure to debounce restart attempts.
   */
  restartTimer: ReturnType<typeof setTimeout> | null;
}

/** Default state for a fresh monitor. */
export function createHealthMonitorState(): HealthMonitorState {
  return { eventStream: null, stopped: false, restartTimer: null };
}

// ---------------------------------------------------------------------------
// Start / stop health monitor
// ---------------------------------------------------------------------------

/** Debounce delay before reattaching to the Docker event stream after an error. */
const RESTART_DEBOUNCE_MS = 5_000;

/**
 * Start listening for Docker events to detect container crashes (OOM, exit).
 * Emits "container_exited" when a session container dies unexpectedly.
 *
 * The stream is fragile: a Docker daemon restart, network blip, or socket
 * EAGAIN can drop it. When that happens, the monitor schedules an
 * auto-reconnect with a 5s debounce so `container_exited` events resume
 * firing as soon as the daemon is reachable. Without this, OOMs and
 * crashes become invisible to the orchestrator after the first failure.
 */
export async function startHealthMonitor(
  deps: HealthDeps,
  state: HealthMonitorState,
): Promise<void> {
  if (state.eventStream || state.stopped) return;

  // Clear any pending restart timer — we're connecting now.
  if (state.restartTimer) {
    clearTimeout(state.restartTimer);
    state.restartTimer = null;
  }

  try {
    state.eventStream = await deps.docker.getEvents({
      filters: {
        type: ["container"],
        event: ["die", "oom"],
        label: deps.labelFilters(),
      },
    });

    state.eventStream.on("data", (chunk: Buffer) => {
      try {
        const event = JSON.parse(chunk.toString()) as {
          Action?: string;
          Actor?: { Attributes?: Record<string, string> };
        };
        const sessionId = event.Actor?.Attributes?.[CONTAINER_SESSION_ID_LABEL];
        if (!sessionId) return;

        const sc = deps.containers.get(sessionId);
        if (!sc) return;

        if (event.Action === "die" || event.Action === "oom") {
          // Skip if destroy() is already in-flight — it will handle cleanup
          if (sc.status === "stopping") return;
          const exitCode = Number(event.Actor?.Attributes?.exitCode ?? 1);
          const error = event.Action === "oom" ? "Out of memory" : undefined;
          sc.status = "stopped";
          deps.containers.delete(sessionId);
          deps.standbySessionIds.delete(sessionId);
          deps.emitter.emit("container_exited", sessionId, exitCode, error);
        }
      } catch {
        // Malformed event — ignore
      }
    });

    state.eventStream.on("error", () => {
      // Event stream disconnected unexpectedly — clear the handle and
      // schedule a reconnect. Without this, container OOMs and crashes
      // become invisible after the first daemon hiccup.
      state.eventStream = null;
      scheduleRestart(deps, state);
    });

    state.eventStream.on("end", () => {
      state.eventStream = null;
      scheduleRestart(deps, state);
    });
  } catch {
    // Docker events not available — try again later in case the daemon
    // is restarting.
    state.eventStream = null;
    scheduleRestart(deps, state);
  }
}

/** Stop the Docker event stream and cancel any pending auto-restart. */
export function stopHealthMonitor(state: HealthMonitorState): void {
  state.stopped = true;
  if (state.restartTimer) {
    clearTimeout(state.restartTimer);
    state.restartTimer = null;
  }
  if (state.eventStream) {
    state.eventStream.destroy?.();
    state.eventStream = null;
  }
}

/**
 * Reset a stopped monitor so `startHealthMonitor` can be called again.
 * Used by tests; production code creates a fresh state via
 * `createHealthMonitorState()`.
 */
export function resetHealthMonitor(state: HealthMonitorState): void {
  state.stopped = false;
}

function scheduleRestart(deps: HealthDeps, state: HealthMonitorState): void {
  if (state.stopped || state.restartTimer) return;
  state.restartTimer = setTimeout(() => {
    state.restartTimer = null;
    if (state.stopped) return;
    void startHealthMonitor(deps, state);
  }, RESTART_DEBOUNCE_MS);
  // Don't keep the event loop alive solely for this timer (e.g. during
  // graceful shutdown without an explicit stop call).
  state.restartTimer.unref?.();
}
