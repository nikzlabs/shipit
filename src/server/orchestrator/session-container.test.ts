import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SessionContainerManager,
  CONTAINER_LABEL_KEY,
  CONTAINER_LABEL_VALUE,
  CONTAINER_SESSION_ID_LABEL,
  CONTAINER_STACK_LABEL,
  readAgentConfig,
} from "./session-container.js";
import type { ContainerConfig } from "./session-container.js";
import { allowEgressHost, clearEgressPolicy } from "./egress-policy.js";
import { TEST_CREDENTIALS_DIR } from "./credentials-test-helpers.js";
import { expectInvalidShipitConfig } from "../shared/shipit-config-test-guard.js";

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
  let imageId: string | undefined = "sha256:workerimageabc";
  let imageBaseDigest: string | undefined = "sha256:baseimagexyz";
  let imageInspectCalls = 0;

  const liveVolumes = new Set<string>();
  const removedVolumes: string[] = [];
  const missingVolumes = new Set<string>();
  const volumeSpecs = new Map<string, { Options?: Record<string, string>; Labels?: Record<string, string> }>();
  const volumeHolders = new Map<string, string[]>();

  const eventEmitter = new EventEmitter();

  const mockDocker = {
    _setPingResult: (v: boolean) => { pingResult = v; },
    _setNetworkExists: (v: boolean) => { networkExists = v; },
    _setImageId: (v: string | undefined) => { imageId = v; },
    _setImageBaseDigest: (v: string | undefined) => { imageBaseDigest = v; },
    _imageInspectCalls: () => imageInspectCalls,
    _containers: containers,
    _eventEmitter: eventEmitter,
    _liveVolumes: liveVolumes,
    _removedVolumes: removedVolumes,
    _missingVolumes: missingVolumes,
    _volumeHolders: volumeHolders,

    _volumeSpecs: volumeSpecs,

    createVolume: vi.fn(async (opts: any) => {
      liveVolumes.add(opts.Name);
      if (!volumeSpecs.has(opts.Name)) {
        volumeSpecs.set(opts.Name, { Options: opts.DriverOpts, Labels: opts.Labels });
      }
      return { Name: opts.Name };
    }),
    getVolume: vi.fn((name: string) => ({
      inspect: vi.fn(async () => {
        const uncreatedOverlay = name.includes("_overlay") && !liveVolumes.has(name);
        if (missingVolumes.has(name) || uncreatedOverlay) {
          const err: any = new Error("no such volume"); err.statusCode = 404; throw err;
        }
        return {
          Name: name,
          Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
          ...(volumeSpecs.get(name) ?? {}),
        };
      }),
      remove: vi.fn(async () => {
        if (!liveVolumes.has(name)) {
          const err: any = new Error("no such volume"); err.statusCode = 404; throw err;
        }
        if ((volumeHolders.get(name) ?? []).length > 0) {
          const err: any = new Error("conflict - volume is in use"); err.statusCode = 409; throw err;
        }
        liveVolumes.delete(name);
        volumeSpecs.delete(name);
        removedVolumes.push(name);
      }),
    })),

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
          for (const [vol, ids] of volumeHolders) {
            volumeHolders.set(vol, ids.filter((held) => held !== id));
          }
        }),
        inspect: vi.fn(async () => c?.inspectResult ?? {}),
      };
    }),

    listContainers: vi.fn(async (args?: { filters?: { volume?: string[] } }) => {
      if (args?.filters?.volume) {
        const wanted = new Set(args.filters.volume);
        const ids = new Set<string>();
        for (const [vol, held] of volumeHolders) {
          if (wanted.has(vol)) for (const id of held) ids.add(id);
        }
        return [...ids].map((id) => ({ Id: id, Names: [`/${id}`] }));
      }
      return [...containers.values()]
        .filter((c) => !c.removed)
        .map((c) => ({
          Id: c.id,
          Labels: c.labels,
          State: c.started ? "running" : "exited",
        }));
    }),

    getEvents: vi.fn(async () => eventEmitter),

    getImage: vi.fn((_name: string) => ({
      inspect: vi.fn(async () => {
        imageInspectCalls++;
        if (imageId === undefined) throw new Error("no such image");
        return {
          Id: imageId,
          Config: {
            Env: imageBaseDigest === undefined ? [] : [`BASE_IMAGE_DIGEST=${imageBaseDigest}`],
          },
        };
      }),
    })),
  };

  return mockDocker;
}

const TEST_SESSION_DIR = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "session-container-cfg-")),
  "sessions",
  "test-session-1",
);
const TEST_WORKSPACE_DIR = path.join(TEST_SESSION_DIR, "workspace");

afterAll(() => {
  fs.rmSync(path.dirname(path.dirname(TEST_SESSION_DIR)), { recursive: true, force: true });
});

function buildConfig(overrides?: Partial<ContainerConfig>): ContainerConfig {
  return {
    sessionId: "test-session-1",
    sessionDir: TEST_SESSION_DIR,
    workspaceDir: TEST_WORKSPACE_DIR,
    sessionStateDir: path.join(TEST_SESSION_DIR, "state"),
    credentialsDir: TEST_CREDENTIALS_DIR,
    imageName: "shipit-session-worker:test",
    memoryLimit: 512 * 1024 * 1024,
    cpuQuota: 50_000,
    pidsLimit: 256,
    ...overrides,
  };
}

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

  describe("resolveWorkerImageId", () => {
    it("inspects the worker image and returns its id", async () => {
      mockDocker._setImageId("sha256:deadbeef");
      expect(await manager.resolveWorkerImageId()).toBe("sha256:deadbeef");
      expect(mockDocker.getImage).toHaveBeenCalledWith("shipit-session-worker:test");
    });

    it("caches the result — a second call adds no Docker inspect", async () => {
      await manager.resolveWorkerImageId();
      await manager.resolveWorkerImageId();
      expect(mockDocker._imageInspectCalls()).toBe(1);
    });

    it("returns undefined and caches the miss when the image can't be inspected", async () => {
      mockDocker._setImageId(undefined);
      expect(await manager.resolveWorkerImageId()).toBeUndefined();
      mockDocker._setImageId("sha256:later");
      expect(await manager.resolveWorkerImageId()).toBeUndefined();
      expect(mockDocker._imageInspectCalls()).toBe(1);
    });
  });

  describe("resolveWorkerBaseDigest", () => {
    it("reads BASE_IMAGE_DIGEST out of the worker image's Config.Env", async () => {
      mockDocker._setImageBaseDigest("sha256:basexyz");
      expect(await manager.resolveWorkerBaseDigest()).toBe("sha256:basexyz");
      expect(mockDocker.getImage).toHaveBeenCalledWith("shipit-session-worker:test");
    });

    it("caches the result — a second call adds no Docker inspect", async () => {
      await manager.resolveWorkerBaseDigest();
      await manager.resolveWorkerBaseDigest();
      expect(mockDocker._imageInspectCalls()).toBe(1);
    });

    it("returns undefined for a pre-planning#196 image with no baked digest", async () => {
      mockDocker._setImageBaseDigest(undefined);
      expect(await manager.resolveWorkerBaseDigest()).toBeUndefined();
    });

    it("returns undefined and caches the miss when the image can't be inspected", async () => {
      mockDocker._setImageId(undefined);
      expect(await manager.resolveWorkerBaseDigest()).toBeUndefined();
      mockDocker._setImageId("sha256:later");
      mockDocker._setImageBaseDigest("sha256:basexyz");
      expect(await manager.resolveWorkerBaseDigest()).toBeUndefined();
      expect(mockDocker._imageInspectCalls()).toBe(1);
    });
  });

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

  describe("create", () => {
    it("creates and starts a container with correct config", async () => {
      const config = buildConfig();
      const sc = await manager.create(config);

      expect(sc.sessionId).toBe("test-session-1");
      expect(sc.containerIp).toMatch(/^172\.18\.0\.\d+$/);
      expect(sc.workerUrl).toBe(`http://${sc.containerIp}:9100`);
      expect(sc.status).toBe("running");
      expect(sc.id).toMatch(/^container-\d+$/);

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
              `${TEST_WORKSPACE_DIR}:/workspace:rw`,
              `${TEST_CREDENTIALS_DIR}/sessions/test-session-1:/credentials:rw`,
            ]),
            Memory: 512 * 1024 * 1024,
            CpuQuota: 50_000,
            CpuPeriod: 100_000,
            PidsLimit: 256,
            NetworkMode: "shipit-test",
            SecurityOpt: ["no-new-privileges"],
            CapDrop: ["ALL"],
            CapAdd: ["CHOWN", "SETUID", "SETGID", "FOWNER", "KILL"],
            Init: true,
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
            "WORKSPACE_DIR=/workspace",
          ]),
        }),
      );
    });

    it("hands the pnpm store dir to the shared worker gid before mounting it", async () => {
      const myUid = process.getuid?.();
      const myGid = process.getgid?.();
      if (myUid === undefined || myGid === undefined) return;
      const prevUid = process.env.SHIPIT_SESSION_WORKER_UID;
      // This variable also selects the shared gid; use a group this process can assign.
      process.env.SHIPIT_SESSION_WORKER_UID = String(myGid);
      const storeDir = path.join(TEST_SESSION_DIR, "pnpm-store", "deadbeefcafe0001");
      const spy = vi.spyOn(fs, "lchownSync");
      try {
        await manager.create(buildConfig({ pnpmStoreDir: storeDir }));
        expect(fs.existsSync(storeDir)).toBe(true);
        expect(spy).toHaveBeenCalledWith(storeDir, myUid, myGid);
        const call = mockDocker.createContainer.mock.calls[0][0];
        expect(call.HostConfig.Binds).toContain(`${storeDir}:/workspace/.pnpm-store:rw`);
      } finally {
        spy.mockRestore();
        if (prevUid === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
        else process.env.SHIPIT_SESSION_WORKER_UID = prevUid;
      }
    });

    it("drops the pnpm store mount and env when the handoff fails", async () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return;
      const prevUid = process.env.SHIPIT_SESSION_WORKER_UID;
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid + 1);
      const storeDir = path.join(TEST_SESSION_DIR, "pnpm-store", "deadbeefcafe0002");
      const spy = vi.spyOn(fs, "lchownSync").mockImplementation(() => {});
      try {
        await manager.create(buildConfig({ pnpmStoreDir: storeDir }));
        const call = mockDocker.createContainer.mock.calls[0][0];
        expect(call.HostConfig.Binds).not.toContain(`${storeDir}:/workspace/.pnpm-store:rw`);
        expect(call.Env).not.toContain("npm_config_store_dir=/workspace/.pnpm-store");
      } finally {
        spy.mockRestore();
        if (prevUid === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
        else process.env.SHIPIT_SESSION_WORKER_UID = prevUid;
      }
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

    it("drops all capabilities and adds back minimum set", async () => {
      await manager.create(buildConfig());

      const call = mockDocker.createContainer.mock.calls[0][0];
      expect(call.HostConfig.CapDrop).toEqual(["ALL"]);
      expect(call.HostConfig.CapAdd).toEqual([
        "CHOWN", "SETUID", "SETGID", "FOWNER", "KILL",
      ]);
    });

    it("cleans up on creation failure", async () => {
      mockDocker.createContainer.mockRejectedValueOnce(new Error("image not found"));

      await expect(manager.create(buildConfig())).rejects.toThrow("image not found");
      expect(manager.get("test-session-1")).toBeUndefined();
      expect(manager.size).toBe(0);
    });
  });

  it("detaches every stopped service before a narrow Compose start can restart dependencies", async () => {
    const previousEnforce = process.env.SESSION_EGRESS_ENFORCE;
    process.env.SESSION_EGRESS_ENFORCE = "1";
    const disconnect = vi.fn(async () => undefined);
    mockDocker.getNetwork.mockReturnValue({ disconnect } as any);
    for (const [id, serviceName] of [["web-id", "web"], ["db-id", "db"]] as const) {
      mockDocker._containers.set(id, {
        id,
        started: false,
        removed: false,
        labels: {
          "shipit-parent-session": "test-session-1",
          "shipit-service-name": serviceName,
        },
        inspectResult: { id, NetworkSettings: { Networks: {} } },
      });
    }

    try {
      await manager.prepareComposeServiceStart("test-session-1", ["web"]);
    } finally {
      if (previousEnforce === undefined) delete process.env.SESSION_EGRESS_ENFORCE;
      else process.env.SESSION_EGRESS_ENFORCE = previousEnforce;
    }

    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledWith({ Container: "web-id", Force: true });
    expect(disconnect).toHaveBeenCalledWith({ Container: "db-id", Force: true });
  });

  describe("pluginEgressPolicy", () => {
    let savedEnv: NodeJS.ProcessEnv;
    beforeEach(() => {
      savedEnv = { ...process.env };
      process.env.SESSION_EGRESS_ENFORCE = "1";
      process.env.SESSION_EGRESS_SIDECAR_IMAGE = "egress-sidecar:test";
    });
    afterEach(() => {
      process.env = savedEnv;
    });

    function managerWith(contained: boolean): SessionContainerManager {
      return new SessionContainerManager({
        docker: mockDocker as any,
        imageName: "shipit-session-worker:test",
        networkName: "shipit-test",
        skipHealthCheck: true,
        resolveEgressConfig: () => ({
          contained, base: ["base.example"], extraHosts: ["extra.example"],
        }),
      });
    }

    it("reports the session's own resolved config, tiers, and allow-once hosts", () => {
      allowEgressHost("test-session-1", "once.example");

      const policy = managerWith(true).pluginEgressPolicy("test-session-1");

      expect(policy.contained).toBe(true);
      expect(policy.config).toEqual({
        contained: true, base: ["base.example"], extraHosts: ["extra.example"],
      });
      expect(policy.allowOnceHosts).toEqual(["once.example"]);
      expect(policy.sidecarImage).toBe("egress-sidecar:test");
      expect(policy.dnsEnabled).toBe(true);
      expect(policy.proxyEnabled).toBe(true);
      clearEgressPolicy("test-session-1");
    });

    it("reports an Open session as uncontained, with nothing to snapshot", () => {
      allowEgressHost("test-session-1", "once.example");

      const policy = managerWith(false).pluginEgressPolicy("test-session-1");

      expect(policy.contained).toBe(false);
      expect(policy.allowOnceHosts).toEqual([]);
      clearEgressPolicy("test-session-1");
    });

    it("reports uncontained when the deployment does not enforce at all", () => {
      process.env.SESSION_EGRESS_ENFORCE = "0";
      expect(managerWith(true).pluginEgressPolicy("test-session-1").contained).toBe(false);
    });

    it("snapshots no allow-once host for a session that admits none", () => {
      allowEgressHost("test-session-1", "once.example");
      const manager = new SessionContainerManager({
        docker: mockDocker as any,
        imageName: "shipit-session-worker:test",
        networkName: "shipit-test",
        skipHealthCheck: true,
        resolveEgressConfig: () => ({
          contained: true, base: ["lifeline.example"], extraHosts: [], userHostsExcluded: true,
        }),
      });

      const policy = manager.pluginEgressPolicy("test-session-1");

      expect(policy.contained).toBe(true);
      expect(policy.allowOnceHosts).toEqual([]);
      expect(policy.config?.base).toEqual(["lifeline.example"]);
      clearEgressPolicy("test-session-1");
    });
  });

  describe("kernel-tier hardening", () => {
    let savedEnv: NodeJS.ProcessEnv;
    beforeEach(() => {
      savedEnv = { ...process.env };
      process.env.SESSION_RUNTIME = "";
      process.env.SESSION_SECCOMP = "";
      process.env.SESSION_READONLY_ROOTFS = "";
    });
    afterEach(() => {
      process.env = savedEnv;
    });

    it("defaults are byte-for-byte unchanged when no flag is set", async () => {
      await manager.create(buildConfig());
      const { HostConfig } = mockDocker.createContainer.mock.calls[0][0];
      expect(HostConfig.Runtime).toBeUndefined();
      expect(HostConfig.SecurityOpt).toEqual(["no-new-privileges"]);
      expect(HostConfig.ReadonlyRootfs).toBe(false);
      expect(HostConfig.Tmpfs).toBeUndefined();
    });

    it("SESSION_RUNTIME selects an alternate OCI runtime (gVisor opt-in)", async () => {
      process.env.SESSION_RUNTIME = "runsc";
      await manager.create(buildConfig());
      const { HostConfig } = mockDocker.createContainer.mock.calls[0][0];
      expect(HostConfig.Runtime).toBe("runsc");
    });

    it("SESSION_SECCOMP=1 appends the custom profile to SecurityOpt", async () => {
      process.env.SESSION_SECCOMP = "1";
      await manager.create(buildConfig());
      const { HostConfig } = mockDocker.createContainer.mock.calls[0][0];
      expect(HostConfig.SecurityOpt[0]).toBe("no-new-privileges");
      expect(HostConfig.SecurityOpt[1].startsWith("seccomp=")).toBe(true);
      const profile = JSON.parse(HostConfig.SecurityOpt[1].slice("seccomp=".length));
      expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
    });

    it("SESSION_READONLY_ROOTFS=1 sets ReadonlyRootfs + tmpfs + the home-rehydrate env", async () => {
      process.env.SESSION_READONLY_ROOTFS = "1";
      await manager.create(buildConfig());
      const call = mockDocker.createContainer.mock.calls[0][0];
      expect(call.HostConfig.ReadonlyRootfs).toBe(true);
      expect(Object.keys(call.HostConfig.Tmpfs).sort()).toEqual([
        "/home/shipit",
        "/plugin-bin",
        "/plugins",
        "/run",
        "/tmp",
      ]);
      expect(call.Env).toContain("SHIPIT_READONLY_HOME=1");
    });

    it("does not regress CapDrop/CapAdd when hardening is enabled", async () => {
      process.env.SESSION_RUNTIME = "runsc";
      process.env.SESSION_SECCOMP = "1";
      process.env.SESSION_READONLY_ROOTFS = "1";
      await manager.create(buildConfig());
      const { HostConfig } = mockDocker.createContainer.mock.calls[0][0];
      expect(HostConfig.CapDrop).toEqual(["ALL"]);
      expect(HostConfig.CapAdd).toEqual(["CHOWN", "SETUID", "SETGID", "FOWNER", "KILL"]);
    });
  });

  describe("PID 1 / orphan reaping", () => {
    let savedEnv: NodeJS.ProcessEnv;
    beforeEach(() => {
      savedEnv = { ...process.env };
    });
    afterEach(() => {
      process.env = savedEnv;
    });

    it("runs docker-init as PID 1 so orphans are reaped", async () => {
      await manager.create(buildConfig());
      const { HostConfig } = mockDocker.createContainer.mock.calls[0][0];
      expect(HostConfig.Init).toBe(true);
    });

    it("keeps the init when kernel-tier hardening is enabled", async () => {
      process.env.SESSION_RUNTIME = "runsc";
      process.env.SESSION_SECCOMP = "1";
      process.env.SESSION_READONLY_ROOTFS = "1";
      await manager.create(buildConfig());
      const { HostConfig } = mockDocker.createContainer.mock.calls[0][0];
      expect(HostConfig.Init).toBe(true);
    });
  });

  describe("egress fail-closed", () => {
    let savedEnv: NodeJS.ProcessEnv;
    beforeEach(() => {
      savedEnv = { ...process.env };
      process.env.SESSION_EGRESS_ENFORCE = "1";
      delete process.env.SESSION_EGRESS_SIDECAR_IMAGE;
    });
    afterEach(() => {
      process.env = savedEnv;
    });

    it("refuses to start a contained session when no sidecar image is configured", async () => {
      await expect(manager.create(buildConfig())).rejects.toThrow(
        /Agent egress containment is on but cannot be enforced.*SESSION_EGRESS_SIDECAR_IMAGE/s,
      );
    });

    it("names the escape hatches (build the image, or SESSION_EGRESS_ENFORCE=0) and tears the container down", async () => {
      await expect(manager.create(buildConfig())).rejects.toThrow(/SESSION_EGRESS_ENFORCE=0/);
      expect(manager.get("test-session-1")).toBeUndefined();
      expect(manager.size).toBe(0);
    });

    it("reaps parent-session-labeled children on create failure (no leaked egress sidecars)", async () => {
      await expect(manager.create(buildConfig())).rejects.toThrow();
      expect(mockDocker.listContainers).toHaveBeenCalledWith(
        expect.objectContaining({ filters: { label: ["shipit-parent-session=test-session-1"] } }),
      );
    });
  });

  describe("overlay session", () => {
    const overlaySpecs = [
      {
        volumeName: "shipit-test-session_overlay-aaaaaaaa",
        lowerdir: "/data/overlay-base/h1",
        upperdir: "/data/sessions/test-session-1/overlay/h1/upper",
        workdir: "/data/sessions/test-session-1/overlay/h1/work",
        depDir: "node_modules",
        mountPath: "/workspace/node_modules",
        scope: { repoUrl: "r", runtimeKey: "rt", depDir: "node_modules" },
        scopeHash: "h1",
      generation: 0,
      },
      {
        volumeName: "shipit-test-session_overlay-bbbbbbbb",
        lowerdir: "/data/overlay-base/h2",
        upperdir: "/data/sessions/test-session-1/overlay/h2/upper",
        workdir: "/data/sessions/test-session-1/overlay/h2/work",
        depDir: "packages/app/node_modules",
        mountPath: "/workspace/packages/app/node_modules",
        scope: { repoUrl: "r", runtimeKey: "rt", depDir: "packages/app/node_modules" },
        scopeHash: "h2",
      generation: 0,
      },
    ];

    it("creates one type=overlay volume per dep dir and mounts each nested under /workspace", async () => {
      await manager.create(buildConfig({ overlaySpecs }));

      for (const spec of overlaySpecs) {
        expect(mockDocker.createVolume).toHaveBeenCalledWith(
          expect.objectContaining({
            Name: spec.volumeName,
            Driver: "local",
            DriverOpts: expect.objectContaining({ type: "overlay", device: "overlay" }),
          }),
        );
        expect(mockDocker._liveVolumes.has(spec.volumeName)).toBe(true);
      }

      const call = mockDocker.createContainer.mock.calls[0][0];
      const mounts = call.HostConfig.Mounts ?? [];
      const overlayNames = overlaySpecs.map((s) => s.volumeName);

      const wsMount = mounts.find((m: any) => m.Target === "/workspace");
      if (wsMount) expect(overlayNames).not.toContain(wsMount.Source);

      for (const spec of overlaySpecs) {
        const nested = mounts.find((m: any) => m.Target === spec.mountPath);
        expect(nested).toBeDefined();
        expect(nested.Source).toBe(spec.volumeName);
        expect(nested.Type).toBe("volume");
      }
    });

    describe("base generation rotated under a running Compose stack", () => {
      const rotated = overlaySpecs.map((s) => ({
        ...s,
        lowerdir: `${s.lowerdir}/g3`,
        upperdir: `${s.upperdir}/g3`,
        workdir: `${s.workdir}/g3`,
        generation: 3,
      }));

      function seedStaleHeldVolumes(): void {
        for (const [i, spec] of overlaySpecs.entries()) {
          mockDocker._liveVolumes.add(spec.volumeName);
          mockDocker._volumeSpecs.set(spec.volumeName, {
            Options: {
              type: "overlay",
              device: "overlay",
              o: `lowerdir=${spec.lowerdir}/g2,upperdir=${spec.upperdir}/g2,workdir=${spec.workdir}/g2`,
            },
            Labels: { "shipit-managed": "true" },
          });
          mockDocker._volumeHolders.set(spec.volumeName, [`compose-sibling-${i}`]);
        }
      }

      it("removes the holders first, so the volume really is recreated over the new generation", async () => {
        seedStaleHeldVolumes();

        await manager.create(buildConfig({ overlaySpecs: rotated }));

        for (const spec of rotated) {
          expect(mockDocker._removedVolumes).toContain(spec.volumeName);
          expect(mockDocker._volumeSpecs.get(spec.volumeName)?.Options?.o).toBe(
            `lowerdir=${spec.lowerdir},upperdir=${spec.upperdir},workdir=${spec.workdir}`,
          );
          expect(mockDocker._volumeSpecs.get(spec.volumeName)?.Options?.o).not.toContain("/g2");
        }
        expect(manager.consumeOverlayVolumesRecreated("test-session-1")).toBe(true);
        expect(manager.consumeOverlayVolumesRecreated("test-session-1")).toBe(false);
      });

      it("fails the create loudly when a holder survives every attempt, rather than mounting the reaped generation", async () => {
        seedStaleHeldVolumes();
        const realGetContainer = mockDocker.getContainer.getMockImplementation()!;
        mockDocker.getContainer.mockImplementation((id: string) =>
          id.startsWith("compose-sibling-")
            ? { remove: vi.fn(async () => { throw Object.assign(new Error("cannot remove"), { statusCode: 500 }); }) } as any
            : realGetContainer(id));

        await expect(manager.create(buildConfig({ overlaySpecs: rotated }))).rejects.toThrow(
          /could not be recreated with the requested driver opts/,
        );
      });

      it("leaves an unrotated stack alone — no holder is removed and no reconcile is owed", async () => {
        for (const [i, spec] of overlaySpecs.entries()) {
          mockDocker._liveVolumes.add(spec.volumeName);
          mockDocker._volumeSpecs.set(spec.volumeName, {
            Options: {
              type: "overlay",
              device: "overlay",
              o: `lowerdir=${spec.lowerdir},upperdir=${spec.upperdir},workdir=${spec.workdir}`,
            },
            Labels: { "shipit-managed": "true" },
          });
          mockDocker._volumeHolders.set(spec.volumeName, [`compose-sibling-${i}`]);
        }

        await manager.create(buildConfig({ overlaySpecs }));

        expect(mockDocker._removedVolumes).toEqual([]);
        for (const spec of overlaySpecs) {
          expect(mockDocker._volumeHolders.get(spec.volumeName)).toHaveLength(1);
        }
        expect(manager.consumeOverlayVolumesRecreated("test-session-1")).toBe(false);
      });
    });

    it("removes every overlay volume when container creation fails (no leak)", async () => {
      mockDocker.createContainer.mockRejectedValueOnce(new Error("image not found"));

      await expect(manager.create(buildConfig({ overlaySpecs }))).rejects.toThrow("image not found");
      for (const spec of overlaySpecs) {
        expect(mockDocker._removedVolumes).toContain(spec.volumeName);
        expect(mockDocker._liveVolumes.has(spec.volumeName)).toBe(false);
      }
    });

    it("removes every overlay volume on destroy", async () => {
      await manager.create(buildConfig({ overlaySpecs }));
      for (const spec of overlaySpecs) {
        expect(mockDocker._liveVolumes.has(spec.volumeName)).toBe(true);
      }

      await manager.destroy("test-session-1");
      for (const spec of overlaySpecs) {
        expect(mockDocker._removedVolumes).toContain(spec.volumeName);
      }
    });

    it("does not touch volumes for non-overlay sessions", async () => {
      await manager.create(buildConfig());
      expect(mockDocker.createVolume).not.toHaveBeenCalled();
    });
  });

  describe("prepareOverlaySpecs", () => {
    const STATE_VOL = "shipit-workspace";
    const MP = `/var/lib/docker/volumes/${STATE_VOL}/_data`;
    let ovlManager: SessionContainerManager;
    let tmpDirs: string[];
    let savedFlag: string | undefined;

    beforeEach(() => {
      savedFlag = process.env.OVERLAY_DEP_STORE;
      tmpDirs = [];
      ovlManager = new SessionContainerManager({
        docker: mockDocker as any,
        imageName: "shipit-session-worker:test",
        networkName: "shipit-test",
        skipHealthCheck: true,
        workspaceVolume: STATE_VOL,
      });
    });
    afterEach(async () => {
      if (savedFlag === undefined) delete process.env.OVERLAY_DEP_STORE;
      else process.env.OVERLAY_DEP_STORE = savedFlag;
      for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
      await ovlManager.dispose();
    });

    async function ws(opts: { gitignore?: string; shipitYaml?: string; dirs?: string[] } = {}): Promise<string> {
      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "prep-overlay-"));
      tmpDirs.push(sessionDir);
      const dir = path.join(sessionDir, "workspace");
      fs.mkdirSync(dir, { recursive: true });
      const git = (await import("simple-git")).default;
      await git(dir).init();
      if (opts.gitignore !== undefined) fs.writeFileSync(path.join(dir, ".gitignore"), opts.gitignore);
      if (opts.shipitYaml !== undefined) fs.writeFileSync(path.join(dir, "shipit.yaml"), opts.shipitYaml);
      for (const d of opts.dirs ?? []) fs.mkdirSync(path.join(dir, d), { recursive: true });
      return dir;
    }
    const eligible = { remoteUrl: "https://github.com/acme/repo.git", kind: undefined } as const;

    it("returns [] when the kill switch is set (OVERLAY_DEP_STORE=0)", async () => {
      process.env.OVERLAY_DEP_STORE = "0";
      const dir = await ws({ gitignore: "node_modules\n" });
      expect(await ovlManager.prepareOverlaySpecs({ sessionId: "s1", workspaceDir: dir, session: eligible }))
        .toEqual([]);
    });

    it("returns [] for an ineligible session (no remote / ops) even with the flag on", async () => {
      process.env.OVERLAY_DEP_STORE = "1";
      const dir = await ws({ gitignore: "node_modules\n" });
      expect(await ovlManager.prepareOverlaySpecs({ sessionId: "s1", workspaceDir: dir, session: { remoteUrl: "", kind: undefined } }))
        .toEqual([]);
      expect(await ovlManager.prepareOverlaySpecs({ sessionId: "s1", workspaceDir: dir, session: { remoteUrl: "r", kind: "ops" } }))
        .toEqual([]);
    });

    it("builds one spec per valid dep dir, anchored at the state-volume mountpoint", async () => {
      process.env.OVERLAY_DEP_STORE = "1";
      const dir = await ws({ gitignore: "node_modules\n" });
      const specs = await ovlManager.prepareOverlaySpecs({ sessionId: "abc123def456", workspaceDir: dir, session: eligible });
      expect(specs).toHaveLength(1);
      expect(specs[0].depDir).toBe("node_modules");
      expect(specs[0].mountPath).toBe("/workspace/node_modules");
      expect(specs[0].lowerdir.startsWith(`${MP}/overlay-base/`)).toBe(true);
      expect(specs[0].upperdir).toContain(`${MP}/sessions/abc123def456/overlay/`);
      expect(specs[0].volumeName).toMatch(/^shipit-abc123def456_overlay-[a-f0-9]{8}$/);
    });

    it("cold-scope create provisions lowerdir/upperdir/workdir via orchDirs before the volume mounts", async () => {
      process.env.OVERLAY_DEP_STORE = "1";
      const dir = await ws({ gitignore: "node_modules\n" });
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-state-"));
      tmpDirs.push(stateDir);
      const mgr = new SessionContainerManager({
        docker: mockDocker as any,
        imageName: "shipit-session-worker:test",
        networkName: "shipit-test",
        skipHealthCheck: true,
        workspaceVolume: STATE_VOL,
        stateDir,
      });
      try {
        const specs = await mgr.prepareOverlaySpecs({ sessionId: "cold-scope-1", workspaceDir: dir, session: eligible });
        expect(specs[0].orchDirs).toBeDefined();
        expect(fs.existsSync(specs[0].orchDirs!.lowerdir)).toBe(false);
        await mgr.create(mgr.buildConfigForWorkspace({
          sessionId: "cold-scope-1",
          sessionDir: path.dirname(dir),
          workspaceDir: dir,
          credentialsDir: TEST_CREDENTIALS_DIR,
          overlaySpecs: specs,
        }));
        expect(fs.existsSync(specs[0].orchDirs!.lowerdir)).toBe(true);
        expect(fs.existsSync(specs[0].orchDirs!.upperdir)).toBe(true);
        expect(fs.existsSync(specs[0].orchDirs!.workdir)).toBe(true);
      } finally {
        await mgr.dispose();
      }
    });

    it("requireProvisioned drops specs whose overlay volume does not exist (container predates the flag)", async () => {
      process.env.OVERLAY_DEP_STORE = "1";
      const dir = await ws({ gitignore: "node_modules\n" });
      const all = await ovlManager.prepareOverlaySpecs({ sessionId: "abc123def456", workspaceDir: dir, session: eligible });
      expect(all).toHaveLength(1);
      mockDocker._missingVolumes.add(all[0].volumeName);
      const provisioned = await ovlManager.prepareOverlaySpecs({
        sessionId: "abc123def456", workspaceDir: dir, session: eligible, requireProvisioned: true,
      });
      expect(provisioned).toEqual([]);
    });

    it("requireProvisioned keeps specs whose overlay volume exists", async () => {
      process.env.OVERLAY_DEP_STORE = "1";
      const dir = await ws({ gitignore: "node_modules\n" });
      const all = await ovlManager.prepareOverlaySpecs({ sessionId: "abc123def456", workspaceDir: dir, session: eligible });
      mockDocker._liveVolumes.add(all[0].volumeName);
      const provisioned = await ovlManager.prepareOverlaySpecs({
        sessionId: "abc123def456", workspaceDir: dir, session: eligible, requireProvisioned: true,
      });
      expect(provisioned).toHaveLength(1);
      expect(provisioned[0].depDir).toBe("node_modules");
    });

    it("end-to-end: populator → buildConfigForWorkspace → create mounts the overlay volume nested under /workspace", async () => {
      process.env.OVERLAY_DEP_STORE = "1";
      const dir = await ws({ gitignore: "node_modules\n" });
      const overlaySpecs = await ovlManager.prepareOverlaySpecs({ sessionId: "e2e-session-1", workspaceDir: dir, session: eligible });
      const config = ovlManager.buildConfigForWorkspace({
        sessionId: "e2e-session-1",
        sessionDir: path.dirname(dir),
        workspaceDir: dir,
        credentialsDir: TEST_CREDENTIALS_DIR,
        overlaySpecs,
      });
      await ovlManager.create(config);

      expect(mockDocker._liveVolumes.has(overlaySpecs[0].volumeName)).toBe(true);
      const call = mockDocker.createContainer.mock.calls.at(-1)![0];
      const nested = call.HostConfig.Mounts.find((m: any) => m.Target === "/workspace/node_modules");
      expect(nested?.Source).toBe(overlaySpecs[0].volumeName);
      const wsMount = call.HostConfig.Mounts.find((m: any) => m.Target === "/workspace");
      if (wsMount) expect(wsMount.Source).not.toBe(overlaySpecs[0].volumeName);
    });

    it("warm standby path (docs/183 Phase 7): prepareOverlaySpecs → buildConfigForWorkspace → createStandby mounts the overlay nested + records the volume", async () => {
      process.env.OVERLAY_DEP_STORE = "1";
      const dir = await ws({ gitignore: "node_modules\n" });
      const appSessionId = "warm12345678";
      const overlaySpecs = await ovlManager.prepareOverlaySpecs({
        sessionId: appSessionId, workspaceDir: dir, session: eligible,
      });
      expect(overlaySpecs).toHaveLength(1);
      const config = ovlManager.buildConfigForWorkspace({
        sessionId: appSessionId, sessionDir: path.dirname(dir), workspaceDir: dir,
        credentialsDir: TEST_CREDENTIALS_DIR, overlaySpecs,
      });
      const sc = await ovlManager.createStandby(config);

      expect(mockDocker._liveVolumes.has(overlaySpecs[0].volumeName)).toBe(true);
      expect(sc.overlayVolumeNames).toEqual([overlaySpecs[0].volumeName]);
      const call = mockDocker.createContainer.mock.calls.at(-1)![0];
      const nested = call.HostConfig.Mounts.find((m: any) => m.Target === "/workspace/node_modules");
      expect(nested?.Source).toBe(overlaySpecs[0].volumeName);
      expect(ovlManager.standbyCount).toBeGreaterThan(0);
    });

    it("warm standby is overlay-free when the kill switch is set (byte-for-byte unchanged)", async () => {
      process.env.OVERLAY_DEP_STORE = "0";
      const dir = await ws({ gitignore: "node_modules\n" });
      const overlaySpecs = await ovlManager.prepareOverlaySpecs({
        sessionId: "warm-off-1", workspaceDir: dir, session: eligible,
      });
      expect(overlaySpecs).toEqual([]);
      const config = ovlManager.buildConfigForWorkspace({
        sessionId: "warm-off-1", sessionDir: path.dirname(dir), workspaceDir: dir,
        credentialsDir: TEST_CREDENTIALS_DIR, overlaySpecs,
      });
      await ovlManager.createStandby(config);
      const call = mockDocker.createContainer.mock.calls.at(-1)![0];
      const nested = call.HostConfig.Mounts.find((m: any) => m.Target === "/workspace/node_modules");
      expect(nested).toBeUndefined();
    });

    it("drops dep dirs that fail contextual validation (tracked source)", async () => {
      process.env.OVERLAY_DEP_STORE = "1";
      const dir = await ws({ gitignore: "node_modules\n", shipitYaml: "agent:\n  dep-dirs:\n    - src\n", dirs: ["src"] });
      expect(await ovlManager.prepareOverlaySpecs({ sessionId: "s1", workspaceDir: dir, session: eligible }))
        .toEqual([]);
    });

    it("returns [] when the manager has no workspace state volume (dev/bind mode)", async () => {
      process.env.OVERLAY_DEP_STORE = "1";
      const noVolManager = new SessionContainerManager({
        docker: mockDocker as any,
        imageName: "shipit-session-worker:test",
        networkName: "shipit-test",
        skipHealthCheck: true,
      });
      const dir = await ws({ gitignore: "node_modules\n" });
      expect(await noVolManager.prepareOverlaySpecs({ sessionId: "s1", workspaceDir: dir, session: eligible }))
        .toEqual([]);
      await noVolManager.dispose();
    });

    const PNPM_YAML = "agent:\n  install:\n    - pnpm install\n";

    it("returns [] for a pnpm repo even when otherwise overlay-eligible", async () => {
      process.env.OVERLAY_DEP_STORE = "1";
      const dir = await ws({ gitignore: "node_modules\n", shipitYaml: PNPM_YAML });
      expect(await ovlManager.prepareOverlaySpecs({ sessionId: "pnpm-1", workspaceDir: dir, session: eligible }))
        .toEqual([]);
    });

    function managerWithState(): { mgr: SessionContainerManager; stateDir: string } {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-state-"));
      tmpDirs.push(stateDir);
      const mgr = new SessionContainerManager({
        docker: mockDocker as any,
        imageName: "shipit-session-worker:test",
        networkName: "shipit-test",
        skipHealthCheck: true,
        workspaceVolume: STATE_VOL,
        stateDir,
      });
      return { mgr, stateDir };
    }

    it("preparePnpmStore returns the shared store dir for a pnpm repo (flag on)", async () => {
      process.env.OVERLAY_DEP_STORE = "1";
      const { mgr, stateDir } = managerWithState();
      try {
        const dir = await ws({ shipitYaml: PNPM_YAML });
        const store = mgr.preparePnpmStore({ workspaceDir: dir, session: eligible });
        expect(store).toBeDefined();
        expect(store!.startsWith(path.join(stateDir, "pnpm-store"))).toBe(true);
      } finally {
        await mgr.dispose();
      }
    });

    it("preparePnpmStore is undefined for a non-pnpm repo", async () => {
      process.env.OVERLAY_DEP_STORE = "1";
      const { mgr } = managerWithState();
      try {
        const dir = await ws({ gitignore: "node_modules\n" });
        expect(mgr.preparePnpmStore({ workspaceDir: dir, session: eligible })).toBeUndefined();
      } finally {
        await mgr.dispose();
      }
    });

    it("preparePnpmStore is undefined when the kill switch is set / session ineligible", async () => {
      const { mgr } = managerWithState();
      try {
        const dir = await ws({ shipitYaml: PNPM_YAML });
        process.env.OVERLAY_DEP_STORE = "0";
        expect(mgr.preparePnpmStore({ workspaceDir: dir, session: eligible })).toBeUndefined();
        process.env.OVERLAY_DEP_STORE = "1";
        expect(mgr.preparePnpmStore({ workspaceDir: dir, session: { remoteUrl: "", kind: undefined } })).toBeUndefined();
        expect(mgr.preparePnpmStore({ workspaceDir: dir, session: { remoteUrl: "r", kind: "ops" } })).toBeUndefined();
      } finally {
        await mgr.dispose();
      }
    });

    it("preparePnpmStore is undefined without a workspace state volume or state dir", async () => {
      process.env.OVERLAY_DEP_STORE = "1";
      const dir = await ws({ shipitYaml: PNPM_YAML });
      expect(ovlManager.preparePnpmStore({ workspaceDir: dir, session: eligible })).toBeUndefined();
    });

    it("end-to-end: a pnpm session mounts the store + sets npm_config_store_dir and gets NO overlay", async () => {
      process.env.OVERLAY_DEP_STORE = "1";
      // Use a shared gid this process can assign, or create() omits the store mount.
      const prevUid = process.env.SHIPIT_SESSION_WORKER_UID;
      process.env.SHIPIT_SESSION_WORKER_UID = String(process.getgid?.() ?? 0);
      const { mgr } = managerWithState();
      try {
        const dir = await ws({ gitignore: "node_modules\n", shipitYaml: PNPM_YAML });
        const overlaySpecs = await mgr.prepareOverlaySpecs({ sessionId: "pnpm-e2e-1", workspaceDir: dir, session: eligible });
        expect(overlaySpecs).toEqual([]);
        const pnpmStoreDir = mgr.preparePnpmStore({ workspaceDir: dir, session: eligible });
        const config = mgr.buildConfigForWorkspace({
          sessionId: "pnpm-e2e-1", sessionDir: path.dirname(dir), workspaceDir: dir,
          credentialsDir: TEST_CREDENTIALS_DIR, overlaySpecs, pnpmStoreDir,
        });
        await mgr.create(config);
        const call = mockDocker.createContainer.mock.calls.at(-1)![0];
        const storeMount = call.HostConfig.Mounts.find((m: any) => m.Target === "/workspace/.pnpm-store");
        expect(storeMount?.Source).toBe(STATE_VOL);
        expect(storeMount?.VolumeOptions?.Subpath).toContain("pnpm-store/");
        const nested = call.HostConfig.Mounts.find((m: any) => m.Target === "/workspace/node_modules");
        expect(nested).toBeUndefined();
        expect(call.Env).toContain("npm_config_store_dir=/workspace/.pnpm-store");
      } finally {
        if (prevUid === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
        else process.env.SHIPIT_SESSION_WORKER_UID = prevUid;
        await mgr.dispose();
      }
    });
  });

  describe("bootedLimits", () => {
    it("records the resource limits the container was actually created with", async () => {
      const sc = await manager.create(buildConfig({
        memoryLimit: 3072 * 1024 * 1024,
        cpuQuota: 200_000,
        pidsLimit: 2048,
      }));

      expect(sc.bootedLimits).toEqual({
        memoryLimit: 3072 * 1024 * 1024,
        cpuQuota: 200_000,
        pidsLimit: 2048,
      });
      expect(manager.get("test-session-1")?.bootedLimits).toEqual(sc.bootedLimits);
    });

    it("records bootedLimits even for non-docker-access sessions (unlike resourceLimits)", async () => {
      const sc = await manager.create(buildConfig());
      expect(sc.resourceLimits).toBeUndefined();
      expect(sc.bootedLimits).toEqual({
        memoryLimit: 512 * 1024 * 1024,
        cpuQuota: 50_000,
        pidsLimit: 256,
      });
    });
  });

  describe("capabilitiesAtStart (docs/279)", () => {
    const CAPS = { git: true, docker: false, network: true, dangerousGitHubOps: false };

    it("reports null for a container whose boot-time grants were never recorded", async () => {
      await manager.create(buildConfig({ sessionId: "s1", sessionDir: "/ws/s1" }));
      expect(manager.capabilitiesAtStart("s1")).toBeNull();
    });

    it("reports the recorded grants once the creation path records them", async () => {
      await manager.create(buildConfig({ sessionId: "s1", sessionDir: "/ws/s1" }));
      manager.recordCapabilitiesAtStart("s1", CAPS);
      expect(manager.capabilitiesAtStart("s1")).toEqual(CAPS);
    });

    it("reports null for a session with no container at all", () => {
      expect(manager.capabilitiesAtStart("never-created")).toBeNull();
    });

    it("ignores a record for a container that is already gone", async () => {
      expect(() => manager.recordCapabilitiesAtStart("never-created", CAPS)).not.toThrow();
      expect(manager.capabilitiesAtStart("never-created")).toBeNull();
    });
  });

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

      expect(destroyed).toHaveBeenCalledWith("test-session-1", true);
    });

    it("is a no-op for unknown session IDs", async () => {
      await manager.destroy("nonexistent");
    });
  });

  describe("markContainerGone", () => {
    it("drops the tracking entry for a container Docker says is gone", async () => {
      const sc = await manager.create(buildConfig());
      expect(manager.get("test-session-1")).toBe(sc);

      expect(await manager.markContainerGone("test-session-1", sc.id)).toBe(true);

      expect(manager.get("test-session-1")).toBeUndefined();
      expect(manager.size).toBe(0);
      expect(sc.status).toBe("stopped");
    });

    it("refuses to act on a different container incarnation", async () => {
      const sc = await manager.create(buildConfig());

      expect(await manager.markContainerGone("test-session-1", "some-other-id")).toBe(false);

      expect(manager.get("test-session-1")).toBe(sc);
      expect(sc.status).not.toBe("stopped");
    });

    it("does not emit container_destroyed", async () => {
      const destroyed = vi.fn();
      manager.on("container_destroyed", destroyed);
      const sc = await manager.create(buildConfig());

      await manager.markContainerGone("test-session-1", sc.id);

      expect(destroyed).not.toHaveBeenCalled();
    });

    it("is a no-op for unknown session IDs", async () => {
      expect(await manager.markContainerGone("nonexistent", "c1")).toBe(false);
    });
  });

  describe("cleanupOrphans", () => {
    it("removes containers not in the active set", async () => {
      await manager.create(buildConfig({ sessionId: "active-1", sessionDir: "/ws/a1" }));
      await manager.create(buildConfig({ sessionId: "orphan-1", sessionDir: "/ws/o1" }));

      const removed = await manager.cleanupOrphans(new Set(["active-1"]));

      expect(removed).toBe(1);
    });

    it("returns 0 when all containers are active", async () => {
      await manager.create(buildConfig({ sessionId: "s1", sessionDir: "/ws/s1" }));
      const removed = await manager.cleanupOrphans(new Set(["s1"]));
      expect(removed).toBe(0);
    });
  });

  describe("buildConfig", () => {
    it("applies defaults from manager options", () => {
      const config = manager.buildConfig({
        sessionId: "s1",
        sessionDir: "/ws/s1",
        workspaceDir: "/ws/s1/workspace",
        credentialsDir: "/creds",
      });

      expect(config.imageName).toBe("shipit-session-worker:test");
      expect(config.memoryLimit).toBe(1536 * 1024 * 1024);
      expect(config.cpuQuota).toBe(50_000);
      expect(config.pidsLimit).toBe(4096);
    });

    it("allows overriding defaults", () => {
      const config = manager.buildConfig({
        sessionId: "s1",
        sessionDir: "/ws/s1",
        workspaceDir: "/ws/s1/workspace",
        credentialsDir: "/creds",
        memoryLimit: 1024 * 1024 * 1024,
        cpuQuota: 100_000,
        pidsLimit: 512,
      });

      expect(config.memoryLimit).toBe(1024 * 1024 * 1024);
      expect(config.cpuQuota).toBe(100_000);
      expect(config.pidsLimit).toBe(512);
    });
  });

  describe("health monitoring", () => {
    it("emits container_exited when a container dies", async () => {
      await manager.create(buildConfig());
      await manager.startHealthMonitor();

      const exited = vi.fn();
      manager.on("container_exited", exited);

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

    it("does NOT treat a bare oom event as a container exit", async () => {
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

      expect(exited).not.toHaveBeenCalled();
      expect(manager.get("test-session-1")).toBeDefined();
    });

    it("reports 'Out of memory' on the die that FOLLOWS an oom", async () => {
      await manager.create(buildConfig());
      await manager.startHealthMonitor();

      const exited = vi.fn();
      manager.on("container_exited", exited);

      const attrs = { [CONTAINER_SESSION_ID_LABEL]: "test-session-1", exitCode: "137" };
      mockDocker._eventEmitter.emit("data", Buffer.from(JSON.stringify({
        Action: "oom", Actor: { Attributes: attrs },
      })));
      mockDocker._eventEmitter.emit("data", Buffer.from(JSON.stringify({
        Action: "die", Actor: { Attributes: attrs },
      })));

      expect(exited).toHaveBeenCalledWith("test-session-1", 137, "Out of memory");
      expect(manager.get("test-session-1")).toBeUndefined();
    });

    it("reports no OOM reason on a plain die with no preceding oom", async () => {
      await manager.create(buildConfig());
      await manager.startHealthMonitor();

      const exited = vi.fn();
      manager.on("container_exited", exited);

      mockDocker._eventEmitter.emit("data", Buffer.from(JSON.stringify({
        Action: "die",
        Actor: { Attributes: { [CONTAINER_SESSION_ID_LABEL]: "test-session-1", exitCode: "1" } },
      })));

      expect(exited).toHaveBeenCalledWith("test-session-1", 1, undefined);
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

      manager.stopHealthMonitor();
    });

    it("auto-restarts the Docker event stream on error so OOM detection survives daemon hiccups", async () => {
      vi.useFakeTimers();
      try {
        await manager.create(buildConfig());
        await manager.startHealthMonitor();
        expect(mockDocker.getEvents).toHaveBeenCalledTimes(1);

        mockDocker._eventEmitter.emit("error", new Error("daemon went away"));

        await vi.advanceTimersByTimeAsync(5_000);

        expect(mockDocker.getEvents).toHaveBeenCalledTimes(2);

        const exited = vi.fn();
        manager.on("container_exited", exited);
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
      } finally {
        manager.stopHealthMonitor();
        vi.useRealTimers();
      }
    });

    it("emits health_monitor_resumed with gap duration on successful reconnect", async () => {
      vi.useFakeTimers();
      try {
        await manager.startHealthMonitor();
        expect(mockDocker.getEvents).toHaveBeenCalledTimes(1);

        const resumed = vi.fn();
        manager.on("health_monitor_resumed", resumed);

        mockDocker._eventEmitter.emit("error", new Error("daemon hiccup"));
        await vi.advanceTimersByTimeAsync(5_000);

        expect(mockDocker.getEvents).toHaveBeenCalledTimes(2);
        expect(resumed).toHaveBeenCalledTimes(1);
        const arg = resumed.mock.calls[0]?.[0] as { gapMs: number };
        expect(arg.gapMs).toBeGreaterThanOrEqual(5_000);

        mockDocker._eventEmitter.emit("error", new Error("another hiccup"));
        await vi.advanceTimersByTimeAsync(5_000);
        expect(resumed).toHaveBeenCalledTimes(2);

      } finally {
        manager.stopHealthMonitor();
        vi.useRealTimers();
      }
    });

    it("does not restart after explicit stopHealthMonitor", async () => {
      vi.useFakeTimers();
      try {
        await manager.startHealthMonitor();
        expect(mockDocker.getEvents).toHaveBeenCalledTimes(1);

        manager.stopHealthMonitor();

        mockDocker._eventEmitter.emit("error", new Error("late error"));
        await vi.advanceTimersByTimeAsync(10_000);

        expect(mockDocker.getEvents).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("dispose", () => {
    it("leaves every container running and only stops the health monitor", async () => {
      await manager.create(buildConfig({ sessionId: "s1", sessionDir: "/ws/s1" }));
      await manager.create(buildConfig({ sessionId: "s2", sessionDir: "/ws/s2" }));
      await manager.startHealthMonitor();
      expect(manager.size).toBe(2);

      await manager.dispose();

      const live = [...mockDocker._containers.values()];
      expect(live).toHaveLength(2);
      expect(live.every((c) => !c.removed)).toBe(true);
      expect(manager.size).toBe(2);
      expect(manager.get("s1")?.status).toBe("running");
      expect(manager.get("s2")?.status).toBe("running");
    });

    it("emits no container_destroyed", async () => {
      const destroyed = vi.fn();
      await manager.create(buildConfig({ sessionId: "s1", sessionDir: "/ws/s1" }));
      manager.on("container_destroyed", destroyed);

      await manager.dispose();

      expect(destroyed).not.toHaveBeenCalled();
    });

    it("is idempotent", async () => {
      await manager.dispose();
      await manager.dispose();
    });
  });
});

describe("readAgentConfig (W4a)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-read-agent-config-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch { /* ignore */ }
  });

  it("logs the workspace + error and returns defaults when shipit.yaml is malformed", () => {
    expectInvalidShipitConfig(() => {
      fs.writeFileSync(path.join(tmpDir, "shipit.yaml"), "agent:\n  memory: [unclosed\n: : :\n");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const config = readAgentConfig(tmpDir);

    expect(config.agent.install).toEqual([]);
    expect(config.agent.depDirs).toEqual(["node_modules"]);

    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = String(errSpy.mock.calls[0]?.[0] ?? "");
    expect(logged).toContain(tmpDir);
    expect(logged).toMatch(/default agent config/i);

    errSpy.mockRestore();
  });

  it("does not log for a genuinely-absent shipit.yaml (the common, legitimate case)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const config = readAgentConfig(tmpDir);

    expect(config.agent.install).toEqual([]);
    expect(errSpy).not.toHaveBeenCalled();

    errSpy.mockRestore();
  });

  it("parses a valid new-format shipit.yaml and ignores removed resource fields", () => {
    fs.writeFileSync(
      path.join(tmpDir, "shipit.yaml"),
      "agent:\n  install: npm install\n  memory: 3072\n",
    );
    const config = readAgentConfig(tmpDir);
    expect(config.agent.install).toEqual(["npm install"]);
    expect(config.warnings.join("\n")).toMatch(/`agent.memory` is no longer used/);
  });
});

describe("buildConfigForWorkspace — sandbox Docker capability (docs/211)", () => {
  let mgr: SessionContainerManager;
  let tmpDir: string;

  beforeEach(() => {
    mgr = new SessionContainerManager({
      docker: createMockDocker() as any,
      imageName: "shipit-session-worker:test",
      networkName: "shipit-test",
      skipHealthCheck: true,
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-docker-"));
    fs.mkdirSync(path.join(tmpDir, "workspace"), { recursive: true });
  });
  afterEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await mgr.dispose();
  });

  const base = (dockerAccess?: boolean): ContainerConfig =>
    mgr.buildConfigForWorkspace({
      sessionId: "sbx123456789",
      sessionDir: tmpDir,
      workspaceDir: path.join(tmpDir, "workspace"),
      credentialsDir: TEST_CREDENTIALS_DIR,
      ...(dockerAccess !== undefined ? { dockerAccess } : {}),
    });

  it("grants session-scoped dockerAccess when capabilities.docker is on (override wins over the absent shipit.yaml)", () => {
    const config = base(true);
    expect(config.dockerAccess).toBe(true);
    expect(config.opsSession).toBeFalsy();
    expect(config.hostMounts).toBeUndefined();
  });

  it("leaves dockerAccess off when capabilities.docker is off (explicit false still wins)", () => {
    expect(base(false).dockerAccess).toBe(false);
  });

  it("falls back to the workspace-derived value (false here) when no override is passed (non-sandbox path)", () => {
    expect(base(undefined).dockerAccess).toBe(false);
  });
});

describe("createStandby cancelled by a concurrent destroy", () => {
  const SESSION = "b1f0c2d3-4e5f-4a6b-8c9d-0e1f2a3b4c5d";

  it("neither completes nor registers the session as a standby", async () => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let reachedCreate!: () => void;
    const atCreate = new Promise<void>((resolve) => { reachedCreate = resolve; });
    const started: string[] = [];

    const docker = {
      listContainers: async () => [],
      listNetworks: async () => [],
      listVolumes: async () => ({ Volumes: [] }),
      getNetwork: () => ({ remove: async () => {} }),
      getVolume: () => ({ remove: async () => {} }),
      getContainer: () => ({
        inspect: async () => { throw Object.assign(new Error("no such container"), { statusCode: 404 }); },
        stop: async () => {},
        remove: async () => {},
      }),
      createContainer: async () => {
        reachedCreate();
        await paused;
        return {
          id: "cid-standby",
          start: async () => { started.push("cid-standby"); },
          inspect: async () => ({
            Config: { Labels: {} },
            NetworkSettings: { Networks: { "shipit-test": { IPAddress: "172.20.0.9" } } },
          }),
        };
      },
    };

    const manager = new SessionContainerManager({
      docker: docker as never,
      imageName: "shipit-session-worker:test",
      networkName: "shipit-test",
      skipHealthCheck: true,
    });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-standby-race-"));
    fs.mkdirSync(path.join(tmp, "workspace"), { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config: ContainerConfig = {
        sessionId: SESSION,
        sessionDir: tmp,
        workspaceDir: path.join(tmp, "workspace"),
        sessionStateDir: path.join(tmp, "state"),
        credentialsDir: TEST_CREDENTIALS_DIR,
        imageName: "shipit-session-worker:test",
        memoryLimit: 512 * 1024 * 1024,
        cpuQuota: 50_000,
        pidsLimit: 256,
      } as ContainerConfig;

      const creating = manager.createStandby(config);
      const settled: Promise<unknown> = (async () => {
        try { await creating; return null; } catch (e) { return e; }
      })();

      await atCreate;
      await manager.destroy(SESSION);
      release();

      expect(await settled).toBeInstanceOf(Error);
      expect(manager.isStandby(SESSION)).toBe(false);
      expect(started).toEqual([]);
    } finally {
      warn.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
