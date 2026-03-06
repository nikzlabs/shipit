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
}

// ---------------------------------------------------------------------------
// Start / stop health monitor
// ---------------------------------------------------------------------------

/**
 * Start listening for Docker events to detect container crashes (OOM, exit).
 * Emits "container_exited" when a session container dies unexpectedly.
 */
export async function startHealthMonitor(
  deps: HealthDeps,
  state: HealthMonitorState,
): Promise<void> {
  if (state.eventStream) return;

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
      // Event stream disconnected — will be restarted on next call
      state.eventStream = null;
    });
  } catch {
    // Docker events not available
  }
}

/** Stop the Docker event stream. */
export function stopHealthMonitor(state: HealthMonitorState): void {
  if (state.eventStream) {
    state.eventStream.destroy?.();
    state.eventStream = null;
  }
}
