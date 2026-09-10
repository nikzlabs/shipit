
import { describe, it, expect } from "vitest";
import {
  SERVICE_REQUEST_TIMEOUTS_MS,
  serviceRequestTimeoutMs,
  serviceTimeoutMessage,
} from "./service-request-timeouts.js";

describe("serviceRequestTimeoutMs", () => {
  it("gives start and restart minutes, not the read actions' 60s", () => {
    expect(serviceRequestTimeoutMs("start")).toBe(600_000);
    expect(serviceRequestTimeoutMs("restart")).toBe(600_000);
    expect(serviceRequestTimeoutMs("start")).toBeGreaterThan(serviceRequestTimeoutMs("list"));
  });

  it("keeps the read actions cheap", () => {
    expect(serviceRequestTimeoutMs("list")).toBe(60_000);
    expect(serviceRequestTimeoutMs("logs")).toBe(60_000);
  });

  it("gives stop room for compose's SIGTERM grace period", () => {
    expect(serviceRequestTimeoutMs("stop")).toBe(120_000);
  });

  it("falls back to 60s for an unrecognized action", () => {
    expect(serviceRequestTimeoutMs("frobnicate")).toBe(60_000);
  });

  it("lets a caller lower the deadline", () => {
    expect(serviceRequestTimeoutMs("start", 30_000)).toBe(30_000);
  });

  it("clamps a caller trying to raise it past the ceiling", () => {
    expect(serviceRequestTimeoutMs("start", 99_999_999)).toBe(600_000);
    expect(serviceRequestTimeoutMs("list", 600_000)).toBe(60_000);
  });

  it("ignores a nonsensical caller value", () => {
    expect(serviceRequestTimeoutMs("start", 0)).toBe(600_000);
    expect(serviceRequestTimeoutMs("start", -5)).toBe(600_000);
    expect(serviceRequestTimeoutMs("start", Number.NaN)).toBe(600_000);
  });

  it("every declared action has a positive timeout", () => {
    for (const [action, ms] of Object.entries(SERVICE_REQUEST_TIMEOUTS_MS)) {
      expect(ms, action).toBeGreaterThan(0);
    }
  });
});

describe("serviceTimeoutMessage", () => {
  it("tells the caller a timed-out start is STILL RUNNING, and how to check", () => {
    const msg = serviceTimeoutMessage("start", 600_000);
    expect(msg).toContain("still running");
    expect(msg).toContain("shipit service list");
    expect(msg).toContain("shipit service logs");
    expect(msg).toContain("600s");
  });

  it("says the same for restart", () => {
    expect(serviceTimeoutMessage("restart", 600_000)).toContain("still running");
  });

  it("stays terse for actions that are genuinely just slow", () => {
    const msg = serviceTimeoutMessage("list", 60_000);
    expect(msg).toBe("Service list request timed out after 60s.");
  });
});
