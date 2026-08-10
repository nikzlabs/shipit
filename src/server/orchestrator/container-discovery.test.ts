/**
 * Unit tests for `adoptRunningContainer` — the C3 inverse-leak backstop.
 *
 * A `die`/`oom` event mis-attributed to the wrong container incarnation can
 * delete a *healthy* container's manager-map entry. The missing-container
 * reconciler then calls this to re-adopt the still-running Docker container
 * instead of force-disposing the runner and leaking the container.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  adoptRunningContainer,
  isTrackedContainerRunning,
  type DiscoveryDeps,
} from "./container-discovery.js";
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
  /** When set, `inspect` rejects with an error carrying this HTTP status. */
  inspectStatus?: number;
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
            ...(s.buildId ? { "shipit-build-id": s.buildId } : {}),
          },
        }));
    },
    getContainer: (id: string) => ({
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

/**
 * `isTrackedContainerRunning` — the docs/121 gap E liveness probe.
 *
 * The manager map is only ever corrected by the Docker event stream, so a
 * `die` delivered while that stream was down leaves an entry claiming
 * `running` for a container that no longer exists. This is the one call that
 * re-verifies it, and the distinction between "Docker says not running" and
 * "Docker could not answer" is the whole point: the caller declares a session
 * dead on the former.
 */
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
    // The exact shape of a missed `die`: our map still says running, Docker
    // does not.
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

    // A 404 is proof of death, not an ambiguous failure — no breadcrumb needed.
    expect(await isTrackedContainerRunning(deps, "sess-1")).toBe(false);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("reports undefined — never false — when Docker cannot answer", async () => {
    // A daemon outage must not be readable as "every session is dead".
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
