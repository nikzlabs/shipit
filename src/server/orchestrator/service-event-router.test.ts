import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type Docker from "dockerode";

import {
  ServiceEventRouter,
  BACKSTOP_LISTING_TIMEOUT_MS,
  type ServiceEventTarget,
} from "./service-event-router.js";
import type { SessionContainerManagerEvents } from "./session-container.js";
import { composeProjectName } from "./compose-stack-reaper.js";
import type { PollerContainer } from "./service-poller.js";

const SESSION = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";

function target() {
  return {
    refreshServices: vi.fn(async (_listed?: PollerContainer[]) => {}),
    applyServiceExit: vi.fn(),
    healNetwork: vi.fn(async () => {}),
  } satisfies ServiceEventTarget & Record<string, unknown>;
}

describe("ServiceEventRouter", () => {
  let emitter: EventEmitter<SessionContainerManagerEvents>;
  let mgr: ReturnType<typeof target>;
  let managers: Map<string, ServiceEventTarget>;
  let listContainers: ReturnType<typeof vi.fn>;
  let router: ServiceEventRouter;

  beforeEach(() => {
    emitter = new EventEmitter<SessionContainerManagerEvents>();
    mgr = target();
    managers = new Map<string, ServiceEventTarget>([[SESSION, mgr]]);
    listContainers = vi.fn(async () => [
      {
        Id: "c1",
        State: "running",
        Labels: {
          "com.docker.compose.project": composeProjectName(SESSION),
          "com.docker.compose.service": "web",
        },
        NetworkSettings: { Networks: { [`shipit-session-${SESSION}`]: { IPAddress: "172.20.0.4" } } },
      },
    ]);
    router = new ServiceEventRouter({
      docker: { listContainers } as unknown as Docker,
      serviceManagers: managers,
      containerManager: emitter,
      backstopIntervalMs: 0,
    });
    router.start();
  });

  it("settles what the service is now after an exit, since a restart policy may have replaced it", async () => {
    emitter.emit("service_exited", SESSION, {
      serviceName: "web", containerId: "c1", exitCode: 1, oom: false,
    });

    await vi.waitFor(() => expect(mgr.refreshServices).toHaveBeenCalled());
  });

  it("re-resolves service addresses on a network event, not only the agent's attachment", async () => {
    emitter.emit("session_network_changed", `shipit-session-${SESSION}`);

    await vi.waitFor(() => expect(mgr.refreshServices).toHaveBeenCalled());
  });

  it("routes a service exit to the owning session, with the event's exit code and OOM flag", () => {
    emitter.emit("service_exited", SESSION, {
      serviceName: "web", containerId: "c1", exitCode: 137, oom: true,
    });

    expect(mgr.applyServiceExit).toHaveBeenCalledWith("web", { exitCode: 137, oomKilled: true });
  });

  it("ignores an exit for a session this process holds no stack for", () => {
    emitter.emit("service_exited", OTHER, {
      serviceName: "web", containerId: "c1", exitCode: 1, oom: false,
    });

    expect(mgr.applyServiceExit).not.toHaveBeenCalled();
  });

  it("refreshes the session whose Compose project the changed container belongs to", async () => {
    emitter.emit("compose_project_changed", composeProjectName(SESSION));
    await vi.waitFor(() => expect(mgr.refreshServices).toHaveBeenCalled());
  });

  it("refreshes nothing for a project no live session owns", async () => {
    emitter.emit("compose_project_changed", composeProjectName(OTHER));
    await Promise.resolve();
    expect(mgr.refreshServices).not.toHaveBeenCalled();
  });

  it("heals the session network named by a network event", async () => {
    emitter.emit("session_network_changed", `shipit-session-${SESSION}`);
    await vi.waitFor(() => expect(mgr.healNetwork).toHaveBeenCalled());
  });

  it("does not heal for a network belonging to no live session", async () => {
    emitter.emit("session_network_changed", `shipit-session-${OTHER}`);
    await Promise.resolve();
    expect(mgr.healNetwork).not.toHaveBeenCalled();
  });

  // A `compose up` of a ten-service stack emits ten `start` events, and each refresh is a full
  // listing of the project.
  it("coalesces a burst of events into one refresh plus one follow-up, not one per event", async () => {
    let release: (() => void) | undefined;
    mgr.refreshServices.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));

    for (let i = 0; i < 10; i++) {
      emitter.emit("compose_project_changed", composeProjectName(SESSION));
    }
    await vi.waitFor(() => expect(mgr.refreshServices).toHaveBeenCalledTimes(1));

    mgr.refreshServices.mockResolvedValue(undefined);
    release?.();

    await vi.waitFor(() => expect(mgr.refreshServices).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(mgr.refreshServices).toHaveBeenCalledTimes(2);
  });

  it("never coalesces away a slice already listed for it, which would discard that work", async () => {
    const second = target();
    managers.set(OTHER, second);

    await Promise.all([router.runBackstop("one"), router.runBackstop("two")]);
    await router.runBackstop("three");

    expect(mgr.refreshServices.mock.calls.every(([listed]) => Array.isArray(listed))).toBe(true);
  });

  // req 5: the cost of the backstop must not grow with the number of sessions.
  it("reconciles every session from ONE host-wide listing", async () => {
    const second = target();
    managers.set(OTHER, second);

    await router.runBackstop("test");

    expect(listContainers).toHaveBeenCalledTimes(1);
    expect(mgr.refreshServices).toHaveBeenCalledTimes(1);
    expect(second.refreshServices).toHaveBeenCalledTimes(1);
  });

  it("hands each session only its own project's containers", async () => {
    await router.runBackstop("test");

    const listed = mgr.refreshServices.mock.calls[0]?.[0];
    expect(listed).toEqual([
      expect.objectContaining({ ref: "c1", service: "web", state: "running", oneOff: false }),
    ]);
  });

  it("hands an empty slice to a session whose project has no containers at all", async () => {
    const second = target();
    managers.set(OTHER, second);

    await router.runBackstop("test");

    expect(second.refreshServices).toHaveBeenCalledWith([]);
  });

  // Never an empty slice, which would read as "no containers" and walk a healthy stack to stopped.
  it("lets each session list for itself when the shared listing fails, so outage clocks start", async () => {
    listContainers.mockRejectedValueOnce(new Error("docker unreachable"));

    await router.runBackstop("test");

    expect(mgr.refreshServices).toHaveBeenCalledTimes(1);
    expect(mgr.refreshServices).toHaveBeenCalledWith(undefined);
  });

  it("does not latch on a listing that never answers, so later reconciles still run", async () => {
    vi.useFakeTimers();
    listContainers.mockImplementationOnce(() => new Promise(() => { /* never settles */ }));

    const first = router.runBackstop("hung");
    await vi.advanceTimersByTimeAsync(BACKSTOP_LISTING_TIMEOUT_MS + 1_000);
    await first;

    mgr.refreshServices.mockClear();
    vi.useRealTimers();
    await router.runBackstop("after the hang");

    expect(mgr.refreshServices).toHaveBeenCalled();
  });

  it("resyncs the whole stack when the event stream reconnects, since events were lost", async () => {
    emitter.emit("health_monitor_resumed", { gapMs: 20_000 });
    await vi.waitFor(() => expect(mgr.refreshServices).toHaveBeenCalled());
  });

  it("stops routing once stopped, so a closing orchestrator does no further work", () => {
    router.stop();
    emitter.emit("service_exited", SESSION, {
      serviceName: "web", containerId: "c1", exitCode: 1, oom: false,
    });

    expect(mgr.applyServiceExit).not.toHaveBeenCalled();
  });

  it("survives a refresh that throws, leaving the other sessions reconciled", async () => {
    const second = target();
    managers.set(OTHER, second);
    mgr.refreshServices.mockRejectedValueOnce(new Error("compose exploded"));

    await expect(router.runBackstop("test")).resolves.toBeUndefined();
    expect(second.refreshServices).toHaveBeenCalledTimes(1);
  });
});
