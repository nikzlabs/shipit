import { describe, it, expect } from "vitest";
import { gpuEnv, gpuFromContainer, gpuReason, gpuRequestRefusal, noGpuWhy } from "./session-gpu.js";

describe("gpuFromContainer — an adopted container's state", () => {
  it("reads the state each create leaves on the container", () => {
    expect(gpuFromContainer({ DeviceRequests: [{ Count: -1 }] }, ["SHIPIT_GPU=granted"])).toEqual({ state: "granted" });
    expect(gpuFromContainer({}, gpuEnv({ state: "unavailable", reason: "no driver" })))
      .toEqual({ state: "unavailable", reason: "no driver" });
    expect(gpuFromContainer({ DeviceRequests: null }, gpuEnv({ state: "off" }))).toEqual({ state: "off" });
  });

  it("reads a container from before the switch existed as off", () => {
    expect(gpuFromContainer(undefined, undefined)).toEqual({ state: "off" });
  });
});

describe("gpuReason", () => {
  it("keeps Docker's error on one line, and bounded", () => {
    expect(gpuReason(new Error("line one\n  line two"))).toBe("line one line two");
    expect(gpuReason(new Error("x".repeat(900)))).toHaveLength(501);
    expect(gpuReason(new Error(""))).toBe("Docker gave no reason");
  });
});

describe("noGpuWhy", () => {
  it("names the switch, or the reason the container recorded", () => {
    expect(noGpuWhy(undefined)).toContain("GPU access is off");
    expect(noGpuWhy({ state: "off" })).toContain("GPU access is off");
    expect(noGpuWhy({ state: "unavailable", reason: "no driver" })).toContain("no driver");
  });
});

describe("gpuRequestRefusal", () => {
  const check = (request: Partial<Parameters<typeof gpuRequestRefusal>[0]>) =>
    gpuRequestRefusal({ driver: undefined, capabilities: undefined, options: undefined, capabilitiesRequired: true, ...request });

  it("accepts NVIDIA GPU requests", () => {
    expect(check({ capabilities: [["gpu"]] })).toBeNull();
    expect(check({ driver: "nvidia", capabilities: [["gpu", "compute", "utility"]] })).toBeNull();
    expect(check({ driver: "", capabilities: [["gpu"]], options: {} })).toBeNull();
    expect(check({ capabilitiesRequired: false })).toBeNull();
  });

  it("refuses anything that would reach another device", () => {
    expect(check({ driver: "cdi", capabilities: [["gpu"]] })).toContain("driver `cdi`");
    expect(check({ capabilities: [["gpu"]], options: { a: "b" } })).toContain("options");
    expect(check({})).toContain("`gpu` capability");
    expect(check({ capabilities: [["compute"]] })).toContain("`gpu` capability");
    expect(check({ capabilities: [["gpu"], ["tpu"]] })).toContain("capability `tpu`");
    expect(check({ capabilities: ["gpu"] })).toContain("list of names");
    expect(check({ capabilities: "gpu" })).toContain("must be a list");
  });
});
