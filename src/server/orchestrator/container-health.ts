import type Docker from "dockerode";
import type { EventEmitter } from "node:events";
import type {
  SessionContainer,
  SessionContainerManagerEvents,
} from "./session-container.js";
import { CONTAINER_SESSION_ID_LABEL } from "./session-container.js";
import { reapParentlessEgressSidecars, reapSessionEgressSidecars } from "./egress-orphan-reaper.js";
import { COMPOSE_EGRESS_SIDECAR_LABEL } from "./compose-service-egress.js";
import { EGRESS_RESOLVER_LABEL } from "./egress-dns-install.js";
import { EGRESS_PROXY_LABEL } from "./egress-proxy-install.js";

// Local literals avoid a dependency cycle with compose-generator.
const COMPOSE_PARENT_SESSION_LABEL = "shipit-parent-session";
const COMPOSE_SERVICE_NAME_LABEL = "shipit-service-name";
const DOCKER_COMPOSE_SERVICE_LABEL = "com.docker.compose.service";
const DOCKER_COMPOSE_ONEOFF_LABEL = "com.docker.compose.oneoff";
const DOCKER_COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const SESSION_NETWORK_PREFIX = "shipit-session-";

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
    // An agent-only label filter would hide Compose service events. Network events drive the
    // session-network heal, which used to ride the 5-second service poll (docs/332).
    state.eventStream = await deps.docker.getEvents({
      filters: {
        type: ["container", "network"],
        event: ["die", "oom", "start", "destroy", "connect", "disconnect"],
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
          Type?: string;
          Action?: string;
          Actor?: { ID?: string; Attributes?: Record<string, string> };
        };
        const attrs = event.Actor?.Attributes ?? {};
        const action = event.Action;

        if (event.Type === "network") {
          // `connect` too: a recreated network has to be rejoined, and the heal is membership-gated,
          // so our own reattachment settles rather than looping (docs/332).
          if (action !== "connect" && action !== "disconnect" && action !== "destroy") return;
          const networkName = attrs.name ?? "";
          if (!networkName.startsWith(SESSION_NETWORK_PREFIX)) return;
          deps.emitter.emit("session_network_changed", networkName);
          return;
        }

        // Unlabelled churn cannot change the index; stale entries after exits fail toward denial.
        if (action === "start" && attrs[COMPOSE_PARENT_SESSION_LABEL]) {
          deps.onLabelledContainerStarted?.();
        }
        const containerId = event.Actor?.ID ?? "";
        // A restart reuses the container ID, so an unclaimed OOM must not outlive the run it
        // belongs to and be charged to the next exit of the same container.
        if (action === "start" && containerId) state.recentOoms.delete(containerId);
        const project = attrs[DOCKER_COMPOSE_PROJECT_LABEL];
        // A project container appearing or going away changes what the stack's status should read.
        if (project && (action === "start" || action === "destroy")) {
          deps.emitter.emit("compose_project_changed", project);
        }
        // Compose down removes a service without its egress sidecars, which are not in its project.
        if (action === "destroy") {
          if (containerId && (attrs[COMPOSE_PARENT_SESSION_LABEL] || attrs[CONTAINER_SESSION_ID_LABEL])
            && !attrs[EGRESS_RESOLVER_LABEL] && !attrs[EGRESS_PROXY_LABEL]) {
            void reapParentlessEgressSidecars(deps.docker, { parentIds: [containerId] });
          }
          return;
        }
        if (action !== "die" && action !== "oom") return;

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
          // Correlate as the agent path does: an `oom` event carries no exit code, and the `die`
          // that follows carries no OOM flag. Reporting both separately would describe one kill as
          // an exit-1 crash and a non-OOM SIGKILL, and service status now acts on it (docs/332).
          if (action === "oom") {
            if (containerId) {
              pruneRecentOoms(state);
              state.recentOoms.set(containerId, Date.now());
            }
            // Kept as an operator signal: the kernel may have killed a child while PID 1 survived,
            // in which case no `die` follows and the service correctly stays running.
            console.warn(
              `[container] Session ${parentSessionId} child container ${containerId.slice(0, 12)} `
              + "reported an OOM kill",
            );
            return;
          }
          const exitCode = Number(attrs.exitCode ?? 1);
          const oom = takeRecentOom(state, containerId);
          // Parent labels include infrastructure: sidecar replacement is not a user-service crash.
          const egressSidecar = Boolean(
            attrs[COMPOSE_EGRESS_SIDECAR_LABEL]
              || attrs[EGRESS_RESOLVER_LABEL]
              || attrs[EGRESS_PROXY_LABEL],
          );
          // A `docker compose run` container carries its service's labels but is not the service.
          const oneOff = attrs[DOCKER_COMPOSE_ONEOFF_LABEL] === "True";
          const serviceName = egressSidecar || oneOff
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
