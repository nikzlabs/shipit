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
import { deriveSessionCpuSizing, SESSION_CPU_SHARES } from "./container-config-builder.js";
import { CLEANUP_CONTAINER_SESSION_ID } from "./shipit-own-sessions.js";

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
  hostConfig?: {
    Memory?: number; CpuQuota?: number; CpuPeriod?: number; CpuShares?: number; PidsLimit?: number;
  };
  updateThrows?: boolean;
  /** The daemon reports a dropped CPU setting as a warning on a 200, not as an error. */
  updateWarnings?: string[];
  /** Records what reconciliation actually asked the daemon for, not merely that it tried. */
  updates?: Record<string, unknown>[];
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
      update: async (opts: Record<string, unknown>) => {
        const spec = specs.find((s) => s.id === id);
        if (!spec) throw new Error("no such container");
        if (spec.updateThrows) throw new Error("update failed");
        if (spec.updateWarnings) return { Warnings: spec.updateWarnings };
        (spec.updates ??= []).push(opts);
        spec.hostConfig = { ...spec.hostConfig, ...opts };
        return { Warnings: [] };
      },
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
          ...(spec.hostConfig ? { HostConfig: spec.hostConfig } : {}),
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

  // A worker survives an orchestrator deploy, so without this it keeps the whole-host quota and
  // default weight that starved the orchestrator in the first place (docs/229).
  describe("CPU policy reconciliation", () => {
    const staleHostConfig = {
      Memory: 8 * 1024 * 1024 * 1024,
      CpuQuota: 1_600_000,
      PidsLimit: 8192,
    };

    it("rewrites a survivor's stale quota and missing weight in place", async () => {
      const specs: FakeContainerSpec[] = [
        { id: "c1", sessionId: "sess-1", state: "running", ip: "172.18.0.4", hostConfig: { ...staleHostConfig } },
      ];
      const { deps, containers } = makeDeps(specs);

      expect(await adoptRunningContainer(deps, "sess-1", resolver)).toBe(true);

      expect(specs[0].updates).toEqual([{
        CpuQuota: deriveSessionCpuSizing().cpuQuota,
        CpuPeriod: 100_000,
        CpuShares: SESSION_CPU_SHARES,
      }]);
      expect(containers.get("sess-1")?.bootedLimits?.cpuQuota).toBe(deriveSessionCpuSizing().cpuQuota);
    });

    it("compares the effective limit, so a halved period does not read as current", async () => {
      const specs: FakeContainerSpec[] = [{
        id: "c1", sessionId: "sess-1", state: "running", ip: "172.18.0.4",
        hostConfig: {
          ...staleHostConfig,
          CpuQuota: deriveSessionCpuSizing().cpuQuota,
          CpuPeriod: 50_000,
          CpuShares: SESSION_CPU_SHARES,
        },
      }];
      const { deps, containers } = makeDeps(specs);

      expect(await adoptRunningContainer(deps, "sess-1", resolver)).toBe(true);

      // 700000µs per 50ms is 14 cores, not the 7 the quota alone suggests.
      expect(specs[0].updates).toHaveLength(1);
      expect(specs[0].updates?.[0].CpuPeriod).toBe(100_000);
      expect(containers.get("sess-1")?.bootedLimits?.cpuQuota)
        .toBe(deriveSessionCpuSizing().cpuQuota);
    });

    it("rewrites a container whose quota is current but whose weight is the default", async () => {
      const specs: FakeContainerSpec[] = [{
        id: "c1", sessionId: "sess-1", state: "running", ip: "172.18.0.4",
        hostConfig: { ...staleHostConfig, CpuQuota: deriveSessionCpuSizing().cpuQuota, CpuShares: 0 },
      }];
      const { deps } = makeDeps(specs);

      expect(await adoptRunningContainer(deps, "sess-1", resolver)).toBe(true);
      expect(specs[0].updates?.[0].CpuShares).toBe(SESSION_CPU_SHARES);
    });

    it("treats a daemon warning as not applied rather than as success", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const specs: FakeContainerSpec[] = [{
        id: "c1", sessionId: "sess-1", state: "running", ip: "172.18.0.4",
        hostConfig: { ...staleHostConfig }, updateWarnings: ["Your kernel does not support CPU CFS quota"],
      }];
      const { deps, containers } = makeDeps(specs);

      expect(await adoptRunningContainer(deps, "sess-1", resolver)).toBe(true);
      expect(containers.get("sess-1")?.bootedLimits?.cpuQuota).toBe(1_600_000);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("never widens the cleanup worker, which is created from a smaller budget of its own", async () => {
      const specs: FakeContainerSpec[] = [{
        id: "c1", sessionId: CLEANUP_CONTAINER_SESSION_ID, state: "running", ip: "172.18.0.4",
        hostConfig: { ...staleHostConfig, CpuQuota: 50_000 },
      }];
      const { deps, containers } = makeDeps(specs);

      expect(await adoptRunningContainer(deps, CLEANUP_CONTAINER_SESSION_ID, resolver)).toBe(true);

      expect(specs[0].updates).toBeUndefined();
      expect(containers.get(CLEANUP_CONTAINER_SESSION_ID)?.bootedLimits?.cpuQuota).toBe(50_000);
    });

    it("preserves the memory and pids limits it does not manage", async () => {
      const specs: FakeContainerSpec[] = [
        { id: "c1", sessionId: "sess-1", state: "running", ip: "172.18.0.4", hostConfig: { ...staleHostConfig } },
      ];
      const { deps, containers } = makeDeps(specs);

      await adoptRunningContainer(deps, "sess-1", resolver);

      expect(specs[0].updates?.[0]).not.toHaveProperty("Memory");
      expect(specs[0].updates?.[0]).not.toHaveProperty("PidsLimit");
      expect(containers.get("sess-1")?.bootedLimits).toMatchObject({
        memoryLimit: staleHostConfig.Memory,
        pidsLimit: staleHostConfig.PidsLimit,
      });
    });

    it("leaves an already-current container alone", async () => {
      const specs: FakeContainerSpec[] = [{
        id: "c1", sessionId: "sess-1", state: "running", ip: "172.18.0.4",
        hostConfig: {
          ...staleHostConfig,
          CpuQuota: deriveSessionCpuSizing().cpuQuota,
          CpuShares: SESSION_CPU_SHARES,
        },
      }];
      const { deps } = makeDeps(specs);

      expect(await adoptRunningContainer(deps, "sess-1", resolver)).toBe(true);
      expect(specs[0].updates).toBeUndefined();
    });

    it("still adopts, reporting the real booted limits, when the daemon refuses the update", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const specs: FakeContainerSpec[] = [{
        id: "c1", sessionId: "sess-1", state: "running", ip: "172.18.0.4",
        hostConfig: { ...staleHostConfig, CpuQuota: 800_000, CpuPeriod: 50_000 },
        updateThrows: true,
      }];
      const { deps, containers } = makeDeps(specs);

      expect(await adoptRunningContainer(deps, "sess-1", resolver)).toBe(true);
      // Still 16 cores: reported on the 100ms basis, not as the 8 the raw quota reads like.
      expect(containers.get("sess-1")?.bootedLimits?.cpuQuota).toBe(1_600_000);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("reconciles every survivor on a rediscovery sweep", async () => {
      const specs: FakeContainerSpec[] = [
        { id: "c1", sessionId: "sess-1", state: "running", ip: "172.18.0.4", hostConfig: { ...staleHostConfig } },
        { id: "c2", sessionId: "sess-2", state: "running", ip: "172.18.0.5", hostConfig: { ...staleHostConfig } },
      ];
      const { deps } = makeDeps(specs);

      await rediscoverContainers(deps, new Set(["sess-1", "sess-2"]), resolver);

      expect(specs[0].updates).toHaveLength(1);
      expect(specs[1].updates).toHaveLength(1);
    });
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
