import type Docker from "dockerode";
import type { EventEmitter } from "node:events";

import type { SessionContainerManagerEvents } from "./session-container.js";
import { composeProjectName } from "./compose-stack-reaper.js";
import { listAllComposeProjects } from "./compose-container-listing.js";
import type { PollerContainer } from "./service-poller.js";
import { stackLabelFilters } from "./stack-label.js";

/** What the router needs of a `ServiceManager`; the rest of it is not its business. */
export interface ServiceEventTarget {
  refreshServices(listed?: PollerContainer[]): Promise<void>;
  applyServiceExit(
    serviceName: string,
    info: { containerId?: string; exitCode: number; oomKilled?: boolean },
  ): void;
  healNetwork(): Promise<void>;
}

/**
 * Events can be lost across a stream disconnect, and a container that is merely absent announces
 * nothing at all, so a periodic reconcile is still needed. It is ONE listing for every session
 * together (`listAllComposeProjects`), so its cost does not grow with the session count — which is
 * the whole point of docs/332 req 5.
 */
export const BACKSTOP_INTERVAL_MS = 5 * 60_000;

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

  private readonly onServiceExited = (
    sessionId: string,
    info: { serviceName: string; containerId: string; exitCode: number; oom: boolean },
  ): void => {
    const mgr = this.deps.serviceManagers.get(sessionId);
    if (!mgr) return;
    mgr.applyServiceExit(info.serviceName, {
      containerId: info.containerId,
      exitCode: info.exitCode,
      oomKilled: info.oom,
    });
  };

  private readonly onProjectChanged = (project: string): void => {
    const sessionId = this.sessionForProject(project);
    if (!sessionId) return;
    void this.refresh(sessionId, `project ${project} changed`);
  };

  private readonly onNetworkChanged = (networkName: string): void => {
    const sessionId = networkName.replace(/^shipit-session-/, "");
    const mgr = this.deps.serviceManagers.get(sessionId);
    if (!mgr) return;
    void mgr.healNetwork().catch((err: unknown) => {
      console.warn(`[service-events] network heal for ${sessionId} failed:`, message(err));
    });
  };

  // Events during the gap are gone, so the whole stack is reconciled rather than trusted.
  private readonly onStreamResumed = (): void => {
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

  private async refresh(
    sessionId: string,
    why: string,
    listed?: PollerContainer[],
  ): Promise<void> {
    const mgr = this.deps.serviceManagers.get(sessionId);
    if (!mgr) return;
    try {
      await mgr.refreshServices(listed);
    } catch (err) {
      console.warn(`[service-events] refresh of ${sessionId} after ${why} failed:`, message(err));
    }
  }

  /**
   * One listing for the whole host, so that a hundred idle sessions cost one Engine API call rather
   * than a hundred. A session whose project has no containers at all is refreshed too: that is the
   * state the missing-container rule exists to resolve.
   */
  async runBackstop(why: string): Promise<void> {
    if (this.backstopInFlight) return;
    this.backstopInFlight = true;
    try {
      const sessionIds = [...this.deps.serviceManagers.keys()];
      if (sessionIds.length === 0) return;
      let byProject: Map<string, PollerContainer[]>;
      try {
        byProject = await listAllComposeProjects(this.deps.docker, this.stackFilters);
      } catch (err) {
        console.warn(`[service-events] ${why}: listing Compose projects failed:`, message(err));
        return;
      }
      for (const sessionId of sessionIds) {
        await this.refresh(sessionId, why, byProject.get(composeProjectName(sessionId)) ?? []);
      }
    } finally {
      this.backstopInFlight = false;
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
