import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Docker from "dockerode";

import { createContainer, type LifecycleDeps } from "./container-lifecycle.js";
import type { ContainerConfig } from "./session-container.js";
import { GPU_DEVICE_REQUEST } from "./session-gpu.js";
import { TEST_CREDENTIALS_DIR } from "./credentials-test-helpers.js";

/** docs/325-session-gpu-access req 1, 5, 6 and 7, at the one place the request is made. */

const SESSION_ID = "sess-gpu";

interface Created {
  id: string;
  options: Docker.ContainerCreateOptions;
  removed: boolean;
}

interface FakeOpts {
  startFails: (created: Created) => Error | null;
  createFails?: (attempt: number) => Error | null;
  removeFails?: (created: Created) => boolean;
}

function fakeDocker(
  startFails: FakeOpts["startFails"],
  more: Omit<FakeOpts, "startFails"> = {},
): { docker: Docker; created: Created[]; removedById: string[] } {
  const created: Created[] = [];
  const removedById: string[] = [];
  const docker = {
    createVolume: async () => {},
    getVolume: () => ({
      inspect: async () => { throw Object.assign(new Error("none"), { statusCode: 404 }); },
      remove: async () => {},
    }),
    listContainers: async () => [],
    listNetworks: async () => [],
    listVolumes: async () => ({ Volumes: [] }),
    getNetwork: () => ({ remove: async () => {} }),
    getContainer: (id: string) => ({
      inspect: async () => { throw Object.assign(new Error("none"), { statusCode: 404 }); },
      stop: async () => {},
      remove: async () => { removedById.push(id); },
    }),
    createContainer: async (options: Docker.ContainerCreateOptions) => {
      const err = more.createFails?.(created.length + 1);
      if (err) throw err;
      const record: Created = { id: `cid-${created.length + 1}`, options, removed: false };
      created.push(record);
      return {
        id: record.id,
        start: async () => {
          const startErr = startFails(record);
          if (startErr) throw startErr;
        },
        remove: async () => {
          if (more.removeFails?.(record)) throw new Error("removal failed");
          record.removed = true;
        },
        inspect: async () => ({
          Config: { Labels: {} },
          NetworkSettings: { Networks: { "shipit-net": { IPAddress: "172.20.0.9" } } },
        }),
      };
    },
  } as unknown as Docker;
  return { docker, created, removedById };
}

const WSL2_KERNEL = "6.6.87.2-microsoft-standard-WSL2";

const tmpDirs: string[] = [];
// A WSL2 host gets one more GPU attempt, so the kernel is pinned: these tests also run on WSL2.
beforeEach(() => {
  vi.spyOn(os, "release").mockReturnValue("6.8.0-1017-azure");
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function create(docker: Docker, gpuAccess?: () => boolean, extraLabels?: Record<string, string>) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-gpu-"));
  tmpDirs.push(tmp);
  fs.mkdirSync(path.join(tmp, "session", "workspace"), { recursive: true });
  const deps = {
    docker,
    containers: new Map(),
    standbySessionIds: new Set<string>(),
    destroyEpochs: new Map<string, number>(),
    emitter: new EventEmitter(),
    baseLabels: () => ({ "shipit-managed": "true" }),
    networkName: "shipit-net",
    workerPort: 9100,
    imageName: "shipit-worker:test",
    skipHealthCheck: true,
    ...(gpuAccess ? { gpuAccess } : {}),
  } as unknown as LifecycleDeps;
  const config = {
    sessionId: SESSION_ID,
    sessionDir: path.join(tmp, "session"),
    workspaceDir: path.join(tmp, "session", "workspace"),
    sessionStateDir: path.join(tmp, "session", "state"),
    credentialsDir: TEST_CREDENTIALS_DIR,
    imageName: "shipit-worker:test",
    memoryLimit: 512 * 1024 * 1024,
    cpuQuota: 50_000,
    pidsLimit: 256,
    ...(extraLabels ? { extraLabels } : {}),
  } as unknown as ContainerConfig;
  return createContainer(deps, config);
}

const requested = (c: Created) => c.options.HostConfig?.DeviceRequests;
const env = (c: Created) => c.options.Env ?? [];
const wslBinds = (c: Created) => (c.options.HostConfig?.Binds ?? []).filter((bind) => bind.startsWith("/usr/lib/wsl/"));

describe("createContainer — the GPU", () => {
  it("asks for nothing while the switch is off", async () => {
    const { docker, created } = fakeDocker(() => null);
    const sc = await create(docker, () => false);

    expect(created).toHaveLength(1);
    expect(requested(created[0])).toBeUndefined();
    expect(env(created[0])).toContain("SHIPIT_GPU=off");
    expect(sc.gpu).toEqual({ state: "off" });
  });

  it("treats a manager with no switch as off", async () => {
    const { docker, created } = fakeDocker(() => null);
    const sc = await create(docker);

    expect(requested(created[0])).toBeUndefined();
    expect(sc.gpu).toEqual({ state: "off" });
  });

  it("asks for every GPU while the switch is on", async () => {
    const { docker, created } = fakeDocker(() => null);
    const sc = await create(docker, () => true);

    expect(created).toHaveLength(1);
    // Spelled out, so a change to the shared constant cannot pass by changing both sides.
    expect(requested(created[0])).toEqual([{ Driver: "", Count: -1, Capabilities: [["gpu"]] }]);
    expect(requested(created[0])).toEqual([GPU_DEVICE_REQUEST]);
    expect(env(created[0])).toContain("SHIPIT_GPU=granted");
    expect(sc.gpu).toEqual({ state: "granted" });
    expect(sc.id).toBe("cid-1");
  });

  it("starts without the GPU, and keeps Docker's reason, when the GPU start fails", async () => {
    const reason = 'could not select device driver "" with capabilities: [[gpu]]';
    const { docker, created } = fakeDocker((c) => (requested(c) ? new Error(`(HTTP code 500)\n${reason}`) : null));
    const sc = await create(docker, () => true);

    expect(created).toHaveLength(2);
    expect(created[0].removed).toBe(true);
    expect(requested(created[1])).toBeUndefined();
    expect(env(created[1])).toContain("SHIPIT_GPU=unavailable");
    expect(env(created[1])).toContain(`SHIPIT_GPU_REASON=(HTTP code 500) ${reason}`);
    expect(sc.gpu).toEqual({ state: "unavailable", reason: `(HTTP code 500) ${reason}` });
    expect(sc.id).toBe("cid-2");
  });

  it("starts without the GPU when Docker refuses to create the GPU attempt", async () => {
    let calls = 0;
    const { docker, created } = fakeDocker(() => null, {
      createFails: () => (++calls === 1 ? new Error("invalid mount config") : null),
    });
    const sc = await create(docker, () => true);

    expect(created).toHaveLength(1);
    expect(requested(created[0])).toBeUndefined();
    expect(sc.gpu).toEqual({ state: "unavailable", reason: "invalid mount config" });
  });

  it("removes a GPU attempt it could not remove at once, when the retry fails too", async () => {
    const { docker, created, removedById } = fakeDocker(
      (c) => (requested(c) ? new Error("gpu") : null),
      { removeFails: () => true, createFails: (attempt) => (attempt === 2 ? new Error("name already in use") : null) },
    );

    await expect(create(docker, () => true)).rejects.toThrow("name already in use");
    expect(created).toHaveLength(1);
    expect(removedById).toContain("cid-1");
  });

  it("marks a standby unclaimed from the moment it exists", async () => {
    const { docker } = fakeDocker(() => null);
    expect((await create(docker, () => false, { "shipit-standby": "true" })).standbyUnclaimed).toBe(true);
    expect((await create(fakeDocker(() => null).docker, () => false)).standbyUnclaimed).toBeUndefined();
  });

  it("fails with the second error when the start fails without the GPU too", async () => {
    const { docker, created } = fakeDocker((c) => new Error(requested(c) ? "gpu" : "no space left on device"));

    await expect(create(docker, () => true)).rejects.toThrow("no space left on device");
    expect(created).toHaveLength(2);
  });
});

describe("createContainer — WSL2 graphics for a GPU container", () => {
  beforeEach(() => {
    vi.spyOn(os, "release").mockReturnValue(WSL2_KERNEL);
  });

  it("mounts DirectX and the Windows GPU drivers read-only with the GPU", async () => {
    const { docker, created } = fakeDocker(() => null);
    await create(docker, () => true);

    expect(created).toHaveLength(1);
    expect(wslBinds(created[0])).toEqual([
      "/usr/lib/wsl/lib:/usr/lib/wsl/lib:ro",
      "/usr/lib/wsl/drivers:/usr/lib/wsl/drivers:ro",
    ]);
    expect(env(created[0]).some((entry) => entry.startsWith("SHIPIT_GPU_GRAPHICS_REASON="))).toBe(false);
  });

  it("keeps the GPU, and says why, when the container starts only without the mounts", async () => {
    const { docker, created } = fakeDocker((c) => (wslBinds(c).length > 0 ? new Error("mount\nfailed") : null));
    const sc = await create(docker, () => true);

    expect(created).toHaveLength(2);
    expect(created[0].removed).toBe(true);
    expect(requested(created[1])).toEqual([GPU_DEVICE_REQUEST]);
    expect(wslBinds(created[1])).toEqual([]);
    expect(env(created[1])).toContain("SHIPIT_GPU=granted");
    expect(env(created[1])).toContain("SHIPIT_GPU_GRAPHICS_REASON=mount failed");
    expect(sc.gpu).toEqual({ state: "granted" });
    expect(sc.id).toBe("cid-2");
  });

  it("starts without the GPU and the mounts when no GPU attempt starts", async () => {
    const { docker, created } = fakeDocker((c) => (requested(c) ? new Error("no driver") : null));
    const sc = await create(docker, () => true);

    expect(created).toHaveLength(3);
    expect(created.slice(0, 2).every((c) => c.removed)).toBe(true);
    expect(requested(created[2])).toBeUndefined();
    expect(wslBinds(created[2])).toEqual([]);
    expect(env(created[2])).toContain("SHIPIT_GPU_REASON=no driver");
    expect(env(created[2]).some((entry) => entry.startsWith("SHIPIT_GPU_GRAPHICS_REASON="))).toBe(false);
    expect(sc.gpu).toEqual({ state: "unavailable", reason: "no driver" });
  });

  it("mounts neither while the switch is off", async () => {
    const { docker, created } = fakeDocker(() => null);
    await create(docker, () => false);

    expect(wslBinds(created[0])).toEqual([]);
  });

  it("mounts neither on a host that is not WSL2", async () => {
    vi.spyOn(os, "release").mockReturnValue("6.8.0-1017-azure");
    const { docker, created } = fakeDocker(() => null);
    await create(docker, () => true);

    expect(requested(created[0])).toEqual([GPU_DEVICE_REQUEST]);
    expect(wslBinds(created[0])).toEqual([]);
  });
});
