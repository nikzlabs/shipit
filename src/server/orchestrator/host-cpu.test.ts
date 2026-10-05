import { describe, it, expect } from "vitest";
import type os from "node:os";
import { createHostCpuSampler } from "./host-cpu.js";

function core(busy: number, idle: number): os.CpuInfo {
  // Spread over every busy field so a sampler that forgets one reads low.
  const share = busy / 4;
  return { model: "fake", speed: 0, times: { user: share, nice: share, sys: share, irq: share, idle } };
}

function samplerOver(readings: os.CpuInfo[][]): ReturnType<typeof createHostCpuSampler> {
  let next = 0;
  return createHostCpuSampler(() => readings[Math.min(next++, readings.length - 1)]);
}

describe("createHostCpuSampler", () => {
  it("reports the busy share of all cores together, not of one core", () => {
    const sample = samplerOver([
      [core(0, 0), core(0, 0), core(0, 0), core(0, 0)],
      // One core flat out, three idle: a quarter of the machine.
      [core(1000, 0), core(0, 1000), core(0, 1000), core(0, 1000)],
    ]);

    expect(sample()).toEqual({ usedPercent: 25, cores: 4 });
  });

  it("measures each window from the previous call, not from process start", () => {
    const sample = samplerOver([
      [core(0, 0), core(0, 0)],
      [core(1000, 0), core(1000, 0)],
      [core(1000, 1000), core(1000, 1000)],
    ]);

    expect(sample()?.usedPercent).toBe(100);
    expect(sample()?.usedPercent).toBe(0);
  });

  it("has no reading when no time passed between two calls", () => {
    const sample = samplerOver([[core(500, 500)], [core(500, 500)]]);

    expect(sample()).toBeNull();
  });

  it("skips the window in which the core count changed, then recovers", () => {
    const sample = samplerOver([
      [core(0, 0), core(0, 0)],
      [core(100, 100), core(100, 100), core(100, 100), core(100, 100)],
      [core(200, 100), core(200, 100), core(200, 100), core(200, 100)],
    ]);

    expect(sample()).toBeNull();
    expect(sample()).toEqual({ usedPercent: 100, cores: 4 });
  });

  it("has no reading on a platform that lists no cores", () => {
    const sample = samplerOver([[], []]);

    expect(sample()).toBeNull();
  });
});
