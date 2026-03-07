/**
 * Integration tests for dual-container lifecycle (session + preview).
 *
 * Tests that SessionContainerManager.create() spawns both containers,
 * populates preview fields, and that destroy() tears down both.
 * Uses a mocked Docker client (same pattern as session-container.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SessionContainerManager,
  CONTAINER_SESSION_ID_LABEL,
  PREVIEW_CONTAINER_LABEL,
} from "../session-container.js";
import type { ContainerConfig } from "../session-container.js";

// ---------------------------------------------------------------------------
// Mock Docker
// ---------------------------------------------------------------------------

interface MockContainerInfo {
  id: string;
  NetworkSettings: {
    Networks: Record<string, { IPAddress: string }>;
  };
}

function createMockDocker(networkName: string) {
  const containers = new Map<string, {
    id: string;
    started: boolean;
    removed: boolean;
    stopped: boolean;
    labels: Record<string, string>;
    inspectResult: MockContainerInfo;
  }>();

  let containerCounter = 0;

  const mockDocker = {
    _containers: containers,

    ping: async () => "OK",

    createContainer: async (opts: any) => {
      const id = `container-${++containerCounter}`;
      const ip = `172.18.0.${containerCounter + 2}`;
      const info: MockContainerInfo = {
        id,
        NetworkSettings: {
          Networks: { [networkName]: { IPAddress: ip } },
        },
      };
      containers.set(id, {
        id,
        started: false,
        removed: false,
        stopped: false,
        labels: opts.Labels ?? {},
        inspectResult: info,
      });
      return {
        id,
        start: async () => { containers.get(id)!.started = true; },
        inspect: async () => info,
        stop: async () => { containers.get(id)!.stopped = true; },
        remove: async () => { containers.get(id)!.removed = true; },
      };
    },

    getContainer: (id: string) => ({
      id,
      stop: async () => { const c = containers.get(id); if (c) c.stopped = true; },
      remove: async () => { const c = containers.get(id); if (c) c.removed = true; },
    }),

    listContainers: async (opts: any) => {
      const labelFilters: string[] = opts?.filters?.label ?? [];
      return [...containers.values()]
        .filter((c) => !c.removed)
        .filter((c) =>
          labelFilters.every((f: string) => {
            const [key, value] = f.split("=");
            return c.labels[key] === value;
          }),
        )
        .map((c) => ({
          Id: c.id,
          State: c.started ? "running" : "created",
          Labels: c.labels,
        }));
    },

    listNetworks: async () => [],
    listVolumes: async () => ({ Volumes: [] }),

    getNetwork: () => ({
      inspect: async () => ({}),
      remove: async () => {},
    }),

    createNetwork: async () => ({}),
  };

  return mockDocker;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: Dual-container lifecycle", () => {
  const networkName = "shipit-test";
  let manager: SessionContainerManager;
  let mockDocker: ReturnType<typeof createMockDocker>;

  const baseConfig: ContainerConfig = {
    sessionId: "test-session-1",
    sessionDir: "/workspace/sessions/test-session-1",
    credentialsDir: "/credentials",
    imageName: "shipit-worker:test",
    memoryLimit: 256 * 1024 * 1024,
    cpuQuota: 50_000,
    pidsLimit: 256,
  };

  beforeEach(() => {
    mockDocker = createMockDocker(networkName);
    manager = new SessionContainerManager({
      docker: mockDocker as any,
      imageName: "shipit-worker:test",
      networkName,
      skipHealthCheck: true,
    });
  });

  afterEach(async () => {
    await manager.dispose();
  });

  it("create() spawns both session and preview containers", async () => {
    const sc = await manager.create(baseConfig);

    // Session container fields
    expect(sc.id).toBeTruthy();
    expect(sc.containerIp).toBeTruthy();
    expect(sc.workerUrl).toContain(sc.containerIp);
    expect(sc.status).toBe("running");

    // Preview container fields
    expect(sc.previewContainerId).toBeTruthy();
    expect(sc.previewContainerIp).toBeTruthy();
    expect(sc.previewWorkerUrl).toContain(sc.previewContainerIp);

    // Different IPs
    expect(sc.containerIp).not.toBe(sc.previewContainerIp);

    // Two containers created in Docker
    expect(mockDocker._containers.size).toBe(2);
  });

  it("preview container has shipit-preview-for label", async () => {
    const sc = await manager.create(baseConfig);

    const previewContainer = mockDocker._containers.get(sc.previewContainerId!);
    expect(previewContainer).toBeDefined();
    expect(previewContainer!.labels[PREVIEW_CONTAINER_LABEL]).toBe(baseConfig.sessionId);
    expect(previewContainer!.labels["shipit-parent-session"]).toBe(baseConfig.sessionId);
  });

  it("session container has session ID label", async () => {
    const sc = await manager.create(baseConfig);

    const sessionContainer = mockDocker._containers.get(sc.id);
    expect(sessionContainer).toBeDefined();
    expect(sessionContainer!.labels[CONTAINER_SESSION_ID_LABEL]).toBe(baseConfig.sessionId);
  });

  it("destroy() tears down both containers", async () => {
    const sc = await manager.create(baseConfig);
    const sessionId = sc.id;
    const previewId = sc.previewContainerId!;

    await manager.destroy(baseConfig.sessionId);

    // Session container removed (through destroyContainer)
    const sessionC = mockDocker._containers.get(sessionId);
    expect(sessionC!.stopped).toBe(true);
    expect(sessionC!.removed).toBe(true);

    // Preview container removed (through cleanupSessionDockerResources)
    const previewC = mockDocker._containers.get(previewId);
    expect(previewC!.removed).toBe(true);
  });

  it("get() returns container with preview fields populated", async () => {
    await manager.create(baseConfig);

    const sc = manager.get(baseConfig.sessionId);
    expect(sc).toBeDefined();
    expect(sc!.previewContainerId).toBeTruthy();
    expect(sc!.previewContainerIp).toBeTruthy();
    expect(sc!.previewWorkerUrl).toBeTruthy();
  });

  it("manager size reflects session count, not container count", async () => {
    expect(manager.size).toBe(0);
    await manager.create(baseConfig);
    expect(manager.size).toBe(1); // 1 session, 2 Docker containers
  });
});
