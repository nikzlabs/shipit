/**
 * Unit tests for SessionContainerManager.
 *
 * Uses a mocked Docker client to test container lifecycle, network setup,
 * orphan cleanup, and health monitoring without a real Docker daemon.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  SessionContainerManager,
  CONTAINER_LABEL_KEY,
  CONTAINER_LABEL_VALUE,
  CONTAINER_SESSION_ID_LABEL,
  CONTAINER_STACK_LABEL,
} from "./session-container.js";
import type { ContainerConfig } from "./session-container.js";

// ---------------------------------------------------------------------------
// Mock Docker types
// ---------------------------------------------------------------------------

interface MockContainerInfo {
  id: string;
  NetworkSettings: {
    Networks: Record<string, { IPAddress: string }>;
  };
}

function createMockDocker() {
  const containers = new Map<string, {
    id: string;
    started: boolean;
    removed: boolean;
    labels: Record<string, string>;
    inspectResult: MockContainerInfo;
  }>();

  let containerCounter = 0;
  let networkExists = false;
  let pingResult = true;

  const eventEmitter = new EventEmitter();

  const mockDocker = {
    // Control
    _setPingResult: (v: boolean) => { pingResult = v; },
    _setNetworkExists: (v: boolean) => { networkExists = v; },
    _containers: containers,
    _eventEmitter: eventEmitter,

    ping: vi.fn(async () => {
      if (!pingResult) throw new Error("Cannot connect to Docker daemon");
      return "OK";
    }),

    createNetwork: vi.fn(async () => {
      networkExists = true;
      return { id: "net-1" };
    }),

    getNetwork: vi.fn(() => ({
      inspect: vi.fn(async () => {
        if (!networkExists) throw new Error("network not found");
        return { Name: "shipit-test" };
      }),
    })),

    createContainer: vi.fn(async (opts: any) => {
      containerCounter++;
      const id = `container-${containerCounter}`;
      const info: MockContainerInfo = {
        id,
        NetworkSettings: {
          Networks: {
            "shipit-test": { IPAddress: `172.18.0.${containerCounter + 2}` },
          },
        },
      };
      containers.set(id, {
        id,
        started: false,
        removed: false,
        labels: opts.Labels ?? {},
        inspectResult: info,
      });
      return {
        id,
        start: vi.fn(async () => {
          const c = containers.get(id);
          if (c) c.started = true;
        }),
        inspect: vi.fn(async () => info),
        stop: vi.fn(async () => {
          const c = containers.get(id);
          if (c) c.started = false;
        }),
        remove: vi.fn(async () => {
          const c = containers.get(id);
          if (c) c.removed = true;
        }),
      };
    }),

    getContainer: vi.fn((id: string) => {
      const c = containers.get(id);
      return {
        stop: vi.fn(async () => {
          if (c) c.started = false;
        }),
        remove: vi.fn(async () => {
          if (c) c.removed = true;
        }),
        inspect: vi.fn(async () => c?.inspectResult ?? {}),
      };
    }),

    listContainers: vi.fn(async () => {
      return [...containers.values()]
        .filter((c) => !c.removed)
        .map((c) => ({
          Id: c.id,
          Labels: c.labels,
          State: c.started ? "running" : "exited",
        }));
    }),

    getEvents: vi.fn(async () => eventEmitter),
  };

  return mockDocker;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildConfig(overrides?: Partial<ContainerConfig>): ContainerConfig {
  return {
    sessionId: "test-session-1",
    sessionDir: "/workspace/sessions/test-session-1",
    credentialsDir: "/credentials",
    imageName: "shipit-session-worker:test",
    memoryLimit: 512 * 1024 * 1024,
    cpuQuota: 50_000,
    pidsLimit: 256,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionContainerManager", () => {
  let mockDocker: ReturnType<typeof createMockDocker>;
  let manager: SessionContainerManager;

  beforeEach(() => {
    mockDocker = createMockDocker();
    manager = new SessionContainerManager({
      docker: mockDocker as any,
      imageName: "shipit-session-worker:test",
      networkName: "shipit-test",
      skipHealthCheck: true,
      stackName: "shipit-test",
    });
  });

  afterEach(async () => {
    await manager.dispose();
  });

  // --- isAvailable ---

  describe("isAvailable", () => {
    it("returns true when Docker daemon responds", async () => {
      expect(await manager.isAvailable()).toBe(true);
      expect(mockDocker.ping).toHaveBeenCalled();
    });

    it("returns false when Docker daemon is unreachable", async () => {
      mockDocker._setPingResult(false);
      expect(await manager.isAvailable()).toBe(false);
    });
  });

  // --- ensureNetwork ---

  describe("ensureNetwork", () => {
    it("creates the network if it does not exist", async () => {
      await manager.ensureNetwork();
      expect(mockDocker.createNetwork).toHaveBeenCalledWith(
        expect.objectContaining({
          Name: "shipit-test",
          Driver: "bridge",
        }),
      );
    });

    it("does not create the network if it already exists", async () => {
      mockDocker._setNetworkExists(true);
      await manager.ensureNetwork();
      expect(mockDocker.createNetwork).not.toHaveBeenCalled();
    });
  });

  // --- create ---

  describe("create", () => {
    it("creates and starts a container with correct config", async () => {
      const config = buildConfig();
      const sc = await manager.create(config);

      expect(sc.sessionId).toBe("test-session-1");
      expect(sc.containerIp).toMatch(/^172\.18\.0\.\d+$/);
      expect(sc.workerUrl).toBe(`http://${sc.containerIp}:9100`);
      expect(sc.status).toBe("running");
      expect(sc.id).toMatch(/^container-\d+$/);

      // Verify docker.createContainer was called with the right options
      expect(mockDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Image: "shipit-session-worker:test",
          Cmd: ["node", "--import", "tsx", "src/server/session/session-worker.ts"],
          Labels: {
            [CONTAINER_LABEL_KEY]: CONTAINER_LABEL_VALUE,
            [CONTAINER_STACK_LABEL]: "shipit-test",
            [CONTAINER_SESSION_ID_LABEL]: "test-session-1",
          },
          HostConfig: expect.objectContaining({
            Binds: expect.arrayContaining([
              "/workspace/sessions/test-session-1:/user:rw",
              "/credentials:/credentials:rw",
            ]),
            Memory: 512 * 1024 * 1024,
            CpuQuota: 50_000,
            CpuPeriod: 100_000,
            PidsLimit: 256,
            NetworkMode: "shipit-test",
            SecurityOpt: ["no-new-privileges"],
          }),
        }),
      );
    });

    it("includes shared repo mount for worktree sessions", async () => {
      const config = buildConfig({
        sharedRepoDir: "/workspace/repos/abc123",
      });
      await manager.create(config);

      expect(mockDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          HostConfig: expect.objectContaining({
            Binds: expect.arrayContaining([
              "/workspace/repos/abc123:/repo:ro",
            ]),
          }),
        }),
      );
    });

    it("passes environment variables", async () => {
      const config = buildConfig({
        env: { GITHUB_TOKEN: "ghp_test123", GIT_AUTHOR_NAME: "Test" },
      });
      await manager.create(config);

      expect(mockDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Env: expect.arrayContaining([
            "GITHUB_TOKEN=ghp_test123",
            "GIT_AUTHOR_NAME=Test",
            "SESSION_ID=test-session-1",
            "WORKSPACE_DIR=/user",
          ]),
        }),
      );
    });

    it("throws when a container already exists for the session", async () => {
      await manager.create(buildConfig());
      await expect(manager.create(buildConfig())).rejects.toThrow(
        "Container already exists for session test-session-1",
      );
    });

    it("emits container_started event", async () => {
      const started = vi.fn();
      manager.on("container_started", started);

      await manager.create(buildConfig());

      expect(started).toHaveBeenCalledWith("test-session-1");
    });

    it("cleans up on creation failure", async () => {
      mockDocker.createContainer.mockRejectedValueOnce(new Error("image not found"));

      await expect(manager.create(buildConfig())).rejects.toThrow("image not found");
      expect(manager.get("test-session-1")).toBeUndefined();
      expect(manager.size).toBe(0);
    });
  });

  // --- get / getAll / size ---

  describe("get / getAll / size", () => {
    it("tracks containers by session ID", async () => {
      const sc1 = await manager.create(buildConfig({ sessionId: "s1", sessionDir: "/ws/s1" }));
      const sc2 = await manager.create(buildConfig({ sessionId: "s2", sessionDir: "/ws/s2" }));

      expect(manager.get("s1")).toBe(sc1);
      expect(manager.get("s2")).toBe(sc2);
      expect(manager.get("nonexistent")).toBeUndefined();
      expect(manager.getAll()).toHaveLength(2);
      expect(manager.size).toBe(2);
    });
  });

  // --- destroy ---

  describe("destroy", () => {
    it("stops and removes the container", async () => {
      await manager.create(buildConfig());
      expect(manager.size).toBe(1);

      await manager.destroy("test-session-1");

      expect(manager.size).toBe(0);
      expect(manager.get("test-session-1")).toBeUndefined();
    });

    it("emits container_destroyed event", async () => {
      const destroyed = vi.fn();
      manager.on("container_destroyed", destroyed);

      await manager.create(buildConfig());
      await manager.destroy("test-session-1");

      expect(destroyed).toHaveBeenCalledWith("test-session-1");
    });

    it("is a no-op for unknown session IDs", async () => {
      await manager.destroy("nonexistent"); // should not throw
    });
  });

  // --- destroyAll ---

  describe("destroyAll", () => {
    it("destroys all containers", async () => {
      await manager.create(buildConfig({ sessionId: "s1", sessionDir: "/ws/s1" }));
      await manager.create(buildConfig({ sessionId: "s2", sessionDir: "/ws/s2" }));
      expect(manager.size).toBe(2);

      await manager.destroyAll();

      expect(manager.size).toBe(0);
    });
  });

  // --- cleanupOrphans ---

  describe("cleanupOrphans", () => {
    it("removes containers not in the active set", async () => {
      // Manually create container entries in mock Docker (simulating leftovers)
      await manager.create(buildConfig({ sessionId: "active-1", sessionDir: "/ws/a1" }));
      await manager.create(buildConfig({ sessionId: "orphan-1", sessionDir: "/ws/o1" }));

      // The manager's internal map tracks both, but cleanupOrphans checks
      // docker.listContainers for ALL shipit containers vs active set.
      const removed = await manager.cleanupOrphans(new Set(["active-1"]));

      // orphan-1 should be removed
      expect(removed).toBe(1);
    });

    it("returns 0 when all containers are active", async () => {
      await manager.create(buildConfig({ sessionId: "s1", sessionDir: "/ws/s1" }));
      const removed = await manager.cleanupOrphans(new Set(["s1"]));
      expect(removed).toBe(0);
    });
  });

  // --- buildConfig ---

  describe("buildConfig", () => {
    it("applies defaults from manager options", () => {
      const config = manager.buildConfig({
        sessionId: "s1",
        sessionDir: "/ws/s1",
        credentialsDir: "/creds",
      });

      expect(config.imageName).toBe("shipit-session-worker:test");
      expect(config.memoryLimit).toBe(512 * 1024 * 1024);
      expect(config.cpuQuota).toBe(50_000);
      expect(config.pidsLimit).toBe(256);
    });

    it("allows overriding defaults", () => {
      const config = manager.buildConfig({
        sessionId: "s1",
        sessionDir: "/ws/s1",
        credentialsDir: "/creds",
        memoryLimit: 1024 * 1024 * 1024,
        cpuQuota: 100_000,
        pidsLimit: 512,
      });

      expect(config.memoryLimit).toBe(1024 * 1024 * 1024);
      expect(config.cpuQuota).toBe(100_000);
      expect(config.pidsLimit).toBe(512);
    });

    it("includes shared repo dir when provided", () => {
      const config = manager.buildConfig({
        sessionId: "s1",
        sessionDir: "/ws/s1",
        credentialsDir: "/creds",
        sharedRepoDir: "/repos/abc",
      });

      expect(config.sharedRepoDir).toBe("/repos/abc");
    });
  });

  // --- Health monitoring ---

  describe("health monitoring", () => {
    it("emits container_exited when a container dies", async () => {
      await manager.create(buildConfig());
      await manager.startHealthMonitor();

      const exited = vi.fn();
      manager.on("container_exited", exited);

      // Simulate a Docker "die" event
      mockDocker._eventEmitter.emit("data", Buffer.from(JSON.stringify({
        Action: "die",
        Actor: {
          Attributes: {
            [CONTAINER_SESSION_ID_LABEL]: "test-session-1",
            exitCode: "137",
          },
        },
      })));

      expect(exited).toHaveBeenCalledWith("test-session-1", 137, undefined);
      expect(manager.get("test-session-1")).toBeUndefined();
    });

    it("emits container_exited with OOM error on oom event", async () => {
      await manager.create(buildConfig());
      await manager.startHealthMonitor();

      const exited = vi.fn();
      manager.on("container_exited", exited);

      mockDocker._eventEmitter.emit("data", Buffer.from(JSON.stringify({
        Action: "oom",
        Actor: {
          Attributes: {
            [CONTAINER_SESSION_ID_LABEL]: "test-session-1",
            exitCode: "137",
          },
        },
      })));

      expect(exited).toHaveBeenCalledWith("test-session-1", 137, "Out of memory");
    });

    it("ignores events for unknown sessions", async () => {
      await manager.startHealthMonitor();

      const exited = vi.fn();
      manager.on("container_exited", exited);

      mockDocker._eventEmitter.emit("data", Buffer.from(JSON.stringify({
        Action: "die",
        Actor: {
          Attributes: {
            [CONTAINER_SESSION_ID_LABEL]: "unknown-session",
          },
        },
      })));

      expect(exited).not.toHaveBeenCalled();
    });

    it("ignores malformed events", async () => {
      await manager.startHealthMonitor();

      const exited = vi.fn();
      manager.on("container_exited", exited);

      mockDocker._eventEmitter.emit("data", Buffer.from("not json"));

      expect(exited).not.toHaveBeenCalled();
    });

    it("stopHealthMonitor cleans up the event stream", async () => {
      await manager.startHealthMonitor();
      manager.stopHealthMonitor();

      // Should not throw when stopping again
      manager.stopHealthMonitor();
    });
  });

  // --- dispose ---

  describe("dispose", () => {
    it("destroys all containers and stops health monitor", async () => {
      await manager.create(buildConfig({ sessionId: "s1", sessionDir: "/ws/s1" }));
      await manager.create(buildConfig({ sessionId: "s2", sessionDir: "/ws/s2" }));
      await manager.startHealthMonitor();

      await manager.dispose();

      expect(manager.size).toBe(0);
    });

    it("is idempotent", async () => {
      await manager.dispose();
      await manager.dispose(); // should not throw
    });
  });
});
