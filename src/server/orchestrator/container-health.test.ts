/**
 * Unit tests for the Docker-event health monitor — specifically the
 * stale-incarnation guard.
 *
 * Regression coverage for the Rescue create/phantom-exit loop: the
 * container name (`agent-<shortId>`) and `shipit-session-id` label are
 * reused across recreations, so a `die`/`oom` event for a PREVIOUS
 * container (e.g. the one Rescue just stopped) used to be attributed to
 * the current, healthy container — deleting its map entry and emitting a
 * phantom `container_exited`. The guard compares `Actor.ID` against the
 * tracked `sc.id` and drops the event when they differ.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  startHealthMonitor,
  createHealthMonitorState,
  type HealthDeps,
  type HealthMonitorState,
} from "./container-health.js";
import {
  CONTAINER_SESSION_ID_LABEL,
  type SessionContainer,
  type SessionContainerManagerEvents,
} from "./session-container.js";

function makeContainer(id: string, sessionId: string): SessionContainer {
  return {
    id,
    sessionId,
    containerIp: "172.18.0.4",
    workerUrl: "http://172.18.0.4:9100",
    status: "running",
    hostWorkspaceDir: `/workspace/sessions/${sessionId}`,
    dockerAccess: false,
  };
}

describe("container-health: stale-incarnation guard", () => {
  let containers: Map<string, SessionContainer>;
  let emitter: EventEmitter<SessionContainerManagerEvents>;
  let eventStream: EventEmitter;
  let deps: HealthDeps;
  let state: HealthMonitorState;

  beforeEach(async () => {
    containers = new Map();
    emitter = new EventEmitter<SessionContainerManagerEvents>();
    eventStream = new EventEmitter();
    deps = {
      docker: { getEvents: vi.fn(async () => eventStream) } as unknown as HealthDeps["docker"],
      containers,
      standbySessionIds: new Set<string>(),
      emitter,
      labelFilters: () => [],
    };
    state = createHealthMonitorState();
    await startHealthMonitor(deps, state);
  });

  function emitDie(sessionId: string, actorId: string) {
    eventStream.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          Action: "die",
          Actor: {
            ID: actorId,
            Attributes: { [CONTAINER_SESSION_ID_LABEL]: sessionId, exitCode: "1" },
          },
        }),
      ),
    );
  }

  it("drops a die event whose Actor.ID does not match the tracked container", () => {
    // Replacement container B is registered under the same session ID; a
    // stale `die` event for the previous container A must NOT touch B.
    containers.set("sess-1", makeContainer("b1", "sess-1"));
    const exited = vi.fn();
    emitter.on("container_exited", exited);

    emitDie("sess-1", "a1");

    expect(exited).not.toHaveBeenCalled();
    expect(containers.get("sess-1")).toBeDefined();
    expect(containers.get("sess-1")?.id).toBe("b1");
  });

  it("processes a die event whose Actor.ID matches the tracked container", () => {
    containers.set("sess-1", makeContainer("b1", "sess-1"));
    const exited = vi.fn();
    emitter.on("container_exited", exited);

    emitDie("sess-1", "b1");

    expect(exited).toHaveBeenCalledWith("sess-1", 1, undefined);
    expect(containers.get("sess-1")).toBeUndefined();
  });

  it("processes a die event with no Actor.ID (guard is best-effort, not a hard gate)", () => {
    // Older Docker daemons / some event shapes omit Actor.ID. With no ID
    // to compare we fall through to the existing behavior so we never
    // silently swallow a real exit.
    containers.set("sess-1", makeContainer("b1", "sess-1"));
    const exited = vi.fn();
    emitter.on("container_exited", exited);

    eventStream.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          Action: "die",
          Actor: { Attributes: { [CONTAINER_SESSION_ID_LABEL]: "sess-1", exitCode: "1" } },
        }),
      ),
    );

    expect(exited).toHaveBeenCalledWith("sess-1", 1, undefined);
  });

  it("drops a die event while the new container is mid-create (sc.id still empty)", () => {
    // The new container is registered (line ~290 of container-lifecycle)
    // but `sc.id` is not yet assigned. A stale `die` for the old container
    // carries a non-empty Actor.ID, so `containerId !== sc.id` ("" ) holds
    // and the event is correctly skipped.
    containers.set("sess-1", { ...makeContainer("", "sess-1"), status: "starting" });
    const exited = vi.fn();
    emitter.on("container_exited", exited);

    emitDie("sess-1", "a1");

    expect(exited).not.toHaveBeenCalled();
    expect(containers.get("sess-1")).toBeDefined();
  });
});
