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
import { EGRESS_RESOLVER_LABEL } from "./egress-dns-install.js";
import { EGRESS_PROXY_LABEL } from "./egress-proxy-install.js";

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

// ---------------------------------------------------------------------------
// SHI-222 — egress sidecar reap on the crash path
// ---------------------------------------------------------------------------

/**
 * The agent container is the netns PARENT of the Tier B/C egress sidecars
 * (docs/172). When it dies on its own, the handler below deletes the session's
 * container-map entry — which LATCHES the leak, because every later
 * `destroyContainer(sessionId)` early-returns on `if (!sc) return`. So the reap
 * has to happen here, at the crash site, or it never happens at all.
 */
describe("container-health: egress sidecar reap on die/oom (SHI-222)", () => {
  let containers: Map<string, SessionContainer>;
  let emitter: EventEmitter<SessionContainerManagerEvents>;
  let eventStream: EventEmitter;
  let removed: string[];
  let deps: HealthDeps;

  interface FakeC { labels: Record<string, string>; parent?: string; running?: boolean }

  /**
   * Docker fake carrying `sess-1`'s two sidecars (netns parent `b1`), plus a
   * compose child and the agent container `b1` itself.
   *
   * `agentRunning` models the state the parent is ACTUALLY in when the reap
   * inspects it — which is not the same thing as what the event said. A Docker
   * `oom` event fires when the cgroup OOM-killer kills a process; if that process
   * wasn't PID 1, the container is still running. `extra` seeds additional
   * containers (used to stage the replacement incarnation).
   */
  function makeDocker(opts: { agentRunning?: boolean; extra?: Record<string, FakeC> } = {}) {
    const store = new Map<string, FakeC>([
      ["b1", { labels: {}, running: opts.agentRunning ?? false }],
      ["res-1", { labels: { [EGRESS_RESOLVER_LABEL]: "sess-1", "shipit-parent-session": "sess-1" }, parent: "b1" }],
      ["proxy-1", { labels: { [EGRESS_PROXY_LABEL]: "sess-1", "shipit-parent-session": "sess-1" }, parent: "b1" }],
      ["db-1", { labels: { "shipit-parent-session": "sess-1", "shipit-service-name": "db" } }],
      ...Object.entries(opts.extra ?? {}),
    ]);
    return {
      getEvents: vi.fn(async () => eventStream),
      listContainers: vi.fn(async (o: { filters?: { label?: string[] } }) => {
        const want = o.filters?.label?.[0] ?? "";
        const [key, value] = want.split("=", 2);
        return [...store.entries()]
          .filter(([, c]) => c.labels[key!] === value)
          .map(([Id]) => ({ Id }));
      }),
      getContainer: vi.fn((id: string) => ({
        inspect: vi.fn(async () => {
          const c = store.get(id);
          if (!c) throw Object.assign(new Error("no such container"), { statusCode: 404 });
          return {
            HostConfig: { NetworkMode: c.parent ? `container:${c.parent}` : "bridge" },
            State: { Running: c.running ?? false },
          };
        }),
        remove: vi.fn(async () => { removed.push(id); store.delete(id); }),
      })),
    } as unknown as HealthDeps["docker"];
  }

  beforeEach(() => {
    containers = new Map();
    emitter = new EventEmitter<SessionContainerManagerEvents>();
    eventStream = new EventEmitter();
    removed = [];
  });

  /**
   * Start the monitor with a Docker fake shaped for this test. Each test calls
   * this exactly once — starting a second monitor on the same `eventStream` would
   * leave TWO `data` handlers attached, and the stale one (holding the previous
   * fake) would answer the event too.
   */
  async function start(dockerOpts: { agentRunning?: boolean; extra?: Record<string, FakeC> } = {}) {
    deps = {
      docker: makeDocker(dockerOpts),
      containers,
      standbySessionIds: new Set<string>(),
      emitter,
      labelFilters: () => [],
    };
    await startHealthMonitor(deps, createHealthMonitorState());
  }

  function emit(action: "die" | "oom", sessionId: string, actorId?: string) {
    eventStream.emit("data", Buffer.from(JSON.stringify({
      Action: action,
      Actor: {
        ...(actorId ? { ID: actorId } : {}),
        Attributes: { [CONTAINER_SESSION_ID_LABEL]: sessionId, exitCode: "137" },
      },
    })));
  }

  it("reaps both egress sidecars when the agent container dies", async () => {
    await start();
    containers.set("sess-1", makeContainer("b1", "sess-1"));

    emit("die", "sess-1", "b1");

    // The reap is fire-and-forget from inside the Docker event handler.
    await vi.waitFor(() => expect(removed).toHaveLength(2));
    expect([...removed].sort()).toEqual(["proxy-1", "res-1"]);
  });

  it("reaps them on OOM when the container actually died", async () => {
    await start();
    containers.set("sess-1", makeContainer("b1", "sess-1"));

    emit("oom", "sess-1", "b1");

    await vi.waitFor(() => expect(removed).toHaveLength(2));
  });

  it("does NOT reap on an OOM the container SURVIVED — the event is not proof of death", async () => {
    // Docker's `oom` event fires when the cgroup's OOM-killer kills *a process*,
    // not necessarily the container. If the victim wasn't PID 1 — e.g. the agent
    // CLI is killed but the session worker survives — the container keeps running
    // and its network namespace is perfectly alive. Reaping on the event alone
    // would tear the resolver and proxy out from under a live worker, silently
    // killing its DNS and HTTPS. The reap confirms the parent is actually down
    // rather than taking the event's word for it.
    await start({ agentRunning: true }); // b1 survived the OOM
    containers.set("sess-1", makeContainer("b1", "sess-1"));

    emit("oom", "sess-1", "b1");

    await new Promise((r) => setTimeout(r, 30));
    expect(removed).toEqual([]);
  });

  it("does NOT reap when an ID-less die event resolves to the CURRENT, running container", async () => {
    // Older daemons omit `Actor.ID`, so the incarnation guard can't tell
    // generations apart and `deadContainerId` falls back to the tracked `sc.id` —
    // which may be the healthy REPLACEMENT. The liveness check is what stops that
    // from reaping a live session's sidecars.
    await start({ agentRunning: true });
    containers.set("sess-1", makeContainer("b1", "sess-1"));

    emit("die", "sess-1"); // no Actor.ID

    await new Promise((r) => setTimeout(r, 30));
    expect(removed).toEqual([]);
  });

  it("does NOT touch the session's compose children — an OOM must not drop the user's database", async () => {
    await start();
    containers.set("sess-1", makeContainer("b1", "sess-1"));

    emit("die", "sess-1", "b1");

    await vi.waitFor(() => expect(removed).toHaveLength(2));
    expect(removed).not.toContain("db-1");
  });

  it("does not reap on a STALE die event for a previous incarnation", async () => {
    // The stale-incarnation guard drops the event before the reap — otherwise a
    // late `die` for the container Rescue just stopped would tear the *healthy*
    // new container's sidecars out from under it.
    await start();
    containers.set("sess-1", makeContainer("b1", "sess-1"));

    emit("die", "sess-1", "a1"); // a1 = the OLD container

    await new Promise((r) => setTimeout(r, 20));
    expect(removed).toEqual([]);
  });

  it("SPARES a replacement incarnation's sidecars that appear while the reap is in flight", async () => {
    // The reap is fire-and-forget, so the session can be reactivated — bringing up
    // a NEW agent container and NEW sidecars under the SAME session id — before
    // our `listContainers` resolves. A reap scoped to the session label alone
    // would come back holding the replacement's sidecars and force-remove them,
    // leaving a healthy running agent with no DNS and no HTTPS. Scoping to the
    // dead container's id (`b1`) is what makes it idempotent.
    //
    // Staged here as "the replacement is already up when the reap lists" — the
    // worst case, and the one a label-only reap fails.
    await start({
      extra: {
        "b2": { labels: {}, running: true }, // the replacement agent, up and healthy
        "res-2": { labels: { [EGRESS_RESOLVER_LABEL]: "sess-1", "shipit-parent-session": "sess-1" }, parent: "b2" },
        "proxy-2": { labels: { [EGRESS_PROXY_LABEL]: "sess-1", "shipit-parent-session": "sess-1" }, parent: "b2" },
      },
    });
    containers.set("sess-1", makeContainer("b1", "sess-1"));

    emit("die", "sess-1", "b1"); // the OLD container (b1) died

    await vi.waitFor(() => expect(removed).toHaveLength(2));
    expect([...removed].sort()).toEqual(["proxy-1", "res-1"]); // b1's sidecars only
    expect(removed).not.toContain("res-2");
    expect(removed).not.toContain("proxy-2");
  });
});
