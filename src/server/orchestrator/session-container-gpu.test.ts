import { describe, it, expect } from "vitest";
import { SessionContainerManager } from "./session-container.js";
import { gpuEnv, GPU_DEVICE_REQUEST, type SessionGpu } from "./session-gpu.js";

/**
 * docs/325-session-gpu-access: an adopted container keeps the GPU state it started with, and an
 * unclaimed standby made under the other switch value is out of date (req 5).
 */

const SESSION_ID = "sess-gpu-adopt";
const NETWORK = "shipit-test";

function dockerWith(started: SessionGpu) {
  return {
    listContainers: async () => [{ Id: "agent-1", Labels: { "shipit-session-id": SESSION_ID }, State: "running" }],
    getContainer: () => ({
      inspect: async () => ({
        HostConfig: started.state === "granted" ? { DeviceRequests: [GPU_DEVICE_REQUEST] } : {},
        Config: { Env: gpuEnv(started) },
        NetworkSettings: { Networks: { [NETWORK]: { IPAddress: "172.18.0.7" } } },
      }),
      update: async () => ({}),
    }),
  };
}

async function adopted(started: SessionGpu, switchOn: boolean, opts: { standby?: boolean } = {}) {
  const manager = new SessionContainerManager({
    docker: dockerWith(started) as never,
    imageName: "shipit-session-worker:test",
    networkName: NETWORK,
    skipHealthCheck: true,
    gpuAccess: () => switchOn,
  });
  await manager.rediscover(new Set([SESSION_ID]), () => ({
    workspaceDir: `/workspace/sessions/${SESSION_ID}/workspace`,
    dockerAccess: false,
  }));
  // Adoption never restores standby status; a fresh standby create sets this flag.
  if (opts.standby) manager.get(SESSION_ID)!.standbyUnclaimed = true;
  return manager;
}

describe("SessionContainerManager — GPU state", () => {
  it("reads it back from an adopted container", async () => {
    expect((await adopted({ state: "granted" }, true)).get(SESSION_ID)?.gpu).toEqual({ state: "granted" });
    expect((await adopted({ state: "unavailable", reason: "no driver" }, true)).get(SESSION_ID)?.gpu)
      .toEqual({ state: "unavailable", reason: "no driver" });
    expect((await adopted({ state: "off" }, false)).get(SESSION_ID)?.gpu).toEqual({ state: "off" });
  });

  it("calls an unclaimed standby out of date when it asked for the GPU under the other switch value", async () => {
    const standby = { standby: true };
    expect((await adopted({ state: "off" }, true, standby)).standbyGpuOutOfDate(SESSION_ID)).toBe(true);
    expect((await adopted({ state: "granted" }, false, standby)).standbyGpuOutOfDate(SESSION_ID)).toBe(true);
    expect((await adopted({ state: "unavailable", reason: "x" }, false, standby)).standbyGpuOutOfDate(SESSION_ID))
      .toBe(true);
  });

  it("keeps a standby whose request matches the switch, even one that could not get the GPU", async () => {
    const standby = { standby: true };
    expect((await adopted({ state: "off" }, false, standby)).standbyGpuOutOfDate(SESSION_ID)).toBe(false);
    expect((await adopted({ state: "granted" }, true, standby)).standbyGpuOutOfDate(SESSION_ID)).toBe(false);
    expect((await adopted({ state: "unavailable", reason: "x" }, true, standby)).standbyGpuOutOfDate(SESSION_ID))
      .toBe(false);
  });

  it("leaves a session's own container alone, and a standby once claimed", async () => {
    expect((await adopted({ state: "off" }, true)).standbyGpuOutOfDate(SESSION_ID)).toBe(false);

    // A claim can land before `createStandby` registers the standby; it must still end the standby.
    const manager = await adopted({ state: "off" }, true, { standby: true });
    expect(manager.claimStandby(SESSION_ID)).toBeUndefined();
    expect(manager.standbyGpuOutOfDate(SESSION_ID)).toBe(false);
    expect(manager.standbyGpuOutOfDate("another-session")).toBe(false);
  });

  it("answers the GPU decision at once when it is known, and at the container's start when not", async () => {
    const manager = await adopted({ state: "granted" }, true);
    await expect(manager.gpuDecision(SESSION_ID)).resolves.toEqual({ state: "granted" });

    const sc = manager.get(SESSION_ID)!;
    sc.gpu = undefined;
    let settled: SessionGpu | undefined | "pending" = "pending";
    const waiting = (async () => { settled = await manager.gpuDecision(SESSION_ID, 5_000); })();
    manager.emit("container_started", "other-session");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe("pending");

    sc.gpu = { state: "unavailable", reason: "no driver" };
    manager.emit("container_started", SESSION_ID);
    await waiting;
    expect(settled).toEqual({ state: "unavailable", reason: "no driver" });

    await expect(manager.gpuDecision("never-session", 10)).resolves.toBeUndefined();
  });
});
