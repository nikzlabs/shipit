import { describe, it, expect } from "vitest";
import { SessionContainerManager } from "./session-container.js";
import { gpuEnv, GPU_DEVICE_REQUEST, type SessionGpu } from "./session-gpu.js";

/**
 * docs/325-session-gpu-access: an adopted container keeps the GPU state it started with, and a
 * standby made under the other switch value is out of date (req 5).
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

async function adopted(started: SessionGpu, switchOn: boolean) {
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
  return manager;
}

describe("SessionContainerManager — GPU state", () => {
  it("reads it back from an adopted container", async () => {
    expect((await adopted({ state: "granted" }, true)).get(SESSION_ID)?.gpu).toEqual({ state: "granted" });
    expect((await adopted({ state: "unavailable", reason: "no driver" }, true)).get(SESSION_ID)?.gpu)
      .toEqual({ state: "unavailable", reason: "no driver" });
    expect((await adopted({ state: "off" }, false)).get(SESSION_ID)?.gpu).toEqual({ state: "off" });
  });

  it("calls a container out of date when it asked for the GPU under the other switch value", async () => {
    expect((await adopted({ state: "off" }, true)).gpuOutOfDate(SESSION_ID)).toBe(true);
    expect((await adopted({ state: "granted" }, false)).gpuOutOfDate(SESSION_ID)).toBe(true);
    expect((await adopted({ state: "unavailable", reason: "no driver" }, false)).gpuOutOfDate(SESSION_ID)).toBe(true);
  });

  it("keeps a container whose request matches the switch, even one that could not get the GPU", async () => {
    expect((await adopted({ state: "off" }, false)).gpuOutOfDate(SESSION_ID)).toBe(false);
    expect((await adopted({ state: "granted" }, true)).gpuOutOfDate(SESSION_ID)).toBe(false);
    expect((await adopted({ state: "unavailable", reason: "no driver" }, true)).gpuOutOfDate(SESSION_ID)).toBe(false);
  });

  it("has nothing to compare for a session with no container", async () => {
    const manager = await adopted({ state: "off" }, true);
    expect(manager.gpuOutOfDate("another-session")).toBe(false);
  });
});
