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
  let labelledStart: ReturnType<typeof vi.fn<() => void>>;
  let getEvents: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    containers = new Map();
    emitter = new EventEmitter<SessionContainerManagerEvents>();
    eventStream = new EventEmitter();
    labelledStart = vi.fn<() => void>();
    getEvents = vi.fn(async () => eventStream);
    deps = {
      docker: { getEvents } as unknown as HealthDeps["docker"],
      containers,
      standbySessionIds: new Set<string>(),
      emitter,
      labelFilters: () => [],
      onLabelledContainerStarted: labelledStart,
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

  describe("labelled-container start backstop", () => {
    const SESSION_LABEL = "shipit-parent-session";

    function emit(action: string, attributes: Record<string, string> = {}) {
      eventStream.emit("data", Buffer.from(JSON.stringify({
        Action: action,
        Actor: { ID: "c1", Attributes: attributes },
      })));
    }

    it("subscribes to start events, which the crash path has no use for", () => {
      const filters = getEvents.mock.calls[0]?.[0]?.filters as { event?: string[] } | undefined;
      expect(filters?.event).toContain("start");
    });

    it("reports a labelled container coming up", () => {
      emit("start", { [SESSION_LABEL]: "sess-1" });
      expect(labelledStart).toHaveBeenCalledTimes(1);
    });

    it("ignores an unlabelled start — daemon churn must not cost the index", () => {
      emit("start", { image: "postgres:16" });
      expect(labelledStart).not.toHaveBeenCalled();
    });

    it("ignores die and oom, which cannot create a more-trusted caller", () => {
      emit("die", { [SESSION_LABEL]: "sess-1", exitCode: "0" });
      emit("oom", { [SESSION_LABEL]: "sess-1" });
      expect(labelledStart).not.toHaveBeenCalled();
    });

    it("reads every record in a chunk that carries several", () => {
      const record = (action: string, attrs: Record<string, string>, id = "c1") =>
        JSON.stringify({ Action: action, Actor: { ID: id, Attributes: attrs } });
      const exited = vi.fn();
      containers.set("sess-1", makeContainer("b1", "sess-1"));
      emitter.on("container_exited", exited);

      eventStream.emit("data", Buffer.from([
        record("start", { [SESSION_LABEL]: "sess-1" }),
        record("start", { [SESSION_LABEL]: "sess-1" }),
        record("die", { [CONTAINER_SESSION_ID_LABEL]: "sess-1", exitCode: "1" }, "b1"),
        "",
      ].join("\n")));

      expect(labelledStart).toHaveBeenCalledTimes(2);
      expect(exited).toHaveBeenCalledWith("sess-1", 1, undefined);
    });
  });

  it("drops a die event whose Actor.ID does not match the tracked container", () => {
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
    containers.set("sess-1", { ...makeContainer("", "sess-1"), status: "starting" });
    const exited = vi.fn();
    emitter.on("container_exited", exited);

    emitDie("sess-1", "a1");

    expect(exited).not.toHaveBeenCalled();
    expect(containers.get("sess-1")).toBeDefined();
  });
});

describe("container-health: egress sidecar reap on die/oom (planning#224)", () => {
  let containers: Map<string, SessionContainer>;
  let emitter: EventEmitter<SessionContainerManagerEvents>;
  let eventStream: EventEmitter;
  let removed: string[];
  let deps: HealthDeps;
  let store: Map<string, FakeC>;

  interface FakeC { labels: Record<string, string>; parent?: string; running?: boolean }

  function makeDocker(opts: { agentRunning?: boolean; extra?: Record<string, FakeC> } = {}) {
    store = new Map<string, FakeC>([
      ["b1", { labels: {}, running: opts.agentRunning ?? false }],
      ["res-1", { labels: { [EGRESS_RESOLVER_LABEL]: "sess-1", "shipit-parent-session": "sess-1" }, parent: "b1" }],
      ["proxy-1", { labels: { [EGRESS_PROXY_LABEL]: "sess-1", "shipit-parent-session": "sess-1" }, parent: "b1" }],
      ["db-1", { labels: { "shipit-parent-session": "sess-1", "shipit-service-name": "db" } }],
      ...Object.entries(opts.extra ?? {}),
    ]);
    return {
      getEvents: vi.fn(async () => eventStream),
      listContainers: vi.fn(async (o: { all?: boolean; filters?: { label?: string[] } }) => {
        const want = o.filters?.label?.[0] ?? "";
        const [key, value] = want.includes("=") ? want.split("=", 2) : [want, undefined];
        return [...store.entries()]
          .filter(([, c]) => {
            if (!o.all && !(c.running ?? false)) return false;
            const actual = c.labels[key!];
            if (actual === undefined) return false;
            return value === undefined || actual === value;
          })
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

  function kill(id: string) {
    const c = store.get(id);
    if (c) c.running = false;
  }

  beforeEach(() => {
    containers = new Map();
    emitter = new EventEmitter<SessionContainerManagerEvents>();
    eventStream = new EventEmitter();
    removed = [];
  });

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
    await start({ agentRunning: true });
    containers.set("sess-1", makeContainer("b1", "sess-1"));

    emit("oom", "sess-1", "b1");

    await new Promise((r) => setTimeout(r, 30));
    expect(removed).toEqual([]);
  });

  it("does NOT reap when an ID-less die event resolves to the CURRENT, running container", async () => {
    await start({ agentRunning: true });
    containers.set("sess-1", makeContainer("b1", "sess-1"));

    emit("die", "sess-1");

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

  it("reaps on the `die` that FOLLOWS an `oom` — by then the map entry is already gone", async () => {
    await start({ agentRunning: true });
    containers.set("sess-1", makeContainer("b1", "sess-1"));

    emit("oom", "sess-1", "b1");
    await new Promise((r) => setTimeout(r, 20));
    expect(removed).toEqual([]);
    expect(containers.get("sess-1")).toBeDefined();

    kill("b1");
    emit("die", "sess-1", "b1");

    await vi.waitFor(() => expect([...removed].sort()).toEqual(["proxy-1", "res-1"]));
    expect(containers.get("sess-1")).toBeUndefined();
  });

  it("reaps on an ID-LESS oom→die pair — the map entry is the only id we have", async () => {
    await start({ agentRunning: true });
    containers.set("sess-1", makeContainer("b1", "sess-1"));

    emit("oom", "sess-1");
    await new Promise((r) => setTimeout(r, 20));
    expect(removed).toEqual([]);

    kill("b1");
    emit("die", "sess-1");

    await vi.waitFor(() => expect([...removed].sort()).toEqual(["proxy-1", "res-1"]));
  });

  it("leaves a session ALONE when it survived the OOM — no exit, no reap", async () => {
    await start({ agentRunning: true });
    containers.set("sess-1", makeContainer("b1", "sess-1"));
    const exited = vi.fn();
    emitter.on("container_exited", exited);

    emit("oom", "sess-1", "b1");

    await new Promise((r) => setTimeout(r, 30));
    expect(removed).toEqual([]);
    expect(exited).not.toHaveBeenCalled();
    expect(containers.get("sess-1")?.id).toBe("b1");
  });

  it("attributes 'Out of memory' by INCARNATION id on an id-carrying oom→die pair", async () => {
    await start({ agentRunning: true });
    containers.set("sess-1", makeContainer("b1", "sess-1"));
    const exited = vi.fn();
    emitter.on("container_exited", exited);

    emit("oom", "sess-1", "b1");
    kill("b1");
    emit("die", "sess-1", "b1");

    expect(exited).toHaveBeenCalledWith("sess-1", 137, "Out of memory");
  });

  it("attributes 'Out of memory' when the oom carries an id but the die does not", async () => {
    await start({ agentRunning: true });
    containers.set("sess-1", makeContainer("b1", "sess-1"));
    const exited = vi.fn();
    emitter.on("container_exited", exited);

    emit("oom", "sess-1", "b1");
    kill("b1");
    emit("die", "sess-1");

    expect(exited).toHaveBeenCalledWith("sess-1", 137, "Out of memory");
  });

  it("does NOT pin a stale incarnation's OOM on the current container's death", async () => {
    await start({ agentRunning: true });
    containers.set("sess-1", makeContainer("b1", "sess-1"));
    const exited = vi.fn();
    emitter.on("container_exited", exited);

    emit("oom", "sess-1", "a1");
    kill("b1");
    emit("die", "sess-1", "b1");

    expect(exited).toHaveBeenCalledWith("sess-1", 137, undefined);
  });

  it("reaps a PREVIOUS incarnation's orphans on a stale die, sparing the current one's", async () => {
    await start({
      agentRunning: true,
      extra: {
        "res-0": { labels: { [EGRESS_RESOLVER_LABEL]: "sess-1", "shipit-parent-session": "sess-1" }, parent: "a1" },
        "proxy-0": { labels: { [EGRESS_PROXY_LABEL]: "sess-1", "shipit-parent-session": "sess-1" }, parent: "a1" },
      },
    });
    containers.set("sess-1", makeContainer("b1", "sess-1"));
    const exited = vi.fn();
    emitter.on("container_exited", exited);

    emit("die", "sess-1", "a1");

    await vi.waitFor(() => expect([...removed].sort()).toEqual(["proxy-0", "res-0"]));
    expect(removed).not.toContain("res-1");
    expect(removed).not.toContain("proxy-1");
    expect(exited).not.toHaveBeenCalled();
    expect(containers.get("sess-1")?.id).toBe("b1");
  });

  it("SPARES a replacement incarnation's sidecars that appear while the reap is in flight", async () => {
    await start({
      extra: {
        "b2": { labels: {}, running: true },
        "res-2": { labels: { [EGRESS_RESOLVER_LABEL]: "sess-1", "shipit-parent-session": "sess-1" }, parent: "b2" },
        "proxy-2": { labels: { [EGRESS_PROXY_LABEL]: "sess-1", "shipit-parent-session": "sess-1" }, parent: "b2" },
      },
    });
    containers.set("sess-1", makeContainer("b1", "sess-1"));

    emit("die", "sess-1", "b1");

    await vi.waitFor(() => expect(removed).toHaveLength(2));
    expect([...removed].sort()).toEqual(["proxy-1", "res-1"]);
    expect(removed).not.toContain("res-2");
    expect(removed).not.toContain("proxy-2");
  });
});

describe("container-health: compose service vs. ShipIt's own session children", () => {
  const PARENT = "shipit-parent-session";
  type ServiceExited = (...args: SessionContainerManagerEvents["service_exited"]) => void;
  type ChildExited = (...args: SessionContainerManagerEvents["session_child_exited"]) => void;
  let emitter: EventEmitter<SessionContainerManagerEvents>;
  let eventStream: EventEmitter;
  let serviceExited: ReturnType<typeof vi.fn<ServiceExited>>;
  let childExited: ReturnType<typeof vi.fn<ChildExited>>;

  beforeEach(async () => {
    emitter = new EventEmitter<SessionContainerManagerEvents>();
    eventStream = new EventEmitter();
    serviceExited = vi.fn<ServiceExited>();
    childExited = vi.fn<ChildExited>();
    emitter.on("service_exited", serviceExited);
    emitter.on("session_child_exited", childExited);
    await startHealthMonitor(
      {
        docker: { getEvents: vi.fn(async () => eventStream) } as unknown as HealthDeps["docker"],
        containers: new Map(),
        standbySessionIds: new Set<string>(),
        emitter,
        labelFilters: () => [],
      },
      createHealthMonitorState(),
    );
  });

  function die(attributes: Record<string, string>, action = "die") {
    eventStream.emit("data", Buffer.from(JSON.stringify({
      Action: action,
      Actor: { ID: "c1", Attributes: { exitCode: "137", ...attributes } },
    })));
  }

  it("reports a project compose service, by name", () => {
    die({ [PARENT]: "sess-1", "shipit-service-name": "dev" });

    expect(serviceExited).toHaveBeenCalledWith("sess-1", {
      serviceName: "dev", containerId: "c1", exitCode: 137, oom: false,
    });
    expect(childExited).not.toHaveBeenCalled();
  });

  it("does NOT report a compose-service egress sidecar as a service exit", () => {
    die({ [PARENT]: "sess-1", "shipit-egress-service-sidecar": "true", "shipit-egress-parent": "svc-1" });

    expect(serviceExited).not.toHaveBeenCalled();
    expect(childExited).toHaveBeenCalledWith("sess-1", {
      containerId: "c1", exitCode: 137, oom: false, egressSidecar: true,
    });
  });

  it("reports a service the SESSION brought up through the Docker proxy", () => {
    die({ [PARENT]: "sess-1", "com.docker.compose.service": "worker" });

    expect(serviceExited).toHaveBeenCalledWith("sess-1", {
      serviceName: "worker", containerId: "c1", exitCode: 137, oom: false,
    });
    expect(childExited).not.toHaveBeenCalled();
  });

  it("keeps a sidecar out of the service path even if it carries a compose label", () => {
    die({
      [PARENT]: "sess-1",
      "shipit-egress-service-sidecar": "true",
      "com.docker.compose.service": "egress-sidecar",
    });

    expect(serviceExited).not.toHaveBeenCalled();
    expect(childExited.mock.calls[0]?.[1]).toMatchObject({ egressSidecar: true });
  });

  it("does NOT report the agent's own Tier B/C sidecars as service exits", () => {
    die({ [PARENT]: "sess-1", [EGRESS_RESOLVER_LABEL]: "sess-1" });
    die({ [PARENT]: "sess-1", [EGRESS_PROXY_LABEL]: "sess-1" });

    expect(serviceExited).not.toHaveBeenCalled();
    expect(childExited).toHaveBeenCalledTimes(2);
    expect(childExited.mock.calls.every(([, info]) => info.egressSidecar)).toBe(true);
  });

  it("does NOT report a session child it cannot name, and says it cannot name it", () => {
    die({ [PARENT]: "sess-1", exitCode: "0" });

    expect(serviceExited).not.toHaveBeenCalled();
    expect(childExited).toHaveBeenCalledWith("sess-1", {
      containerId: "c1", exitCode: 0, oom: false, egressSidecar: false,
    });
  });

  it("does NOT route a sidecar OOM into the service path", () => {
    die({ [PARENT]: "sess-1", "shipit-egress-service-sidecar": "true" }, "oom");

    expect(serviceExited).not.toHaveBeenCalled();
    expect(childExited.mock.calls[0]?.[1]).toMatchObject({ oom: true, egressSidecar: true });
  });

  it("ignores a dying container with no session parent at all", () => {
    die({ image: "postgres:16" });

    expect(serviceExited).not.toHaveBeenCalled();
    expect(childExited).not.toHaveBeenCalled();
  });
});
