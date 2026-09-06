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
import { serializeStackOp } from "./stack-op-queue.js";

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

  /**
   * A STATEFUL fake: a removed container leaves the daemon's view, so the
   * teardown's verifying re-listing sees what actually happened rather than the
   * snapshot it started from. A fake that returned a frozen list could not tell
   * a completed teardown from an abandoned one — which is the whole property
   * under test.
   *
   * Every call lands in one ordered `calls` array, so ordering claims
   * (containers before networks; the stop that must still be followed by a
   * remove) are observable rather than inferred from separate buckets.
   */
  function fakeDocker(opts: {
    containers?: FakeContainer[];
    networks?: FakeNetwork[];
    /** Container ids whose `stop` rejects, with the given statusCode. */
    stopFails?: Record<string, number>;
    /** Container ids whose `remove` rejects, with the given statusCode. */
    removeFails?: Record<string, number>;
    /**
     * Ids whose `remove` REJECTS but which vanish anyway — Docker's `409
     * removal already in progress`, where another actor finishes the job.
     */
    removeEventuallySucceeds?: Set<string>;
    listContainersThrows?: boolean;
  }) {
    const calls: string[] = [];
    const live = new Map((opts.containers ?? []).map((c) => [c.Id, c]));
    const networks = opts.networks ?? [];
    const fail = (id: string, code: number, what: string): never => {
      const err = new Error(`${what} refused for ${id}`) as Error & { statusCode: number };
      err.statusCode = code;
      throw err;
    };

    const docker = {
      listContainers: vi.fn(async (o: { filters: { label: string[] } }) => {
        calls.push(`list:${o.filters.label.join("+")}`);
        if (opts.listContainersThrows) throw new Error("daemon unreachable");
        return [...live.values()].filter((c) => matchesLabelFilter(c.Labels, o.filters.label));
      }),
      getContainer: (id: string) => ({
        stop: async () => {
          calls.push(`stop:${id}`);
          const code = opts.stopFails?.[id];
          if (code !== undefined) fail(id, code, "stop");
        },
        remove: async (o?: unknown) => {
          calls.push(`remove:${id}:${JSON.stringify(o)}`);
          const code = opts.removeFails?.[id];
          if (code !== undefined) {
            if (opts.removeEventuallySucceeds?.has(id)) live.delete(id);
            fail(id, code, "remove");
          }
          live.delete(id);
        },
      }),
      listNetworks: vi.fn(async (o: { filters: { label: string[] } }) => {
        calls.push("listNetworks");
        return networks.filter((n) => matchesLabelFilter(n.Labels, o.filters.label));
      }),
      getNetwork: (id: string) => ({
        remove: async () => { calls.push(`removeNetwork:${id}`); },
      }),
      // Present so a teardown that ever reached for volumes would be VISIBLE
      // rather than silently absent — a `light` session's docs/183 overlay must
      // survive the teardown.
      listVolumes: vi.fn(async () => { calls.push("listVolumes"); return { Volumes: [] }; }),
      getVolume: (name: string) => ({ remove: async () => { calls.push(`removeVolume:${name}`); } }),
    };
    const only = (prefix: string): string[] =>
      calls.filter((c) => c.startsWith(`${prefix}:`)).map((c) => c.split(":")[1]);
    return {
      docker: docker as unknown as Docker,
      calls,
      live,
      get stopped() { return only("stop"); },
      get removed() { return only("remove"); },
      get networksRemoved() { return only("removeNetwork"); },
      get volumeCalls() { return calls.filter((c) => c.includes("olume")); },
    };
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
      // A `light` session keeps its docs/183 overlay volumes for a warm resume,
      // so the teardown must never reach for a volume — including via a
      // `remove({ v: true })` on a container, which would take its anonymous
      // volumes with it.
      expect(h.volumeCalls).toEqual([]);
      expect(h.calls.filter((c) => c.startsWith("remove:"))).toEqual([
        'remove:c1:{"force":true}',
        'remove:c2:{"force":true}',
      ]);
      // Containers before networks — a network with an attached container
      // cannot be removed, and the failure would look like "already gone".
      expect(h.calls.indexOf("removeNetwork:n1")).toBeGreaterThan(
        h.calls.findIndex((c) => c.startsWith("remove:c2")),
      );
    });

    it("leaves another session's stack alone", async () => {
      const h = fakeDocker({ containers: [serviceContainer(OTHER, "other-1")] });
      expect(await downComposeStackByProject(h.docker, SID)).toBe(0);
      expect(h.removed).toEqual([]);
    });

    it("treats a 404 from remove as the outcome it wanted", async () => {
      const h = fakeDocker({
        containers: [serviceContainer(SID, "gone"), serviceContainer(SID, "ok")],
        removeFails: { gone: 404 },
        removeEventuallySucceeds: new Set(["gone"]),
      });
      expect(await downComposeStackByProject(h.docker, SID)).toBe(1);
      expect(h.removed).toEqual(["gone", "ok"]);
    });

    // Review finding. `stop` and `remove` shared one `try`, so a container
    // someone else stopped between the listing and our stop answered `304
    // Not Modified`, execution jumped past `remove()`, and the teardown
    // reported success with the container still there — and `light → evicted`
    // then wiped the workspace on the strength of it.
    it("still removes a container whose stop answered 304 Not Modified", async () => {
      const h = fakeDocker({
        containers: [serviceContainer(SID, "already-stopped")],
        stopFails: { "already-stopped": 304 },
      });
      expect(await downComposeStackByProject(h.docker, SID)).toBe(1);
      expect(h.removed).toEqual(["already-stopped"]);
      expect(h.live.size).toBe(0);
    });

    // `409` from a FORCED remove means removal is already in progress — not
    // that it finished. The verifying re-listing is what decides.
    it("accepts a 409 whose removal really did land", async () => {
      const h = fakeDocker({
        containers: [serviceContainer(SID, "racing")],
        removeFails: { racing: 409 },
        removeEventuallySucceeds: new Set(["racing"]),
      });
      await expect(downComposeStackByProject(h.docker, SID)).resolves.toBe(0);
    });

    it("THROWS on a 409 whose removal never landed — the wipe must not proceed", async () => {
      const h = fakeDocker({
        containers: [serviceContainer(SID, "racing")],
        removeFails: { racing: 409 },
      });
      await expect(downComposeStackByProject(h.docker, SID)).rejects.toThrow(/left 1 container/);
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

    // Review finding. `reattachInFlightTurns` keeps a worker for a self-woken
    // turn, an outstanding background task, a running `agent.install` or a live
    // terminal WITHOUT creating a runner — and a current-build worker returns
    // even earlier. Its agent container is on the session's compose network, so
    // it can be driving those services by DNS right now.
    it("keeps a stack the boot adoption sweep held for live work it did not adopt", async () => {
      const h = fakeDocker({ containers: [serviceContainer(SID, "c1")] });
      const reaped = await reapSurvivingComposeStacks({
        ...deps({ docker: h.docker }),
        liveWork: new Set([SID]),
      });
      expect(reaped).toBe(0);
      expect(h.removed).toEqual([]);
    });

    // Review finding: the hold was re-checked BEFORE the Docker calls, so an
    // activation landing in between published its manager, ran its own
    // `compose up`, and had the brand-new containers listed and removed. Both
    // halves of the fix are under test here — the teardown is on the session's
    // stack queue (where every other compose invocation for a session already
    // is), and the hold is re-checked INSIDE that critical section.
    it("keeps a stack when an activation takes the session's stack queue first", async () => {
      const serviceManagers = new Map<string, unknown>();
      const h = fakeDocker({ containers: [serviceContainer(SID, "c1")] });
      // Model an activation already in flight: `setupServiceManager` publishes
      // its manager and does its `compose up` through this same queue. The hold
      // is NOT visible when the sweep first looks at this session.
      const activation = serializeStackOp(SID, async () => {
        await new Promise((resolve) => { setTimeout(resolve, 5); });
        serviceManagers.set(SID, {});
      });

      const reaped = await reapSurvivingComposeStacks(deps({ docker: h.docker, serviceManagers }));
      await activation;

      expect(reaped).toBe(0);
      expect(h.removed).toEqual([]);
    });

    // The other ordering: the sweep wins the queue, so it tears the old stack
    // down and the activation's own `killStaleContainers` + `compose up` builds
    // a fresh one behind it. Both orderings are safe; neither interleaves.
    it("takes the stack down when it wins the queue, and lets the activation follow", async () => {
      const serviceManagers = new Map<string, unknown>();
      const h = fakeDocker({ containers: [serviceContainer(SID, "c1")] });

      const reaped = await reapSurvivingComposeStacks(deps({ docker: h.docker, serviceManagers }));
      let ranAfter = false;
      await serializeStackOp(SID, async () => { ranAfter = true; });

      expect(reaped).toBe(1);
      expect(h.removed).toEqual(["c1"]);
      expect(ranAfter).toBe(true);
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
      // What actually vanished, not what was attempted: the stuck stack is
      // still standing and the next boot retries it.
      expect(h.live.has("stuck")).toBe(true);
      expect(h.live.has("fine")).toBe(false);
    });

    it("resolves rather than rejecting when Docker cannot be listed at all", async () => {
      const h = fakeDocker({ containers: [], listContainersThrows: true });
      await expect(reapSurvivingComposeStacks(deps({ docker: h.docker }))).resolves.toBe(0);
    });
  });
});
