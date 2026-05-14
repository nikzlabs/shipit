/**
 * Unit tests for `adoptRunningContainer` — the C3 inverse-leak backstop.
 *
 * A `die`/`oom` event mis-attributed to the wrong container incarnation can
 * delete a *healthy* container's manager-map entry. The missing-container
 * reconciler then calls this to re-adopt the still-running Docker container
 * instead of force-disposing the runner and leaking the container.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { adoptRunningContainer, type DiscoveryDeps } from "./container-discovery.js";
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
  inspectThrows?: boolean;
}

function makeFakeDocker(specs: FakeContainerSpec[]) {
  return {
    listContainers: async ({ filters }: { filters?: { label?: string[] } } = {}) => {
      // Honor the `shipit-session-id=<sid>` label filter the helper passes.
      const wanted = filters?.label?.[0];
      return specs
        .filter((s) => !wanted || wanted === `${CONTAINER_SESSION_ID_LABEL}=${s.sessionId}`)
        .map((s) => ({
          Id: s.id,
          State: s.state,
          Labels: {
            [CONTAINER_SESSION_ID_LABEL]: s.sessionId,
            ...(s.standby ? { [CONTAINER_STANDBY_LABEL]: "true" } : {}),
          },
        }));
    },
    getContainer: (id: string) => ({
      inspect: async () => {
        const spec = specs.find((s) => s.id === id);
        if (!spec || spec.inspectThrows) throw new Error("inspect failed");
        return {
          NetworkSettings: {
            Networks: spec.ip ? { [NETWORK]: { IPAddress: spec.ip } } : {},
          },
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

  it("returns false and adopts nothing when the resolver yields no workspaceDir", async () => {
    const { deps, containers } = makeDeps([
      { id: "c1", sessionId: "sess-1", state: "running", ip: "172.18.0.4" },
    ]);

    // Resolver returns undefined — e.g. the session has no workspaceDir yet.
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
    // Existing entry untouched.
    expect(containers.get("sess-1")?.id).toBe("already-here");
  });

  it("re-adds a standby-labeled container to the standby set", async () => {
    const { deps, standby } = makeDeps([
      { id: "c1", sessionId: "sess-1", state: "running", ip: "172.18.0.4", standby: true },
    ]);

    expect(await adoptRunningContainer(deps, "sess-1", resolver)).toBe(true);
    expect(standby.has("sess-1")).toBe(true);
  });

  it("returns false (and logs a breadcrumb) when inspect throws", async () => {
    const { deps, containers } = makeDeps([
      { id: "c1", sessionId: "sess-1", state: "running", inspectThrows: true },
    ]);

    expect(await adoptRunningContainer(deps, "sess-1", resolver)).toBe(false);
    expect(containers.has("sess-1")).toBe(false);
    // A broken inspect must leave a trace, not vanish silently.
    expect(errSpy).toHaveBeenCalled();
  });

  it("skips a running container that has no IP on the bridge network", async () => {
    const { deps, containers } = makeDeps([
      { id: "c1", sessionId: "sess-1", state: "running" /* no ip */ },
    ]);

    expect(await adoptRunningContainer(deps, "sess-1", resolver)).toBe(false);
    expect(containers.has("sess-1")).toBe(false);
  });
});
