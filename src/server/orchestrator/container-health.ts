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
import { reapSessionEgressSidecars } from "./egress-orphan-reaper.js";

/**
 * Label stamped on Compose-managed (user-service) containers by
 * `compose-generator.ts`. Lets the health monitor identify containers
 * belonging to a specific session even when they don't carry the agent
 * container's `shipit-session=true` label.
 *
 * Kept as a string literal here (instead of importing from
 * `compose-generator.ts`) to avoid a circular dependency between
 * orchestrator subsystems. The value is the same — see
 * docs/124-session-rescue-and-diagnostics §1.2.
 */
const COMPOSE_PARENT_SESSION_LABEL = "shipit-parent-session";
const COMPOSE_SERVICE_NAME_LABEL = "shipit-service-name";

// ---------------------------------------------------------------------------
// Internal types for dependency injection
// ---------------------------------------------------------------------------

export interface HealthDeps {
  docker: Docker;
  containers: Map<string, SessionContainer>;
  standbySessionIds: Set<string>;
  emitter: EventEmitter<SessionContainerManagerEvents>;
  /**
   * Retained for API compatibility with `DiscoveryDeps`. The Docker event
   * stream itself no longer applies a label filter — it dispatches by
   * label inside the handler (see implementation note in
   * `startHealthMonitor`).
   */
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
  /**
   * Wall-clock timestamp (Date.now()) when the stream most recently
   * went down — set on `error`/`end` and on the catch path of
   * `startHealthMonitor()`, cleared on successful (re-)connect. When
   * non-null, the next successful connect emits a
   * `health_monitor_resumed` event with the gap duration so the
   * orchestrator can warn that die/oom events during this window may
   * have been missed.
   */
  lastLossAt: number | null;
  /**
   * Containers whose cgroup OOM-killer fired recently: id (or session id, when
   * the daemon omitted `Actor.ID`) → `Date.now()` of the `oom` event.
   *
   * A Docker `oom` event is **not** a container death — it fires when the cgroup's
   * killer kills *a process*. If that process wasn't PID 1 the container survives,
   * and no `die` follows. So `oom` no longer mutates session state; it only
   * records that an OOM happened, and the `die` that follows (if any) reads this
   * to report "Out of memory" instead of a bare exit code.
   *
   * Entries are consumed by the matching `die` and pruned after
   * {@link OOM_ATTRIBUTION_WINDOW_MS}, so a container that *survived* its OOM
   * doesn't get a stale OOM label pinned on an unrelated death hours later.
   */
  recentOoms: Map<string, number>;
}

/**
 * How long after an `oom` event a `die` is still attributed to it.
 *
 * Docker emits the pair back-to-back (milliseconds apart) when the OOM killer
 * takes PID 1, so this is generous. It exists to bound the map and to stop a
 * survived-OOM container from being labelled "Out of memory" when it eventually
 * dies of something else entirely.
 */
const OOM_ATTRIBUTION_WINDOW_MS = 60_000;

/** Drop OOM records too old to explain a `die` we're about to see. */
function pruneRecentOoms(state: HealthMonitorState): void {
  const cutoff = Date.now() - OOM_ATTRIBUTION_WINDOW_MS;
  for (const [key, at] of state.recentOoms) {
    if (at < cutoff) state.recentOoms.delete(key);
  }
}

/**
 * Did this container's cgroup OOM-killer fire recently? Consumes the record.
 *
 * Checks the container id first and falls back to the session id, mirroring how
 * the `oom` event was keyed (daemons that omit `Actor.ID` leave us only the
 * session).
 */
function takeRecentOom(state: HealthMonitorState, containerId: string, sessionId: string): boolean {
  pruneRecentOoms(state);
  for (const key of [containerId, sessionId]) {
    if (key && state.recentOoms.has(key)) {
      state.recentOoms.delete(key);
      return true;
    }
  }
  return false;
}

/** Default state for a fresh monitor. */
export function createHealthMonitorState(): HealthMonitorState {
  return {
    eventStream: null,
    stopped: false,
    restartTimer: null,
    lastLossAt: null,
    recentOoms: new Map(),
  };
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
    // Note: we deliberately do NOT pass the `label` filter to Docker here.
    // The agent-container filter (`shipit-session=true`) excludes
    // Compose-managed children (which carry `shipit-parent-session=<sid>`
    // instead), so service OOM kills used to be invisible to the event
    // loop and only surfaced ~5s later via `pollStatus` as a generic
    // "Exited with code 137". We now dispatch by label inside the handler.
    // See docs/124-session-rescue-and-diagnostics §1.2.
    state.eventStream = await deps.docker.getEvents({
      filters: {
        type: ["container"],
        event: ["die", "oom"],
      },
    });

    // Successful (re-)connect. If the stream had been down, emit a
    // resumed event so the orchestrator can leave a breadcrumb saying
    // die/oom events during the gap may have been missed. Without this,
    // the missing-container reconciler is the only signal that a
    // container vanished — and it can't say *why* it wasn't noticed.
    if (state.lastLossAt !== null) {
      const gapMs = Date.now() - state.lastLossAt;
      state.lastLossAt = null;
      deps.emitter.emit("health_monitor_resumed", { gapMs });
    }

    state.eventStream.on("data", (chunk: Buffer) => {
      try {
        const event = JSON.parse(chunk.toString()) as {
          Action?: string;
          Actor?: { ID?: string; Attributes?: Record<string, string> };
        };
        const attrs = event.Actor?.Attributes ?? {};
        const action = event.Action;
        if (action !== "die" && action !== "oom") return;
        // Read the real container ID from `Actor.ID` — `attrs.id` is never
        // populated by Docker, so the old `attrs.id ?? ""` was always "".
        // This ID is what disambiguates container incarnations below.
        const containerId = event.Actor?.ID ?? "";

        // ---- Path 1: agent container -----------------------------------
        const sessionId = attrs[CONTAINER_SESSION_ID_LABEL];
        if (sessionId) {
          const sc = deps.containers.get(sessionId);

          // SHI-222 — the agent container is the netns PARENT of the Tier B/C
          // egress sidecars (docs/172). When it dies, their shared namespace dies
          // with it and they are dead weight. Reap them HERE, at the crash site:
          // the map-entry delete below LATCHES the leak, because every later
          // `destroyContainer(sessionId)` early-returns on `if (!sc) return` — so
          // archiving the session afterwards would never run the label sweep and
          // the sidecars would outlive the session entirely.
          //
          // This sits ABOVE every early-return below, and that ordering is
          // load-bearing. A PID-1 OOM emits TWO events: `oom`, then `die` a few ms
          // later. The `oom` arrives while the daemon still reports the container
          // `Running`, so the reap's liveness gate correctly DECLINES — an `oom`
          // is not proof of death (the cgroup killer may have taken a non-PID-1
          // process, leaving the container very much alive). By the time `die`
          // lands — the event that IS proof — this handler has already dropped the
          // map entry, so a reap placed below `if (!sc) return` would never run at
          // all. That left the leak wide open in exactly the crash mode SHI-222 is
          // named for.
          //
          // Calling it unconditionally is safe because the reap is (a) scoped to
          // the id of the container that died, so it can never touch a REPLACEMENT
          // incarnation's sidecars, (b) liveness-gated, so it declines while that
          // container is still running, and (c) idempotent — a second call after
          // the first already removed them finds nothing and does nothing.
          //
          // Prefer the event's `Actor.ID` over the tracked `sc.id`: it names the
          // container that ACTUALLY died, which for a stale event is a previous
          // incarnation whose sidecars are genuine orphans worth collecting. Fall
          // back to `sc.id` only when the daemon omitted the ID (older event
          // shapes) — the liveness gate is what keeps that fallback from reaping a
          // healthy container's sidecars.
          //
          // Deliberately targeted at the egress labels, NOT
          // `cleanupSessionDockerResources`: that sweeps every
          // `shipit-parent-session` child, which on an agent OOM would also drop
          // the user's compose services, networks, and volumes (their database
          // included). An agent crash must not cost them that.
          //
          // Fire-and-forget: we're inside the Docker event stream's handler, and
          // `reapSessionEgressSidecars` never rejects.
          void reapSessionEgressSidecars(deps.docker, sessionId, containerId || sc?.id || "");

          // An `oom` is NOT a container death, and must not be treated as one.
          //
          // Docker fires it when the cgroup's OOM-killer kills *a process* in the
          // container. In a session container PID 1 is the worker and the agent CLI
          // is a child, so the common case is precisely the one where the container
          // SURVIVES: the CLI gets killed, the worker keeps running. Acting on the
          // event would then delete a healthy container's map entry, emit
          // `container_exited`, finalize the live turn as crashed, dispose the
          // runner, and trip the OOM circuit breaker — all against a container that
          // is still up and serving.
          //
          // If PID 1 *was* the victim, Docker emits `die` a few milliseconds later,
          // and that event IS proof. So we record the OOM and let `die` do the work
          // — which also means the map entry survives until then, keeping `sc.id`
          // available to scope the reap on daemons that omit `Actor.ID`. (Deleting
          // it here used to strand the sidecars in exactly that case: the follow-up
          // `die` had neither an `Actor.ID` nor an `sc` to fall back to.)
          if (action === "oom") {
            pruneRecentOoms(state);
            state.recentOoms.set(containerId || sessionId, Date.now());
            return;
          }

          if (!sc) return;
          // Stale-incarnation guard: the container name (`agent-<shortId>`)
          // and `shipit-session-id` label are reused across recreations. A
          // `die` event for a PREVIOUS container (e.g. the one Rescue just
          // stopped) must not be attributed to the current container —
          // doing so deletes a healthy container's map entry and emits a
          // phantom `container_exited`, which is the root of the
          // Rescue-doesn't-work create/phantom-exit loop. An empty `sc.id`
          // means the new container is mid-create (id not yet assigned); a
          // non-matching id is unambiguously a stale event.
          //
          // Note this guards the SESSION-STATE mutation below, not the reap above:
          // a stale event carries a real dead container id, and reaping that
          // container's orphaned sidecars is correct precisely when its exit must
          // NOT be attributed to the current one.
          if (containerId && containerId !== sc.id) return;
          // Skip if destroy() is already in-flight — it will handle cleanup
          if (sc.status === "stopping") return;
          const exitCode = Number(attrs.exitCode ?? 1);
          const error = takeRecentOom(state, containerId, sessionId) ? "Out of memory" : undefined;
          sc.status = "stopped";
          deps.containers.delete(sessionId);
          deps.standbySessionIds.delete(sessionId);
          deps.emitter.emit("container_exited", sessionId, exitCode, error);
          return;
        }

        // ---- Path 2: compose child (user service) ----------------------
        // Catches OOM / crash on the dev server, db, etc. Without this,
        // service OOMs (exit code 137) only surface 5s later via
        // `pollStatus` with the unhelpful "Exited with code 137" message,
        // and the OOM signal itself is silently lost.
        const parentSessionId = attrs[COMPOSE_PARENT_SESSION_LABEL];
        if (parentSessionId) {
          const exitCode = Number(attrs.exitCode ?? 1);
          const oom = action === "oom";
          const serviceName = attrs[COMPOSE_SERVICE_NAME_LABEL];
          deps.emitter.emit("service_exited", parentSessionId, {
            ...(serviceName ? { serviceName } : {}),
            containerId,
            exitCode,
            oom,
          });
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
      state.lastLossAt ??= Date.now();
      scheduleRestart(deps, state);
    });

    state.eventStream.on("end", () => {
      state.eventStream = null;
      state.lastLossAt ??= Date.now();
      scheduleRestart(deps, state);
    });
  } catch {
    // Docker events not available — try again later in case the daemon
    // is restarting.
    state.eventStream = null;
    state.lastLossAt ??= Date.now();
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
