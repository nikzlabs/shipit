import type Docker from "dockerode";
import type { EventEmitter } from "node:events";
import type {
  SessionContainer,
  SessionContainerManagerEvents,
} from "./session-container.js";
import { CONTAINER_SESSION_ID_LABEL } from "./session-container.js";
import { reapSessionEgressSidecars } from "./egress-orphan-reaper.js";
import { COMPOSE_EGRESS_SIDECAR_LABEL } from "./compose-service-egress.js";
import { EGRESS_RESOLVER_LABEL } from "./egress-dns-install.js";
import { EGRESS_PROXY_LABEL } from "./egress-proxy-install.js";

// Local literals avoid a dependency cycle with compose-generator.
const COMPOSE_PARENT_SESSION_LABEL = "shipit-parent-session";
const COMPOSE_SERVICE_NAME_LABEL = "shipit-service-name";
const DOCKER_COMPOSE_SERVICE_LABEL = "com.docker.compose.service";

export interface HealthDeps {
  docker: Docker;
  containers: Map<string, SessionContainer>;
  standbySessionIds: Set<string>;
  emitter: EventEmitter<SessionContainerManagerEvents>;
  labelFilters: () => string[];
  /** Invalidates the source-IP trust index for starts outside ShipIt's creation paths. */
  onLabelledContainerStarted?: () => void;
}

export interface HealthMonitorState {
  eventStream: (NodeJS.ReadableStream & { destroy?: () => void }) | null;
  stopped: boolean;
  restartTimer: ReturnType<typeof setTimeout> | null;
  lastLossAt: number | null;
  // Key by container ID: a session ID can refer to a replacement container.
  recentOoms: Map<string, number>;
}

const OOM_ATTRIBUTION_WINDOW_MS = 60_000;

function pruneRecentOoms(state: HealthMonitorState): void {
  const cutoff = Date.now() - OOM_ATTRIBUTION_WINDOW_MS;
  for (const [key, at] of state.recentOoms) {
    if (at < cutoff) state.recentOoms.delete(key);
  }
}

function takeRecentOom(state: HealthMonitorState, incarnationId: string): boolean {
  pruneRecentOoms(state);
  if (incarnationId && state.recentOoms.has(incarnationId)) {
    state.recentOoms.delete(incarnationId);
    return true;
  }
  return false;
}

export function createHealthMonitorState(): HealthMonitorState {
  return {
    eventStream: null,
    stopped: false,
    restartTimer: null,
    lastLossAt: null,
    recentOoms: new Map(),
  };
}

const RESTART_DEBOUNCE_MS = 5_000;

export async function startHealthMonitor(
  deps: HealthDeps,
  state: HealthMonitorState,
): Promise<void> {
  if (state.eventStream || state.stopped) return;

  if (state.restartTimer) {
    clearTimeout(state.restartTimer);
    state.restartTimer = null;
  }

  try {
    // An agent-only label filter would hide Compose service events.
    state.eventStream = await deps.docker.getEvents({
      filters: {
        type: ["container"],
        event: ["die", "oom", "start"],
      },
    });

    if (state.lastLossAt !== null) {
      const gapMs = Date.now() - state.lastLossAt;
      state.lastLossAt = null;
      deps.emitter.emit("health_monitor_resumed", { gapMs });
    }

    state.eventStream.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) handleEvent(line);
      }
    });

    function handleEvent(line: string): void {
      try {
        const event = JSON.parse(line) as {
          Action?: string;
          Actor?: { ID?: string; Attributes?: Record<string, string> };
        };
        const attrs = event.Actor?.Attributes ?? {};
        const action = event.Action;
        // Unlabelled churn cannot change the index; stale entries after exits fail toward denial.
        if (action === "start" && attrs[COMPOSE_PARENT_SESSION_LABEL]) {
          deps.onLabelledContainerStarted?.();
        }
        if (action !== "die" && action !== "oom") return;
        const containerId = event.Actor?.ID ?? "";

        const sessionId = attrs[CONTAINER_SESSION_ID_LABEL];
        if (sessionId) {
          const sc = deps.containers.get(sessionId);

          // Reap before map-entry guards, including for old containers. The reaper checks liveness
          // and targets only egress sidecars, preserving user services and volumes.
          void reapSessionEgressSidecars(deps.docker, sessionId, containerId || sc?.id || "");

          // OOM can kill a child while the container survives. Only die changes session state.
          if (action === "oom") {
            const oomContainerId = containerId || sc?.id || "";
            if (oomContainerId) {
              pruneRecentOoms(state);
              state.recentOoms.set(oomContainerId, Date.now());
            }
            return;
          }

          if (!sc) return;
          // Session labels survive recreation; an old container's exit must not delete its replacement.
          if (containerId && containerId !== sc.id) return;
          if (sc.status === "stopping") return;
          const exitCode = Number(attrs.exitCode ?? 1);
          const error = takeRecentOom(state, containerId || sc.id) ? "Out of memory" : undefined;
          sc.status = "stopped";
          deps.containers.delete(sessionId);
          deps.standbySessionIds.delete(sessionId);
          deps.emitter.emit("container_exited", sessionId, exitCode, error);
          return;
        }

        const parentSessionId = attrs[COMPOSE_PARENT_SESSION_LABEL];
        if (parentSessionId) {
          const exitCode = Number(attrs.exitCode ?? 1);
          const oom = action === "oom";
          // Parent labels include infrastructure: sidecar replacement is not a user-service crash.
          const egressSidecar = Boolean(
            attrs[COMPOSE_EGRESS_SIDECAR_LABEL]
              || attrs[EGRESS_RESOLVER_LABEL]
              || attrs[EGRESS_PROXY_LABEL],
          );
          const serviceName = egressSidecar
            ? undefined
            : attrs[COMPOSE_SERVICE_NAME_LABEL] || attrs[DOCKER_COMPOSE_SERVICE_LABEL];
          if (serviceName) {
            deps.emitter.emit("service_exited", parentSessionId, {
              serviceName,
              containerId,
              exitCode,
              oom,
            });
            return;
          }
          deps.emitter.emit("session_child_exited", parentSessionId, {
            containerId,
            exitCode,
            oom,
            egressSidecar,
          });
        }
      } catch {
        // Ignore malformed events.
      }
    }

    state.eventStream.on("error", () => {
      state.eventStream = null;
      state.lastLossAt ??= Date.now();
      scheduleRestart(deps, state);
    });

    state.eventStream.on("end", () => {
      state.eventStream = null;
      state.lastLossAt ??= Date.now();
      scheduleRestart(deps, state);
    });
  } catch {
    state.eventStream = null;
    state.lastLossAt ??= Date.now();
    scheduleRestart(deps, state);
  }
}

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
  state.restartTimer.unref?.();
}
