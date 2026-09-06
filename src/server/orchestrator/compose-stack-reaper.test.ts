import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Docker from "dockerode";
import type { SessionInfo } from "../shared/types.js";
import type { SessionManager } from "./sessions.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import {
  COMPOSE_PROJECT_LABEL,
  PARENT_SESSION_LABEL,
  composeProjectName,
  downComposeStackByProject,
  reapSurvivingComposeStacks,
} from "./compose-stack-reaper.js";

// docs/290 — the boot reconciliation for compose stacks that outlived the
// orchestrator process that started them.
describe("compose-stack-reaper", () => {
  const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const OTHER = "11111111-2222-3333-4444-555555555555";

  interface FakeContainer {
    Id: string;
    State?: string;
    Labels: Record<string, string>;
  }

  interface FakeNetwork {
    Id: string;
    Name: string;
    Labels: Record<string, string>;
  }

  function matchesLabelFilter(labels: Record<string, string>, filters: string[]): boolean {
    // Docker's `label` filter is AND across entries, and each entry is either
    // `key` (has the label) or `key=value`.
    return filters.every((f) => {
      const eq = f.indexOf("=");
      if (eq === -1) return labels[f] !== undefined;
      return labels[f.slice(0, eq)] === f.slice(eq + 1);
    });
  }

  function fakeDocker(opts: {
    containers?: FakeContainer[];
    networks?: FakeNetwork[];
    /** Container ids whose `remove` rejects, with the given statusCode. */
    removeFails?: Record<string, number>;
    listContainersThrows?: boolean;
  }) {
    const stopped: string[] = [];
    const removed: string[] = [];
    const networksRemoved: string[] = [];
    const volumeCalls: string[] = [];
    const containers = opts.containers ?? [];
    const networks = opts.networks ?? [];

    const docker = {
      listContainers: vi.fn(async (o: { filters: { label: string[] } }) => {
        if (opts.listContainersThrows) throw new Error("daemon unreachable");
        return containers.filter((c) => matchesLabelFilter(c.Labels, o.filters.label));
      }),
      getContainer: (id: string) => ({
        stop: async () => { stopped.push(id); },
        remove: async () => {
          const code = opts.removeFails?.[id];
          if (code !== undefined) {
            const err = new Error(`remove refused for ${id}`) as Error & { statusCode: number };
            err.statusCode = code;
            throw err;
          }
          removed.push(id);
        },
      }),
      listNetworks: vi.fn(async (o: { filters: { label: string[] } }) =>
        networks.filter((n) => matchesLabelFilter(n.Labels, o.filters.label))),
      getNetwork: (id: string) => ({
        remove: async () => { networksRemoved.push(id); },
      }),
      // Present so a teardown that ever reached for volumes would be visible
      // rather than silently absent — a `light` session's overlay must survive.
      listVolumes: vi.fn(async () => { volumeCalls.push("list"); return { Volumes: [] }; }),
      getVolume: (name: string) => ({ remove: async () => { volumeCalls.push(name); } }),
    };
    return { docker: docker as unknown as Docker, stopped, removed, networksRemoved, volumeCalls };
  }

  function serviceContainer(sessionId: string, id: string, state = "running"): FakeContainer {
    return {
      Id: id,
      State: state,
      Labels: {
        [PARENT_SESSION_LABEL]: sessionId,
        [COMPOSE_PROJECT_LABEL]: composeProjectName(sessionId),
        "shipit-service-name": "dev",
      },
    };
  }

  function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
    return {
      id: SID,
      title: "s",
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      ...overrides,
    } as SessionInfo;
  }

  function deps(opts: {
    docker: Docker;
    sessions?: Record<string, SessionInfo>;
    runners?: Record<string, object>;
    serviceManagers?: Map<string, unknown>;
    unprobed?: Set<string>;
  }) {
    const sessions = opts.sessions ?? { [SID]: session() };
    return {
      docker: opts.docker,
      sessionManager: { get: (id: string) => sessions[id] } as unknown as SessionManager,
      runnerRegistry: { get: (id: string) => opts.runners?.[id] } as unknown as SessionRunnerRegistry,
      serviceManagers: opts.serviceManagers ?? new Map<string, unknown>(),
      ...(opts.unprobed ? { unprobed: opts.unprobed } : {}),
    };
  }

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("composeProjectName", () => {
    it("is the 12-char-prefixed name the compose CLI passes as -p", () => {
      expect(composeProjectName(SID)).toBe("shipit-aaaaaaaa-bbb");
    });
  });

  describe("downComposeStackByProject", () => {
    it("stops and removes the project's containers and networks, never its volumes", async () => {
      const project = composeProjectName(SID);
      const h = fakeDocker({
        containers: [serviceContainer(SID, "c1"), serviceContainer(SID, "c2", "exited")],
        networks: [{ Id: "n1", Name: `shipit-session-${SID}`, Labels: { [COMPOSE_PROJECT_LABEL]: project } }],
      });

      expect(await downComposeStackByProject(h.docker, SID)).toBe(2);

      // Only the running one is stopped; both are removed.
      expect(h.stopped).toEqual(["c1"]);
      expect(h.removed).toEqual(["c1", "c2"]);
      expect(h.networksRemoved).toEqual(["n1"]);
      // A `light` session keeps its overlay volumes for a warm resume.
      expect(h.volumeCalls).toEqual([]);
    });

    it("leaves another session's stack alone", async () => {
      const h = fakeDocker({ containers: [serviceContainer(OTHER, "other-1")] });
      expect(await downComposeStackByProject(h.docker, SID)).toBe(0);
      expect(h.removed).toEqual([]);
    });

    it("treats 304 / 404 / 409 as the outcome it wanted", async () => {
      const h = fakeDocker({
        containers: [serviceContainer(SID, "gone"), serviceContainer(SID, "ok")],
        removeFails: { gone: 404 },
      });
      expect(await downComposeStackByProject(h.docker, SID)).toBe(1);
      expect(h.removed).toEqual(["ok"]);
    });

    it("THROWS when a container may still be running — the wipe must not proceed", async () => {
      const h = fakeDocker({
        containers: [serviceContainer(SID, "stuck")],
        removeFails: { stuck: 500 },
      });
      await expect(downComposeStackByProject(h.docker, SID)).rejects.toThrow(/could not remove stuck/);
    });

    it("THROWS when the listing fails, rather than reporting an empty stack", async () => {
      const h = fakeDocker({ containers: [serviceContainer(SID, "c1")], listContainersThrows: true });
      await expect(downComposeStackByProject(h.docker, SID)).rejects.toThrow(/daemon unreachable/);
    });
  });

  describe("reapSurvivingComposeStacks", () => {
    it("takes down a surviving stack whose session has no runner and no manager", async () => {
      const h = fakeDocker({ containers: [serviceContainer(SID, "c1")] });
      expect(await reapSurvivingComposeStacks(deps({ docker: h.docker }))).toBe(1);
      expect(h.removed).toEqual(["c1"]);
    });

    it("keeps a stack whose session has a live runner (its turn was adopted at boot)", async () => {
      const h = fakeDocker({ containers: [serviceContainer(SID, "c1")] });
      const reaped = await reapSurvivingComposeStacks(
        deps({ docker: h.docker, runners: { [SID]: {} } }),
      );
      expect(reaped).toBe(0);
      expect(h.removed).toEqual([]);
    });

    it("keeps a stack this process already owns (the warm pre-start's shape)", async () => {
      const h = fakeDocker({ containers: [serviceContainer(SID, "c1")] });
      const reaped = await reapSurvivingComposeStacks(
        deps({ docker: h.docker, serviceManagers: new Map([[SID, {}]]) }),
      );
      expect(reaped).toBe(0);
      expect(h.removed).toEqual([]);
    });

    it("keeps a stack whose session holds an always-on preview reservation", async () => {
      const h = fakeDocker({ containers: [serviceContainer(SID, "c1")] });
      const reaped = await reapSurvivingComposeStacks(
        deps({ docker: h.docker, sessions: { [SID]: session({ keepPreviewRunning: true }) } }),
      );
      expect(reaped).toBe(0);
      expect(h.removed).toEqual([]);
    });

    it("reaps a session whose reservation flag is stale on an archived row", async () => {
      const h = fakeDocker({ containers: [serviceContainer(SID, "c1")] });
      const reaped = await reapSurvivingComposeStacks(
        deps({
          docker: h.docker,
          sessions: { [SID]: session({ keepPreviewRunning: true, userArchived: true }) },
        }),
      );
      expect(reaped).toBe(1);
    });

    it("keeps a stack whose worker never answered the boot probe", async () => {
      const h = fakeDocker({ containers: [serviceContainer(SID, "c1")] });
      const reaped = await reapSurvivingComposeStacks(
        deps({ docker: h.docker, unprobed: new Set([SID]) }),
      );
      expect(reaped).toBe(0);
      expect(h.removed).toEqual([]);
    });

    it("leaves an untracked session's stack to the orphan sweep, which also owns its volumes", async () => {
      const h = fakeDocker({ containers: [serviceContainer(SID, "c1")] });
      const reaped = await reapSurvivingComposeStacks(deps({ docker: h.docker, sessions: {} }));
      expect(reaped).toBe(0);
      expect(h.removed).toEqual([]);
    });

    it("never touches an egress sidecar — it carries the parent label but no compose project", async () => {
      // docs/172 Tier B/C sidecars share the AGENT container's netns; reaping
      // them would leave a surviving agent container with no DNS and no HTTPS.
      const h = fakeDocker({
        containers: [{
          Id: "resolver",
          State: "running",
          Labels: { [PARENT_SESSION_LABEL]: SID, "shipit-egress-resolver": SID },
        }],
      });
      expect(await reapSurvivingComposeStacks(deps({ docker: h.docker }))).toBe(0);
      expect(h.removed).toEqual([]);
    });

    it("ignores a container whose two labels disagree about whose stack it is", async () => {
      // A repository's own compose file can set `shipit-parent-session`; Compose
      // merges label maps, so the generated override cannot un-declare it.
      const h = fakeDocker({
        containers: [{
          Id: "spoof",
          State: "running",
          Labels: {
            [PARENT_SESSION_LABEL]: SID,
            [COMPOSE_PROJECT_LABEL]: composeProjectName(OTHER),
          },
        }],
      });
      expect(await reapSurvivingComposeStacks(deps({ docker: h.docker }))).toBe(0);
      expect(h.removed).toEqual([]);
    });

    it("one stack it cannot take down does not stop the next", async () => {
      const h = fakeDocker({
        containers: [serviceContainer(SID, "stuck"), serviceContainer(OTHER, "fine")],
        removeFails: { stuck: 500 },
      });
      const reaped = await reapSurvivingComposeStacks(
        deps({ docker: h.docker, sessions: { [SID]: session(), [OTHER]: session({ id: OTHER }) } }),
      );
      expect(reaped).toBe(1);
      expect(h.removed).toEqual(["fine"]);
    });

    it("resolves rather than rejecting when Docker cannot be listed at all", async () => {
      const h = fakeDocker({ containers: [], listContainersThrows: true });
      await expect(reapSurvivingComposeStacks(deps({ docker: h.docker }))).resolves.toBe(0);
    });
  });
});
