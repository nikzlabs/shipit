import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  adoptRunningContainer,
  isTrackedContainerRunning,
  rediscoverContainers,
  reapStandbyContainers,
  type DiscoveryDeps,
} from "./container-discovery.js";
import { overlayVolumeName } from "./overlay-volume.js";
import {
  CONTAINER_SESSION_ID_LABEL,
  CONTAINER_STANDBY_LABEL,
  type SessionContainer,
} from "./session-container.js";

const NETWORK = "shipit-test";
const WORKER_PORT = 9100;

interface FakeContainerSpec {
  id: string;
  sessionId: string;
  state: "running" | "exited";
  ip?: string;
  standby?: boolean;
  buildId?: string;
  inspectThrows?: boolean;
  inspectStatus?: number;
  mounts?: { Type: string; Name?: string; Destination: string }[];
}

function makeFakeDocker(specs: FakeContainerSpec[]) {
  const matchesFilter = (s: FakeContainerSpec, wanted: string | undefined): boolean => {
    if (!wanted) return true;
    if (wanted === `${CONTAINER_STANDBY_LABEL}=true`) return s.standby === true;
    return wanted === `${CONTAINER_SESSION_ID_LABEL}=${s.sessionId}`;
  };
  return {
    listContainers: async ({ filters }: { filters?: { label?: string[] } } = {}) => {
      const wanted = filters?.label?.[0];
      return specs
        .filter((s) => matchesFilter(s, wanted))
        .map((s) => ({
          Id: s.id,
          State: s.state,
          Labels: {
            [CONTAINER_SESSION_ID_LABEL]: s.sessionId,
            ...(s.standby ? { [CONTAINER_STANDBY_LABEL]: "true" } : {}),
            ...(s.buildId ? { "shipit-build-id": s.buildId } : {}),
          },
        }));
    },
    getContainer: (id: string) => ({
      stop: async () => {
        const spec = specs.find((s) => s.id === id);
        if (spec) spec.state = "exited";
      },
      remove: async () => {
        const at = specs.findIndex((s) => s.id === id);
        if (at >= 0) specs.splice(at, 1);
      },
      inspect: async () => {
        const spec = specs.find((s) => s.id === id);
        if (!spec || spec.inspectThrows) throw new Error("inspect failed");
        if (spec.inspectStatus !== undefined) {
          throw Object.assign(new Error("docker says no"), { statusCode: spec.inspectStatus });
        }
        return {
          State: { Running: spec.state === "running" },
          NetworkSettings: {
            Networks: spec.ip ? { [NETWORK]: { IPAddress: spec.ip } } : {},
          },
          ...(spec.mounts ? { Mounts: spec.mounts } : {}),
        };
      },
    }),
  } as unknown as DiscoveryDeps["docker"];
}

function makeDeps(specs: FakeContainerSpec[]): {
  deps: DiscoveryDeps;
  containers: Map<string, SessionContainer>;
  standby: Set<string>;
} {
  const containers = new Map<string, SessionContainer>();
  const standby = new Set<string>();
  return {
    containers,
    standby,
    deps: {
      docker: makeFakeDocker(specs),
      containers,
      standbySessionIds: standby,
      networkName: NETWORK,
      workerPort: WORKER_PORT,
      labelFilters: () => [],
    },
  };
}

const resolver = (sid: string) => ({ workspaceDir: `/ws/${sid}`, dockerAccess: false });

describe("adoptRunningContainer", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it("re-adopts a live container into the manager map", async () => {
    const { deps, containers } = makeDeps([
      { id: "c1", sessionId: "sess-1", state: "running", ip: "172.18.0.4" },
    ]);

    const adopted = await adoptRunningContainer(deps, "sess-1", resolver);

    expect(adopted).toBe(true);
    const sc = containers.get("sess-1");
    expect(sc).toMatchObject({
      id: "c1",
      sessionId: "sess-1",
      containerIp: "172.18.0.4",
      workerUrl: "http://172.18.0.4:9100",
      status: "running",
      hostWorkspaceDir: "/ws/sess-1",
    });
  });

  it("preserves the immutable worker build label on adoption", async () => {
    const { deps, containers } = makeDeps([
      { id: "c1", sessionId: "sess-1", state: "running", ip: "172.18.0.4", buildId: "worker-sha" },
    ]);

    await adoptRunningContainer(deps, "sess-1", resolver);

    expect(containers.get("sess-1")?.workerBuildId).toBe("worker-sha");
  });

  it("records the dep-dir overlays the adopted container actually has (#2426)", async () => {
    const { deps, containers } = makeDeps([
      {
        id: "c1",
        sessionId: "sess-1",
        state: "running",
        ip: "172.18.0.4",
        mounts: [
          { Type: "volume", Name: "shipit_workspace", Destination: "/workspace" },
          {
            Type: "volume",
            Name: overlayVolumeName("sess-1", "node_modules"),
            Destination: "/workspace/node_modules",
          },
        ],
      },
    ]);

    await adoptRunningContainer(deps, "sess-1", resolver);

    expect(containers.get("sess-1")?.overlayDepDirs).toEqual([
      { depDir: "node_modules", volumeName: overlayVolumeName("sess-1", "node_modules") },
    ]);
  });

  it("records an empty overlay set for a container that has none", async () => {
    const { deps, containers } = makeDeps([
      {
        id: "c1",
        sessionId: "sess-1",
        state: "running",
        ip: "172.18.0.4",
        mounts: [{ Type: "volume", Name: "shipit_workspace", Destination: "/workspace" }],
      },
    ]);

    await adoptRunningContainer(deps, "sess-1", resolver);

    expect(containers.get("sess-1")?.overlayDepDirs).toEqual([]);
  });

  it("returns false and adopts nothing when the resolver yields no workspaceDir", async () => {
    const { deps, containers } = makeDeps([
      { id: "c1", sessionId: "sess-1", state: "running", ip: "172.18.0.4" },
    ]);

    const adopted = await adoptRunningContainer(deps, "sess-1", () => undefined);

    expect(adopted).toBe(false);
    expect(containers.has("sess-1")).toBe(false);
  });

  it("ignores non-running containers", async () => {
    const { deps, containers } = makeDeps([
      { id: "c1", sessionId: "sess-1", state: "exited", ip: "172.18.0.4" },
    ]);

    expect(await adoptRunningContainer(deps, "sess-1", resolver)).toBe(false);
    expect(containers.has("sess-1")).toBe(false);
  });

  it("is a no-op when the session is already tracked", async () => {
    const { deps, containers } = makeDeps([
      { id: "c1", sessionId: "sess-1", state: "running", ip: "172.18.0.4" },
    ]);
    containers.set("sess-1", { id: "already-here" } as SessionContainer);

    expect(await adoptRunningContainer(deps, "sess-1", resolver)).toBe(false);
    expect(containers.get("sess-1")?.id).toBe("already-here");
  });

  it("does not mark a claimed session standby just because the label survived", async () => {
    const { deps, standby, containers } = makeDeps([
      { id: "c1", sessionId: "sess-1", state: "running", ip: "172.18.0.4", standby: true },
    ]);

    expect(await adoptRunningContainer(deps, "sess-1", resolver)).toBe(true);
    expect(containers.has("sess-1")).toBe(true);
    expect(standby.has("sess-1")).toBe(false);
  });

  it("returns false (and logs a breadcrumb) when inspect throws", async () => {
    const { deps, containers } = makeDeps([
      { id: "c1", sessionId: "sess-1", state: "running", inspectThrows: true },
    ]);

    expect(await adoptRunningContainer(deps, "sess-1", resolver)).toBe(false);
    expect(containers.has("sess-1")).toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });

  it("skips a running container that has no IP on the bridge network", async () => {
    const { deps, containers } = makeDeps([
      { id: "c1", sessionId: "sess-1", state: "running" },
    ]);

    expect(await adoptRunningContainer(deps, "sess-1", resolver)).toBe(false);
    expect(containers.has("sess-1")).toBe(false);
  });
});

describe("rediscoverContainers", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("carries the container's dep-dir overlays into the rediscovered record", async () => {
    const nm = overlayVolumeName("sess-1", "node_modules");
    const dist = overlayVolumeName("sess-1", "dist");
    const { deps, containers } = makeDeps([
      {
        id: "c1",
        sessionId: "sess-1",
        state: "running",
        ip: "172.18.0.4",
        mounts: [
          { Type: "volume", Name: "shipit_workspace", Destination: "/workspace" },
          { Type: "volume", Name: nm, Destination: "/workspace/node_modules" },
          { Type: "volume", Name: dist, Destination: "/workspace/dist" },
        ],
      },
    ]);

    const count = await rediscoverContainers(deps, new Set(["sess-1"]), resolver);

    expect(count).toBe(1);
    expect(containers.get("sess-1")?.overlayDepDirs).toEqual([
      { depDir: "dist", volumeName: dist },
      { depDir: "node_modules", volumeName: nm },
    ]);
  });
});

describe("reapStandbyContainers", () => {
  it("removes every unclaimed standby container and spares real session containers", async () => {
    const specs: FakeContainerSpec[] = [
      { id: "c-standby", sessionId: "warm-1", state: "running", ip: "172.18.0.4", standby: true },
      { id: "c-real", sessionId: "sess-1", state: "running", ip: "172.18.0.5" },
    ];
    const { deps, containers, standby } = makeDeps(specs);
    containers.set("warm-1", { id: "c-standby", sessionId: "warm-1" } as SessionContainer);
    standby.add("warm-1");
    containers.set("sess-1", { id: "c-real", sessionId: "sess-1" } as SessionContainer);

    expect(await reapStandbyContainers(deps, new Set(["sess-1"]))).toBe(1);

    expect(specs.map((s) => s.id)).toEqual(["c-real"]);
    expect(containers.has("warm-1")).toBe(false);
    expect(standby.has("warm-1")).toBe(false);
    expect(containers.has("sess-1")).toBe(true);
  });

  it("spares a CLAIMED standby — the label outlives the claim, the session row decides", async () => {
    const specs: FakeContainerSpec[] = [
      { id: "c-claimed", sessionId: "sess-graduated", state: "running", ip: "172.18.0.4", standby: true },
    ];
    const { deps } = makeDeps(specs);

    expect(await reapStandbyContainers(deps, new Set(["sess-graduated"]))).toBe(0);
    expect(specs.map((s) => s.id)).toEqual(["c-claimed"]);
  });

  it("reaps a standby this process never tracked, and one already exited", async () => {
    const specs: FakeContainerSpec[] = [
      { id: "c-untracked", sessionId: "warm-1", state: "running", standby: true },
      { id: "c-exited", sessionId: "warm-2", state: "exited", standby: true },
    ];
    const { deps } = makeDeps(specs);

    expect(await reapStandbyContainers(deps, new Set())).toBe(2);
    expect(specs).toEqual([]);
  });

  it("is a no-op with no standby containers", async () => {
    const { deps } = makeDeps([
      { id: "c-real", sessionId: "sess-1", state: "running", ip: "172.18.0.5" },
    ]);
    expect(await reapStandbyContainers(deps, new Set(["sess-1"]))).toBe(0);
  });

  it("resolves rather than throwing when Docker is unavailable", async () => {
    const { deps } = makeDeps([]);
    const broken = {
      ...deps,
      docker: {
        listContainers: async () => { throw new Error("daemon down"); },
      } as unknown as DiscoveryDeps["docker"],
    };
    expect(await reapStandbyContainers(broken, new Set())).toBe(0);
  });
});

describe("isTrackedContainerRunning", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  function track(
    containers: Map<string, SessionContainer>,
    sessionId: string,
    id: string,
  ): void {
    containers.set(sessionId, {
      id,
      sessionId,
      containerIp: "172.18.0.4",
      workerUrl: "http://172.18.0.4:9100",
      status: "running",
    } as SessionContainer);
  }

  it("reports true for a container Docker still lists as running", async () => {
    const { deps, containers } = makeDeps([
      { id: "c1", sessionId: "sess-1", state: "running", ip: "172.18.0.4" },
    ]);
    track(containers, "sess-1", "c1");

    expect(await isTrackedContainerRunning(deps, "sess-1")).toBe(true);
  });

  it("reports false for a tracked container Docker says has exited", async () => {
    const { deps, containers } = makeDeps([
      { id: "c1", sessionId: "sess-1", state: "exited" },
    ]);
    track(containers, "sess-1", "c1");

    expect(await isTrackedContainerRunning(deps, "sess-1")).toBe(false);
  });

  it("reports false when the container is gone entirely (404)", async () => {
    const { deps, containers } = makeDeps([
      { id: "c1", sessionId: "sess-1", state: "running", inspectStatus: 404 },
    ]);
    track(containers, "sess-1", "c1");

    expect(await isTrackedContainerRunning(deps, "sess-1")).toBe(false);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("reports undefined — never false — when Docker cannot answer", async () => {
    const { deps, containers } = makeDeps([
      { id: "c1", sessionId: "sess-1", state: "running", inspectThrows: true },
    ]);
    track(containers, "sess-1", "c1");

    expect(await isTrackedContainerRunning(deps, "sess-1")).toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });

  it("reports undefined for a session with no tracked container", async () => {
    const { deps } = makeDeps([]);

    expect(await isTrackedContainerRunning(deps, "sess-unknown")).toBeUndefined();
  });
});
