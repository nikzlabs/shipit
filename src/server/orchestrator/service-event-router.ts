import type Docker from "dockerode";
import type { EventEmitter } from "node:events";

import type { SessionContainerManagerEvents } from "./session-container.js";
import { composeProjectName } from "./compose-stack-reaper.js";
import { listAllComposeProjects } from "./compose-container-listing.js";
import { monotonicNow, type PollerContainer } from "./service-poller.js";
import { stackLabelFilters } from "./stack-label.js";

/** What the router needs of a `ServiceManager`; the rest of it is not its business. */
export interface ServiceEventTarget {
  refreshServices(listed?: PollerContainer[], takenAt?: number): Promise<void>;
  applyServiceExit(serviceName: string, info: { exitCode: number; oomKilled?: boolean }): void;
  healNetwork(): Promise<void>;
  /** Docker could not be listed at all, which no slice can express. */
  noteListingFailed(): void;
}

/**
 * Events can be lost across a stream disconnect, and a container that is merely absent announces
 * nothing at all, so a periodic reconcile is still needed. It is ONE listing for every session
 * together (`listAllComposeProjects`), so its cost does not grow with the session count — which is
 * the whole point of docs/332 req 5.
 */
export const BACKSTOP_INTERVAL_MS = 5 * 60_000;

/** A listing that never settles would latch `backstopInFlight` and stop every later reconcile. */
export const BACKSTOP_LISTING_TIMEOUT_MS = 30_000;

/** A heal is one network inspect and at most one connect; it must not outlive a sweep. */
export const HEAL_TIMEOUT_MS = 15_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`the listing did not answer within ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([work, limit]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export interface ServiceEventRouterDeps {
  docker: Docker;
  serviceManagers: Map<string, ServiceEventTarget>;
  containerManager: Pick<
    EventEmitter<SessionContainerManagerEvents>,
    "on" | "off"
  >;
  stackName?: string;
  backstopIntervalMs?: number;
}

/**
 * Routes the host-wide Docker event stream to the session whose Compose project the event belongs
 * to, in place of a 5-second `docker compose ps` per session (docs/332).
 *
 * Process-lived, never per-runner: a disposed `ServiceManager` leaves the `serviceManagers` map and
 * is thereby unsubscribed, so the router holds no reference of its own to collect.
 */
export class ServiceEventRouter {
  private readonly deps: ServiceEventRouterDeps;
  private readonly stackFilters: string[];
  private readonly backstopIntervalMs: number;
  private backstopTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private backstopInFlight = false;
  private backstopRequested = false;
  private readonly refreshInFlight = new Set<string>();
  private readonly refreshQueued = new Set<string>();
  private readonly healInFlight = new Set<string>();

  private readonly onServiceExited = (
    sessionId: string,
    info: { serviceName: string; containerId: string; exitCode: number; oom: boolean },
  ): void => {
    const mgr = this.deps.serviceManagers.get(sessionId);
    if (!mgr) return;
    mgr.applyServiceExit(info.serviceName, {
      exitCode: info.exitCode,
      oomKilled: info.oom,
    });
    // The exit is authoritative for that container; this settles what the SERVICE is now — the
    // restart policy may already have replaced it (`restarting`, then running at a new address).
    void this.refresh(sessionId, `${info.serviceName} exited`);
  };

  private readonly onProjectChanged = (project: string): void => {
    const sessionId = this.sessionForProject(project);
    if (!sessionId) return;
    void this.refresh(sessionId, `project ${project} changed`);
  };

  private readonly onNetworkChanged = (networkName: string): void => {
    const sessionId = networkName.replace(/^shipit-session-/, "");
    if (!this.deps.serviceManagers.has(sessionId)) return;
    void this.heal(sessionId);
    // The heal covers the AGENT's attachment. A service container that lost the network needs its
    // address re-resolved and reattached, which is the refresh's `reattach` path.
    void this.refresh(sessionId, `network ${networkName} changed`);
  };

  /** Bounded, and one at a time per session: a stream resume asks for every session at once. */
  private async heal(sessionId: string): Promise<void> {
    if (this.healInFlight.has(sessionId)) return;
    const mgr = this.deps.serviceManagers.get(sessionId);
    if (!mgr) return;
    this.healInFlight.add(sessionId);
    try {
      await withTimeout(mgr.healNetwork(), HEAL_TIMEOUT_MS);
    } catch (err) {
      console.warn(`[service-events] network heal for ${sessionId} failed:`, message(err));
    } finally {
      this.healInFlight.delete(sessionId);
    }
  }

  /**
   * Events during the gap are gone, so the whole stack is reconciled rather than trusted — and the
   * agent's network attachment with it. A listing cannot show that: the agent container is not in
   * the Compose project, so a detach whose event was lost would otherwise never be repaired now
   * that the heal no longer rides every refresh.
   */
  private readonly onStreamResumed = (): void => {
    for (const sessionId of this.deps.serviceManagers.keys()) void this.heal(sessionId);
    void this.runBackstop("the Docker event stream resumed");
  };

  constructor(deps: ServiceEventRouterDeps) {
    this.deps = deps;
    this.stackFilters = stackLabelFilters(deps.stackName);
    this.backstopIntervalMs = deps.backstopIntervalMs ?? BACKSTOP_INTERVAL_MS;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const { containerManager } = this.deps;
    containerManager.on("service_exited", this.onServiceExited);
    containerManager.on("compose_project_changed", this.onProjectChanged);
    containerManager.on("session_network_changed", this.onNetworkChanged);
    containerManager.on("health_monitor_resumed", this.onStreamResumed);

    if (this.backstopIntervalMs > 0) {
      this.backstopTimer = setInterval(() => {
        void this.runBackstop("the periodic backstop");
      }, this.backstopIntervalMs);
      this.backstopTimer.unref?.();
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    const { containerManager } = this.deps;
    containerManager.off("service_exited", this.onServiceExited);
    containerManager.off("compose_project_changed", this.onProjectChanged);
    containerManager.off("session_network_changed", this.onNetworkChanged);
    containerManager.off("health_monitor_resumed", this.onStreamResumed);
    if (this.backstopTimer) clearInterval(this.backstopTimer);
    this.backstopTimer = null;
  }

  private sessionForProject(project: string): string | undefined {
    // The project name is a truncation of the session ID, so it is matched, never reversed.
    for (const sessionId of this.deps.serviceManagers.keys()) {
      if (composeProjectName(sessionId) === project) return sessionId;
    }
    return undefined;
  }

  /**
   * Events arrive in bursts — a `compose up` of a ten-service stack emits ten `start` events — and
   * each refresh is a full listing of the project. So one runs at a time per session, with at most
   * one more queued behind it: the queued one reflects every event that arrived while it waited,
   * which is all a reconcile needs.
   */
  private async refresh(
    sessionId: string,
    why: string,
    listed?: PollerContainer[],
    takenAt?: number,
  ): Promise<void> {
    if (this.refreshQueued.has(sessionId)) return;
    if (this.refreshInFlight.has(sessionId)) {
      // Including a backstop slice: a refresh already running is newer than that listing, so
      // dropping it loses nothing. Marking it queued without owning the in-flight entry is what
      // let one path clear another's marker and run two refreshes of a session at once.
      this.refreshQueued.add(sessionId);
      return;
    }
    const mgr = this.deps.serviceManagers.get(sessionId);
    if (!mgr) return;
    this.refreshInFlight.add(sessionId);
    try {
      await mgr.refreshServices(listed, takenAt);
    } catch (err) {
      console.warn(`[service-events] refresh of ${sessionId} after ${why} failed:`, message(err));
    } finally {
      this.refreshInFlight.delete(sessionId);
    }
    while (this.refreshQueued.delete(sessionId)) {
      this.refreshInFlight.add(sessionId);
      try {
        await mgr.refreshServices();
      } catch (err) {
        console.warn(`[service-events] coalesced refresh of ${sessionId} failed:`, message(err));
      } finally {
        this.refreshInFlight.delete(sessionId);
      }
    }
  }

  /**
   * One listing for the whole host, so that a hundred idle sessions cost one Engine API call rather
   * than a hundred. A session whose project has no containers at all is refreshed too: that is the
   * state the missing-container rule exists to resolve.
   */
  async runBackstop(why: string): Promise<void> {
    if (this.backstopInFlight) {
      // Its listing was taken before this request, so it cannot answer it. Queue one re-run.
      this.backstopRequested = true;
      return;
    }
    this.backstopInFlight = true;
    try {
      const sessionIds = [...this.deps.serviceManagers.keys()];
      if (sessionIds.length === 0) return;
      let byProject: Map<string, PollerContainer[]>;
      const takenAt = monotonicNow();
      try {
        byProject = await withTimeout(
          listAllComposeProjects(this.deps.docker, this.stackFilters),
          BACKSTOP_LISTING_TIMEOUT_MS,
        );
      } catch (err) {
        // Report the failure rather than making each session repeat it. Every session must still
        // reach its OWN docker-unreachable grace, or a stack that died while nobody watched keeps
        // publishing `running` for ever — but a listing per session, each awaited in turn and each
        // able to hang to its own timeout, would take a hundred sessions the better part of an hour.
        console.warn(`[service-events] ${why}: listing Compose projects failed:`, message(err));
        for (const sessionId of sessionIds) {
          this.deps.serviceManagers.get(sessionId)?.noteListingFailed();
        }
        return;
      }
      // Concurrent, each bounded: sessions are independent, and awaiting them in turn let one
      // slow refresh hold the whole sweep — and with it every later backstop and resync.
      await Promise.allSettled(sessionIds.map((sessionId) => withTimeout(
        this.refresh(sessionId, why, byProject.get(composeProjectName(sessionId)) ?? [], takenAt),
        BACKSTOP_LISTING_TIMEOUT_MS,
      ).catch((err: unknown) => {
        console.warn(`[service-events] ${why}: reconciling ${sessionId} did not finish:`, message(err));
      })));
    } finally {
      this.backstopInFlight = false;
    }
    if (this.backstopRequested) {
      this.backstopRequested = false;
      await this.runBackstop(`${why} (re-requested)`);
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
