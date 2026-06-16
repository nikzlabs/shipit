/**
 * Unit tests for SessionContainerManager.
 *
 * Uses a mocked Docker client to test container lifecycle, network setup,
 * orphan cleanup, and health monitoring without a real Docker daemon.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  // docs/183 — control the worker image inspect for resolveWorkerImageId.
  // `undefined` Id models an inspect that throws (image absent).
  let imageId: string | undefined = "sha256:workerimageabc";
  let imageInspectCalls = 0;

  // docs/183 Phase 2 — track overlay volume create/remove for the mock.
  const liveVolumes = new Set<string>();
  const removedVolumes: string[] = [];
  // Names whose `getVolume().inspect()` 404s — models a volume that was never
  // provisioned (for the `requireProvisioned` compose-path filter). Inspect
  // succeeds for any other name so `resolveVolumeMountpoint` keeps working.
  const missingVolumes = new Set<string>();

  const eventEmitter = new EventEmitter();

  const mockDocker = {
    // Control
    _setPingResult: (v: boolean) => { pingResult = v; },
    _setNetworkExists: (v: boolean) => { networkExists = v; },
    _setImageId: (v: string | undefined) => { imageId = v; },
    _imageInspectCalls: () => imageInspectCalls,
    _containers: containers,
    _eventEmitter: eventEmitter,
    _liveVolumes: liveVolumes,
    _removedVolumes: removedVolumes,
    _missingVolumes: missingVolumes,

    createVolume: vi.fn(async (opts: any) => {
      liveVolumes.add(opts.Name);
      return { Name: opts.Name };
    }),
    getVolume: vi.fn((name: string) => ({
      inspect: vi.fn(async () => {
        if (missingVolumes.has(name)) {
          const err: any = new Error("no such volume"); err.statusCode = 404; throw err;
        }
        return { Name: name, Mountpoint: `/var/lib/docker/volumes/${name}/_data` };
      }),
      remove: vi.fn(async () => {
        if (!liveVolumes.has(name)) {
          const err: any = new Error("no such volume"); err.statusCode = 404; throw err;
        }
        liveVolumes.delete(name);
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

    getImage: vi.fn((_name: string) => ({
      inspect: vi.fn(async () => {
        imageInspectCalls++;
        if (imageId === undefined) throw new Error("no such image");
        return { Id: imageId };
      }),
    })),
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

  // --- resolveWorkerImageId (docs/183 — overlay runtime scope) ---

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
      mockDocker._setImageId(undefined); // inspect throws
      expect(await manager.resolveWorkerImageId()).toBeUndefined();
      // Re-flip to a real id: the cached miss must NOT trigger a re-inspect.
      mockDocker._setImageId("sha256:later");
      expect(await manager.resolveWorkerImageId()).toBeUndefined();
      expect(mockDocker._imageInspectCalls()).toBe(1);
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
              "/workspace/sessions/test-session-1:/workspace:rw",
              // docs/138 — the container gets its private per-session credentials
              // subtree, never the shared root.
              "/credentials/sessions/test-session-1:/credentials:rw",
            ]),
            Memory: 512 * 1024 * 1024,
            CpuQuota: 50_000,
            CpuPeriod: 100_000,
            PidsLimit: 256,
            NetworkMode: "shipit-test",
            SecurityOpt: ["no-new-privileges"],
            CapDrop: ["ALL"],
            CapAdd: ["CHOWN", "SETUID", "SETGID", "FOWNER", "KILL"],
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
      // docs/150 §10 — DAC_OVERRIDE + NET_BIND_SERVICE dropped after the non-root
      // migration; the entrypoint still needs CHOWN/SETUID/SETGID/FOWNER to chown
      // mounts + gosu-drop, KILL for process management.
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

  // --- docs/172 Gap 5 (SHI-97) — kernel-tier hardening (env-gated, default-OFF) ---

  describe("kernel-tier hardening", () => {
    // These hardening flags are read from process.env at create time. Snapshot
    // the whole env and restore it wholesale (avoids dynamic per-key delete).
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
      expect(Object.keys(call.HostConfig.Tmpfs).sort()).toEqual(["/home/shipit", "/run", "/tmp"]);
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

  // --- docs/183 dep-dir design — overlay sessions (N nested dep-dir mounts) ---

  describe("overlay session", () => {
    // Two declared dep dirs → two overlay volumes, each mounted NESTED under
    // /workspace at its dep-dir subpath. /workspace itself stays the normal mount.
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

      // /workspace is never sourced from an overlay volume — it stays the normal
      // host-clone mount (a volume subpath in prod, a bind in this test harness).
      const wsMount = mounts.find((m: any) => m.Target === "/workspace");
      if (wsMount) expect(overlayNames).not.toContain(wsMount.Source);

      // Each dep dir is mounted nested at its /workspace/<dep-dir> target.
      for (const spec of overlaySpecs) {
        const nested = mounts.find((m: any) => m.Target === spec.mountPath);
        expect(nested).toBeDefined();
        expect(nested.Source).toBe(spec.volumeName);
        expect(nested.Type).toBe("volume");
      }
    });

    it("removes every overlay volume when container creation fails (no leak)", async () => {
      // Regression: createOverlayVolume must run inside the try block so a
      // later failure removes the volumes instead of leaking them.
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

  // --- docs/183 Phase 3b — prepareOverlaySpecs populator ---

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
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prep-overlay-"));
      tmpDirs.push(dir);
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
      const dir = await ws({ gitignore: "node_modules\n" }); // default dep dir node_modules, ignored
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
        // Cold scope: no published base, no session overlay dirs — none exist yet.
        expect(fs.existsSync(specs[0].orchDirs!.lowerdir)).toBe(false);
        await mgr.create(mgr.buildConfigForWorkspace({
          sessionId: "cold-scope-1",
          sessionDir: dir,
          workspaceDir: dir,
          credentialsDir: "/credentials",
          overlaySpecs: specs,
        }));
        // The daemon's overlay mount ENOENTs unless all three exist — create()
        // must have provisioned them (empty lowerdir is the valid cold start).
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
      // The volume was never created (e.g. the agent container was built
      // before OVERLAY_DEP_STORE was enabled) — the compose path must not
      // reference it as `external`.
      mockDocker._missingVolumes.add(all[0].volumeName);
      const provisioned = await ovlManager.prepareOverlaySpecs({
        sessionId: "abc123def456", workspaceDir: dir, session: eligible, requireProvisioned: true,
      });
      expect(provisioned).toEqual([]);
    });

    it("requireProvisioned keeps specs whose overlay volume exists", async () => {
      process.env.OVERLAY_DEP_STORE = "1";
      const dir = await ws({ gitignore: "node_modules\n" });
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
        sessionDir: dir,
        workspaceDir: dir,
        credentialsDir: "/credentials",
        overlaySpecs,
      });
      await ovlManager.create(config);

      // The overlay volume was created…
      expect(mockDocker._liveVolumes.has(overlaySpecs[0].volumeName)).toBe(true);
      // …and mounted nested at /workspace/node_modules (NOT at the /workspace root).
      const call = mockDocker.createContainer.mock.calls.at(-1)![0];
      const nested = call.HostConfig.Mounts.find((m: any) => m.Target === "/workspace/node_modules");
      expect(nested?.Source).toBe(overlaySpecs[0].volumeName);
      const wsMount = call.HostConfig.Mounts.find((m: any) => m.Target === "/workspace");
      if (wsMount) expect(wsMount.Source).not.toBe(overlaySpecs[0].volumeName);
    });

    it("warm standby path (docs/183 Phase 7): prepareOverlaySpecs → buildConfigForWorkspace → createStandby mounts the overlay nested + records the volume", async () => {
      process.env.OVERLAY_DEP_STORE = "1";
      const dir = await ws({ gitignore: "node_modules\n" });
      // The warm pool builds the standby with this exact call shape: the warm
      // appSessionId + a repo-backed, non-ops session ({ remoteUrl, kind: undefined }).
      // A warm-claimed session reuses THIS container (keyed by appSessionId), so it
      // must already carry the overlay mounts — the one path that doesn't go through
      // createContainerForRunner.
      const appSessionId = "warm12345678";
      const overlaySpecs = await ovlManager.prepareOverlaySpecs({
        sessionId: appSessionId, workspaceDir: dir, session: eligible,
      });
      expect(overlaySpecs).toHaveLength(1);
      const config = ovlManager.buildConfigForWorkspace({
        sessionId: appSessionId, sessionDir: dir, workspaceDir: dir,
        credentialsDir: "/credentials", overlaySpecs,
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
        sessionId: "warm-off-1", sessionDir: dir, workspaceDir: dir,
        credentialsDir: "/credentials", overlaySpecs,
      });
      await ovlManager.createStandby(config);
      const call = mockDocker.createContainer.mock.calls.at(-1)![0];
      const nested = call.HostConfig.Mounts.find((m: any) => m.Target === "/workspace/node_modules");
      expect(nested).toBeUndefined();
    });

    it("drops dep dirs that fail contextual validation (tracked source)", async () => {
      process.env.OVERLAY_DEP_STORE = "1";
      // Declare `src` (tracked, not ignored) → validation drops it → no specs.
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

    // --- docs/197 Part 2 — pnpm: skip overlay, use the shared store instead ---

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
        const dir = await ws({ gitignore: "node_modules\n" }); // plain npm repo
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
      // ovlManager has a workspaceVolume but NO stateDir → undefined.
      expect(ovlManager.preparePnpmStore({ workspaceDir: dir, session: eligible })).toBeUndefined();
    });

    it("end-to-end: a pnpm session mounts the store + sets npm_config_store_dir and gets NO overlay", async () => {
      process.env.OVERLAY_DEP_STORE = "1";
      const { mgr } = managerWithState();
      try {
        const dir = await ws({ gitignore: "node_modules\n", shipitYaml: PNPM_YAML });
        const overlaySpecs = await mgr.prepareOverlaySpecs({ sessionId: "pnpm-e2e-1", workspaceDir: dir, session: eligible });
        expect(overlaySpecs).toEqual([]);
        const pnpmStoreDir = mgr.preparePnpmStore({ workspaceDir: dir, session: eligible });
        const config = mgr.buildConfigForWorkspace({
          sessionId: "pnpm-e2e-1", sessionDir: dir, workspaceDir: dir,
          credentialsDir: "/credentials", overlaySpecs, pnpmStoreDir,
        });
        await mgr.create(config);
        const call = mockDocker.createContainer.mock.calls.at(-1)![0];
        // docs/198 — the store is mounted at pnpm 11's relocation target
        // /workspace/.pnpm-store (nested under /workspace) as a Subpath of the state volume…
        const storeMount = call.HostConfig.Mounts.find((m: any) => m.Target === "/workspace/.pnpm-store");
        expect(storeMount?.Source).toBe(STATE_VOL);
        expect(storeMount?.VolumeOptions?.Subpath).toContain("pnpm-store/");
        // …and no nested node_modules overlay mount exists.
        const nested = call.HostConfig.Mounts.find((m: any) => m.Target === "/workspace/node_modules");
        expect(nested).toBeUndefined();
        // …and older pnpm is pointed at the same path via npm_config_store_dir.
        expect(call.Env).toContain("npm_config_store_dir=/workspace/.pnpm-store");
      } finally {
        await mgr.dispose();
      }
    });
  });

  // --- bootedLimits (W3) ---

  describe("bootedLimits", () => {
    it("records the resource limits the container was actually created with", async () => {
      const sc = await manager.create(buildConfig({
        memoryLimit: 3072 * 1024 * 1024,
        cpuQuota: 200_000,
        pidsLimit: 2048,
      }));

      // bootedLimits is always populated by createContainer — it's how the
      // claim-time refresh detects a standby that booted off stale config.
      expect(sc.bootedLimits).toEqual({
        memoryLimit: 3072 * 1024 * 1024,
        cpuQuota: 200_000,
        pidsLimit: 2048,
      });
      // Survives lookup via the manager map.
      expect(manager.get("test-session-1")?.bootedLimits).toEqual(sc.bootedLimits);
    });

    it("records bootedLimits even for non-docker-access sessions (unlike resourceLimits)", async () => {
      const sc = await manager.create(buildConfig());
      // resourceLimits (child-container budget) is only set for dockerAccess.
      expect(sc.resourceLimits).toBeUndefined();
      // bootedLimits is always set.
      expect(sc.bootedLimits).toEqual({
        memoryLimit: 512 * 1024 * 1024,
        cpuQuota: 50_000,
        pidsLimit: 256,
      });
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
      expect(config.memoryLimit).toBe(1536 * 1024 * 1024);
      expect(config.cpuQuota).toBe(50_000);
      expect(config.pidsLimit).toBe(4096);
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

    it("auto-restarts the Docker event stream on error so OOM detection survives daemon hiccups", async () => {
      vi.useFakeTimers();
      try {
        await manager.create(buildConfig());
        await manager.startHealthMonitor();
        expect(mockDocker.getEvents).toHaveBeenCalledTimes(1);

        // Simulate the Docker event stream dropping (daemon restart, socket
        // EAGAIN, etc.). Without auto-restart the orchestrator stops seeing
        // `container_exited` events forever.
        mockDocker._eventEmitter.emit("error", new Error("daemon went away"));

        // Restart is debounced 5s; advance through it.
        await vi.advanceTimersByTimeAsync(5_000);

        expect(mockDocker.getEvents).toHaveBeenCalledTimes(2);

        // Subsequent `die` events on the same emitter (mock returns the same
        // emitter from getEvents) should now fire `container_exited` again.
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

        // Stream dies — `lastLossAt` should latch.
        mockDocker._eventEmitter.emit("error", new Error("daemon hiccup"));
        // 5s debounce then reconnect.
        await vi.advanceTimersByTimeAsync(5_000);

        expect(mockDocker.getEvents).toHaveBeenCalledTimes(2);
        expect(resumed).toHaveBeenCalledTimes(1);
        const arg = resumed.mock.calls[0]?.[0] as { gapMs: number };
        expect(arg.gapMs).toBeGreaterThanOrEqual(5_000);

        // A second reconnect after a second loss should emit again with
        // a fresh gap (state.lastLossAt cleared after the first resume).
        mockDocker._eventEmitter.emit("error", new Error("another hiccup"));
        await vi.advanceTimersByTimeAsync(5_000);
        expect(resumed).toHaveBeenCalledTimes(2);

        // No spurious emit when there was never a loss in the first place
        // (the test setup already opened once cleanly).
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

        // Even if a stale "error" sneaks in after stop (e.g. emitted between
        // destroy() and listener removal), no restart should be scheduled.
        mockDocker._eventEmitter.emit("error", new Error("late error"));
        await vi.advanceTimersByTimeAsync(10_000);

        expect(mockDocker.getEvents).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
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

// ---------------------------------------------------------------------------
// readAgentConfig — W4a: a broken shipit.yaml falls back to defaults, LOUDLY
// ---------------------------------------------------------------------------

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
    // Malformed YAML — `: : :` is not parseable.
    fs.writeFileSync(path.join(tmpDir, "shipit.yaml"), "agent:\n  memory: [unclosed\n: : :\n");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const config = readAgentConfig(tmpDir);

    // Fallback is preserved — a broken config must not block the session.
    expect(config.agent.memory).toBe(1536);
    expect(config.agent.cpu).toBe(0.5);
    expect(config.agent.pids).toBe(4096);

    // ...but it is NOT silent: the catch logs the workspace dir + the cause
    // so a default-sized container never appears with zero trace.
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = String(errSpy.mock.calls[0]?.[0] ?? "");
    expect(logged).toContain(tmpDir);
    expect(logged).toMatch(/default agent resources/i);

    errSpy.mockRestore();
  });

  it("does not log for a genuinely-absent shipit.yaml (the common, legitimate case)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const config = readAgentConfig(tmpDir); // no shipit.yaml written

    expect(config.agent.memory).toBe(1536);
    // Absent file resolves to defaults *without* hitting the catch — only a
    // genuinely broken file is loud.
    expect(errSpy).not.toHaveBeenCalled();

    errSpy.mockRestore();
  });

  it("returns the declared values for a valid new-format shipit.yaml", () => {
    fs.writeFileSync(
      path.join(tmpDir, "shipit.yaml"),
      "agent:\n  memory: 3072\n  cpu: 2\n  pids: 2048\n",
    );
    const config = readAgentConfig(tmpDir);
    expect(config.agent).toMatchObject({ memory: 3072, cpu: 2, pids: 2048 });
  });
});

// ---------------------------------------------------------------------------
// docs/211 — sandbox Docker capability threads through buildConfigForWorkspace
// ---------------------------------------------------------------------------
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
    // An empty sandbox workspace has NO shipit.yaml, so the workspace-derived
    // dockerAccess is always false — the capability grant is the only source.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-docker-"));
  });
  afterEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await mgr.dispose();
  });

  const base = (dockerAccess?: boolean): ContainerConfig =>
    mgr.buildConfigForWorkspace({
      sessionId: "sbx123456789",
      sessionDir: tmpDir,
      workspaceDir: tmpDir,
      credentialsDir: "/credentials",
      ...(dockerAccess !== undefined ? { dockerAccess } : {}),
    });

  it("grants session-scoped dockerAccess when capabilities.docker is on (override wins over the absent shipit.yaml)", () => {
    const config = base(true);
    expect(config.dockerAccess).toBe(true);
    // A sandbox is NEVER an ops session: no host socket, no journal/host mounts.
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
