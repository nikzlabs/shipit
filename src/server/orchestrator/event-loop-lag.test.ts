import { describe, expect, it } from "vitest";
import { lagWarning, startEventLoopLagMonitor } from "./event-loop-lag.js";

const ms = (n: number) => n * 1e6;
const context = { processCpuPercent: 97.4, load1: 41.23 };

function fakeHistogram(p99Ms: number, maxMs: number, meanMs = 1) {
  return { percentile: () => ms(p99Ms), max: ms(maxMs), mean: ms(meanMs) };
}

describe("lagWarning", () => {
  it("stays silent when p99 and max are under their thresholds", () => {
    expect(lagWarning(fakeHistogram(50, 400), 10_000, context, 200, 1_000)).toBeNull();
  });

  it("warns when p99 is over its threshold, with process CPU and host load", () => {
    expect(lagWarning(fakeHistogram(350, 600, 40), 10_000, context, 200, 1_000))
      .toMatch(/^\[event-loop\] lag over 10s: p99=350ms max=600ms mean=40ms cpu=97% load1=41\.2\/\d+$/);
  });

  it("warns on one long stall that p99 does not show", () => {
    expect(lagWarning(fakeHistogram(30, 5_000), 10_000, context, 200, 1_000)).toContain("max=5000ms");
  });
});

describe("startEventLoopLagMonitor", () => {
  it("reports a real stall of the main thread", async () => {
    const lines: string[] = [];
    const stop = startEventLoopLagMonitor({
      windowMs: 600, p99WarnMs: 10_000, maxWarnMs: 150, warn: (line) => lines.push(line),
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const end = Date.now() + 400;
      while (Date.now() < end) { /* block the event loop */ }
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]).toMatch(/^\[event-loop\] lag over 1s: p99=\d+ms max=\d+ms mean=\d+ms cpu=\d+% load1=/);
    } finally {
      stop();
    }
  });
});
