import { describe, it, expect } from "vitest";
import { capabilitiesPendingRestart, describeCapabilityChanges } from "./sandbox-capabilities.js";
import type { SessionCapabilities } from "../shared/types.js";

const caps = (over: Partial<SessionCapabilities> = {}): SessionCapabilities => ({
  git: false,
  docker: false,
  network: true,
  dangerousGitHubOps: false,
  ...over,
});

describe("capabilitiesPendingRestart", () => {
  it("is false when the live container's grants are unknown", () => {
    expect(capabilitiesPendingRestart(null, caps({ docker: true }))).toBe(false);
    expect(capabilitiesPendingRestart(undefined, caps({ docker: true }))).toBe(false);
  });

  it("is false when nothing changed", () => {
    expect(capabilitiesPendingRestart(caps(), caps())).toBe(false);
  });

  it.each([
    ["docker granted", caps(), caps({ docker: true })],
    ["docker revoked", caps({ docker: true }), caps()],
    ["network revoked", caps(), caps({ network: false })],
    ["network granted", caps({ network: false }), caps()],
  ])("pends for a container-plumbed grant: %s", (_label, started, next) => {
    expect(capabilitiesPendingRestart(started, next)).toBe(true);
  });

  it.each([
    ["git granted", caps(), caps({ git: true })],
    ["git revoked", caps({ git: true }), caps()],
    ["merge sub-grant granted", caps({ git: true }), caps({ git: true, dangerousGitHubOps: true })],
    ["merge sub-grant revoked", caps({ git: true, dangerousGitHubOps: true }), caps({ git: true })],
  ])("does not pend for a broker-side grant while Network is on: %s", (_label, started, next) => {
    expect(capabilitiesPendingRestart(started, next)).toBe(false);
  });

  it("pends for a git flip when Network is off, because the lifeline allowlist changes", () => {
    const off = caps({ network: false });
    expect(capabilitiesPendingRestart(off, caps({ network: false, git: true }))).toBe(true);
    expect(capabilitiesPendingRestart(caps({ network: false, git: true }), off)).toBe(true);
  });

  it("does not pend for the merge sub-grant when Network is off", () => {
    const started = caps({ network: false, git: true });
    const next = caps({ network: false, git: true, dangerousGitHubOps: true });
    expect(capabilitiesPendingRestart(started, next)).toBe(false);
  });
});

describe("describeCapabilityChanges", () => {
  it("returns only the grants that moved, labelled and directional", () => {
    expect(describeCapabilityChanges(caps(), caps({ docker: true, network: false }))).toEqual([
      { label: "Docker access", from: "off", to: "on", granted: true },
      { label: "Network access", from: "on", to: "off", granted: false },
    ]);
  });

  it("is empty when nothing moved, so a no-op save writes no card", () => {
    expect(describeCapabilityChanges(caps({ git: true }), caps({ git: true }))).toEqual([]);
  });
});
