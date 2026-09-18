import { describe, it, expect } from "vitest";
import { createSessionLoopDetector } from "./loop-detector.js";

describe("SessionLoopDetector", () => {
  function withFakeClock() {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
  }

  it("does not alert below the threshold", () => {
    const clock = withFakeClock();
    const d = createSessionLoopDetector({ threshold: 3, windowMs: 60_000, now: clock.now });
    expect(d.recordContainerStarted("s1")).toBeNull();
    clock.advance(1_000);
    expect(d.recordContainerStarted("s1")).toBeNull();
    expect(d.countInWindow("s1")).toBe(2);
  });

  it("alerts when threshold reached within window", () => {
    const clock = withFakeClock();
    const d = createSessionLoopDetector({ threshold: 3, windowMs: 60_000, cooldownMs: 60_000, now: clock.now });
    expect(d.recordContainerStarted("s1")).toBeNull();
    clock.advance(1_000);
    expect(d.recordContainerStarted("s1")).toBeNull();
    clock.advance(1_000);
    const alert = d.recordContainerStarted("s1");
    expect(alert).toMatchObject({
      sessionId: "s1",
      countInWindow: 3,
      threshold: 3,
      windowMs: 60_000,
    });
  });

  it("respects per-session alert cooldown", () => {
    const clock = withFakeClock();
    const d = createSessionLoopDetector({ threshold: 3, windowMs: 60_000, cooldownMs: 30_000, now: clock.now });
    for (let i = 0; i < 3; i++) {
      d.recordContainerStarted("s1");
      clock.advance(1_000);
    }
    const second = d.recordContainerStarted("s1");
    expect(second).toBeNull();
    clock.advance(30_000);
    const third = d.recordContainerStarted("s1");
    expect(third).not.toBeNull();
  });

  it("drops events outside the window", () => {
    const clock = withFakeClock();
    const d = createSessionLoopDetector({ threshold: 3, windowMs: 60_000, now: clock.now });
    d.recordContainerStarted("s1");
    d.recordContainerStarted("s1");
    clock.advance(70_000);
    expect(d.countInWindow("s1")).toBe(0);
    expect(d.recordContainerStarted("s1")).toBeNull();
  });

  it("tracks sessions independently", () => {
    const clock = withFakeClock();
    const d = createSessionLoopDetector({ threshold: 3, windowMs: 60_000, now: clock.now });
    expect(d.recordContainerStarted("s1")).toBeNull();
    expect(d.recordContainerStarted("s2")).toBeNull();
    expect(d.recordContainerStarted("s1")).toBeNull();
    expect(d.recordContainerStarted("s2")).toBeNull();
    expect(d.recordContainerStarted("s1")).not.toBeNull();
    expect(d.recordContainerStarted("s2")).not.toBeNull();
  });

  it("forget() clears per-session state", () => {
    const clock = withFakeClock();
    const d = createSessionLoopDetector({ threshold: 3, windowMs: 60_000, cooldownMs: 60_000, now: clock.now });
    d.recordContainerStarted("s1");
    d.recordContainerStarted("s1");
    d.forget("s1");
    expect(d.countInWindow("s1")).toBe(0);
    expect(d.recordContainerStarted("s1")).toBeNull();
    expect(d.recordContainerStarted("s1")).toBeNull();
    expect(d.recordContainerStarted("s1")).not.toBeNull();
  });
});
