import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import type Docker from "dockerode";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SessionContainerManager,
  CONTAINER_LABEL_KEY,
  CONTAINER_LABEL_VALUE,
  CONTAINER_SESSION_ID_LABEL,
  CONTAINER_STACK_LABEL,
  CONTAINER_STANDBY_LABEL,
} from "./session-container.js";
import { CLEANUP_CONTAINER_SESSION_ID, sessionContainerName } from "./shipit-own-sessions.js";
import { reapSurvivingComposeStacks, composeProjectName, COMPOSE_PROJECT_LABEL, PARENT_SESSION_LABEL } from "./compose-stack-reaper.js";
import type { SessionManager } from "./sessions.js";
import type { SessionRunnerRegistry } from "./session-runner.js";

const NETWORK = "shipit-shared-net";
const ALPHA = "alpha-stack";
const BETA = "beta-stack";

const ALPHA_SESSION = "11111111-1111-4111-8111-111111111111";
const BETA_SESSION = "22222222-2222-4222-8222-222222222222";

interface FakeContainer {
  Id: string;
  name: string;
  labels: Record<string, string>;
  running: boolean;
}

/**
 * One daemon for two stacks — the only shape these defects can fail on. Names
 * are global and unique here exactly as Docker makes them, and label filters
 * are honoured with Docker's AND semantics, so a sweep that forgets to scope
 * itself really does reach the other stack's containers.
 */
function fakeDaemon() {
  const containers = new Map<string, FakeContainer>();
  const networks: { Id: string; Labels: Record<string, string> }[] = [];
  const removed: string[] = [];
  let counter = 0;

  const matches = (labels: Record<string, string>, filters: string[]): boolean =>
    filters.every((f) => {
      const eq = f.indexOf("=");
      if (eq === -1) return f in labels;
      return labels[f.slice(0, eq)] === f.slice(eq + 1);
    });

  const find = (ref: string): FakeContainer | undefined =>
    containers.get(ref) ?? [...containers.values()].find((c) => c.name === ref);

  const add = (name: string, labels: Record<string, string>, running = true): string => {
    const Id = `container-${++counter}`;
    containers.set(Id, { Id, name, labels, running });
    return Id;
  };

  const docker = {
    ping: async () => "OK",
    getEvents: async () => new EventEmitter(),
    getImage: () => ({ inspect: async () => ({ Id: "sha256:img", Config: { Env: [] } }) }),
    createNetwork: async () => ({ id: "net" }),
    getNetwork: () => ({ inspect: async () => ({ Name: NETWORK }), remove: async () => {} }),
    listNetworks: async (opts?: { filters?: { label?: string[] } }) =>
      networks.filter((n) => matches(n.Labels, opts?.filters?.label ?? [])),
    listVolumes: async () => ({ Volumes: [] }),
    getVolume: () => ({
      inspect: async () => { const e: Error & { statusCode?: number } = new Error("no such volume"); e.statusCode = 404; throw e; },
      remove: async () => {},
    }),

    createContainer: async (opts: { name: string; Labels?: Record<string, string> }) => {
      if ([...containers.values()].some((c) => c.name === opts.name)) {
        const err: Error & { statusCode?: number } = new Error(`Conflict. The container name "/${opts.name}" is already in use`);
        err.statusCode = 409;
        throw err;
      }
      const id = add(opts.name, opts.Labels ?? {}, false);
      return {
        id,
        start: async () => { containers.get(id)!.running = true; },
        inspect: async () => inspectOf(id),
        stop: async () => { containers.get(id)!.running = false; },
        remove: async () => { removed.push(id); containers.delete(id); },
      };
    },

    getContainer: (ref: string) => ({
      inspect: async () => {
        const c = find(ref);
        if (!c) { const e: Error & { statusCode?: number } = new Error("no such container"); e.statusCode = 404; throw e; }
        return inspectOf(c.Id);
      },
      stop: async () => {
        const c = find(ref);
        if (!c) { const e: Error & { statusCode?: number } = new Error("no such container"); e.statusCode = 404; throw e; }
        c.running = false;
      },
      remove: async () => {
        const c = find(ref);
        if (!c) { const e: Error & { statusCode?: number } = new Error("no such container"); e.statusCode = 404; throw e; }
        removed.push(c.Id);
        containers.delete(c.Id);
      },
    }),

    listContainers: async (opts?: { filters?: { label?: string[] } }) =>
      [...containers.values()]
        .filter((c) => matches(c.labels, opts?.filters?.label ?? []))
        .map((c) => ({
          Id: c.Id,
          Names: [`/${c.name}`],
          Labels: c.labels,
          State: c.running ? "running" : "exited",
        })),
  };

  function inspectOf(id: string): unknown {
    const c = containers.get(id)!;
    return {
      Id: id,
      Name: `/${c.name}`,
      Config: { Env: [] },
      Mounts: [],
      State: { Running: c.running },
      NetworkSettings: { Networks: { [NETWORK]: { IPAddress: `172.30.0.${containers.size + 2}` } } },
    };
  }

  return {
    docker: docker as unknown as Docker,
    add,
    names: (): string[] => [...containers.values()].map((c) => c.name).sort(),
    liveIds: (): string[] => [...containers.keys()],
    removed,
  };
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "multi-stack-"));
afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

function managerFor(stackName: string, docker: Docker): SessionContainerManager {
  return new SessionContainerManager({
    docker,
    imageName: "shipit-session-worker:test",
    networkName: NETWORK,
    skipHealthCheck: true,
    stackName,
  });
}

function configFor(manager: SessionContainerManager, stackName: string, sessionId: string) {
  const sessionDir = path.join(ROOT, stackName, sessionId);
  const workspaceDir = path.join(sessionDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  return manager.buildConfig({
    sessionId,
    sessionDir,
    workspaceDir,
    credentialsDir: path.join(ROOT, stackName, "credentials"),
  });
}

function agentLabels(stackName: string, sessionId: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    [CONTAINER_LABEL_KEY]: CONTAINER_LABEL_VALUE,
    [CONTAINER_STACK_LABEL]: stackName,
    [CONTAINER_SESSION_ID_LABEL]: sessionId,
    ...extra,
  };
}

describe("two ShipIt stacks on one Docker daemon", () => {
  let daemon: ReturnType<typeof fakeDaemon>;
  let alpha: SessionContainerManager;
  let beta: SessionContainerManager;

  beforeEach(() => {
    daemon = fakeDaemon();
    alpha = managerFor(ALPHA, daemon.docker);
    beta = managerFor(BETA, daemon.docker);
  });

  afterEach(async () => {
    await alpha.dispose();
    await beta.dispose();
  });

  describe("the reserved session id", () => {
    it("names one container per stack, so neither create removes the other's", async () => {
      const betaContainer = await beta.create(
        configFor(beta, BETA, CLEANUP_CONTAINER_SESSION_ID),
      );
      const alphaContainer = await alpha.create(
        configFor(alpha, ALPHA, CLEANUP_CONTAINER_SESSION_ID),
      );

      expect(daemon.liveIds()).toContain(betaContainer.id);
      expect(daemon.liveIds()).toContain(alphaContainer.id);
      expect(daemon.names()).toEqual([
        sessionContainerName(CLEANUP_CONTAINER_SESSION_ID, ALPHA),
        sessionContainerName(CLEANUP_CONTAINER_SESSION_ID, BETA),
      ]);
    });

    it("keeps the unscoped name for an ordinary session, whose id is already unique", async () => {
      const sc = await alpha.create(configFor(alpha, ALPHA, ALPHA_SESSION));
      expect(sc.id).toBeTruthy();
      expect(daemon.names()).toEqual([`agent-${ALPHA_SESSION.slice(0, 12)}`]);
    });

    it("is not adopted across stacks, even on a shared network and a matching build", async () => {
      daemon.add(
        sessionContainerName(CLEANUP_CONTAINER_SESSION_ID, BETA),
        agentLabels(BETA, CLEANUP_CONTAINER_SESSION_ID),
      );

      const adopted = await alpha.adoptRunningContainer(
        CLEANUP_CONTAINER_SESSION_ID,
        () => ({ workspaceDir: path.join(ROOT, ALPHA, "ws"), dockerAccess: false }),
      );

      expect(adopted).toBe(false);
      expect(alpha.get(CLEANUP_CONTAINER_SESSION_ID)).toBeUndefined();
    });

    it("is adopted within the stack that owns it", async () => {
      daemon.add(
        sessionContainerName(CLEANUP_CONTAINER_SESSION_ID, ALPHA),
        agentLabels(ALPHA, CLEANUP_CONTAINER_SESSION_ID),
      );

      const adopted = await alpha.adoptRunningContainer(
        CLEANUP_CONTAINER_SESSION_ID,
        () => ({ workspaceDir: path.join(ROOT, ALPHA, "ws"), dockerAccess: false }),
      );

      expect(adopted).toBe(true);
    });

    it("teardown leaves the other stack's sidecars for the same reserved id", async () => {
      const mine = daemon.add("sidecar-alpha", {
        [CONTAINER_LABEL_KEY]: CONTAINER_LABEL_VALUE,
        [CONTAINER_STACK_LABEL]: ALPHA,
        [PARENT_SESSION_LABEL]: CLEANUP_CONTAINER_SESSION_ID,
      });
      const theirs = daemon.add("sidecar-beta", {
        [CONTAINER_LABEL_KEY]: CONTAINER_LABEL_VALUE,
        [CONTAINER_STACK_LABEL]: BETA,
        [PARENT_SESSION_LABEL]: CLEANUP_CONTAINER_SESSION_ID,
      });

      await alpha.reapOrphans(CLEANUP_CONTAINER_SESSION_ID);

      expect(daemon.removed).toEqual([mine]);
      expect(daemon.liveIds()).toContain(theirs);
    });
  });

  describe("sweeps that read \"absent from my active set\" as abandoned", () => {
    it("the standby reaper leaves the other stack's warm containers", async () => {
      const mine = daemon.add(
        `agent-${ALPHA_SESSION.slice(0, 12)}`,
        agentLabels(ALPHA, ALPHA_SESSION, { [CONTAINER_STANDBY_LABEL]: "true" }),
      );
      const theirs = daemon.add(
        `agent-${BETA_SESSION.slice(0, 12)}`,
        agentLabels(BETA, BETA_SESSION, { [CONTAINER_STANDBY_LABEL]: "true" }),
      );

      const reaped = await alpha.reapStandbyContainers(new Set<string>());

      expect(reaped).toBe(1);
      expect(daemon.removed).toEqual([mine]);
      expect(daemon.liveIds()).toContain(theirs);
    });

    it("the compose orphan sweep leaves the other stack's service containers", async () => {
      const mine = daemon.add("shipit-alpha-web-1", {
        [CONTAINER_STACK_LABEL]: ALPHA,
        [PARENT_SESSION_LABEL]: ALPHA_SESSION,
      });
      const theirs = daemon.add("shipit-beta-web-1", {
        [CONTAINER_STACK_LABEL]: BETA,
        [PARENT_SESSION_LABEL]: BETA_SESSION,
      });

      const reaped = await alpha.cleanupOrphanComposeResources(new Set<string>());

      expect(reaped).toBe(1);
      expect(daemon.removed).toEqual([mine]);
      expect(daemon.liveIds()).toContain(theirs);
    });

    it("the surviving-compose-stack reaper leaves the other stack's projects", async () => {
      const mine = daemon.add("shipit-alpha-web-1", {
        [CONTAINER_STACK_LABEL]: ALPHA,
        [PARENT_SESSION_LABEL]: ALPHA_SESSION,
        [COMPOSE_PROJECT_LABEL]: composeProjectName(ALPHA_SESSION),
      });
      const theirs = daemon.add("shipit-beta-web-1", {
        [CONTAINER_STACK_LABEL]: BETA,
        [PARENT_SESSION_LABEL]: BETA_SESSION,
        [COMPOSE_PROJECT_LABEL]: composeProjectName(BETA_SESSION),
      });

      const reaped = await reapSurvivingComposeStacks({
        docker: daemon.docker as never,
        stackName: ALPHA,
        // Both sessions are tracked, so only the stack filter can separate them.
        sessionManager: {
          get: (id: string) => ({ id, userArchived: false }),
        } as unknown as SessionManager,
        runnerRegistry: { get: () => undefined } as unknown as SessionRunnerRegistry,
        serviceManagers: new Map<string, unknown>(),
      });

      expect(reaped).toBe(1);
      expect(daemon.removed).toEqual([mine]);
      expect(daemon.liveIds()).toContain(theirs);
    });
  });
});
