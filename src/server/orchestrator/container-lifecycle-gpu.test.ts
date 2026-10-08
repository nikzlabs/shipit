import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Docker from "dockerode";

import { createContainer, type LifecycleDeps } from "./container-lifecycle.js";
import type { ContainerConfig } from "./session-container.js";
import { GPU_DEVICE_REQUEST } from "./session-gpu.js";
import { TEST_CREDENTIALS_DIR } from "./credentials-test-helpers.js";

/** docs/325-session-gpu-access req 1, 5 and 6, at the one place the request is made. */

const SESSION_ID = "sess-gpu";

interface Created {
  id: string;
  options: Docker.ContainerCreateOptions;
  removed: boolean;
}

function fakeDocker(startFails: (created: Created) => Error | null): { docker: Docker; created: Created[] } {
  const created: Created[] = [];
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
    getContainer: () => ({
      inspect: async () => { throw Object.assign(new Error("none"), { statusCode: 404 }); },
      stop: async () => {},
      remove: async () => {},
    }),
    createContainer: async (options: Docker.ContainerCreateOptions) => {
      const record: Created = { id: `cid-${created.length + 1}`, options, removed: false };
      created.push(record);
      return {
        id: record.id,
        start: async () => {
          const err = startFails(record);
          if (err) throw err;
        },
        remove: async () => { record.removed = true; },
        inspect: async () => ({
          Config: { Labels: {} },
          NetworkSettings: { Networks: { "shipit-net": { IPAddress: "172.20.0.9" } } },
        }),
      };
    },
  } as unknown as Docker;
  return { docker, created };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function create(docker: Docker, gpuAccess?: () => boolean) {
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
  } as unknown as ContainerConfig;
  return createContainer(deps, config);
}

const requested = (c: Created) => c.options.HostConfig?.DeviceRequests;
const env = (c: Created) => c.options.Env ?? [];

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

  it("fails with the second error when the start fails without the GPU too", async () => {
    const { docker, created } = fakeDocker((c) => new Error(requested(c) ? "gpu" : "no space left on device"));

    await expect(create(docker, () => true)).rejects.toThrow("no space left on device");
    expect(created).toHaveLength(2);
  });
});
