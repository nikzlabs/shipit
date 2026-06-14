/**
 * Tests for the Tier C allow-once policy store (docs/172, SHI-90).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  isEgressHostAllowed,
  allowEgressHost,
  shouldCardEgressHost,
  clearEgressPolicy,
  _resetEgressPolicies,
} from "./egress-policy.js";

describe("egress-policy", () => {
  beforeEach(() => _resetEgressPolicies());

  it("denies unknown hosts and allows after a user decision", () => {
    expect(isEgressHostAllowed("s1", "cdn.example.com")).toBe(false);
    allowEgressHost("s1", "cdn.example.com");
    expect(isEgressHostAllowed("s1", "cdn.example.com")).toBe(true);
  });

  it("normalizes host case/trailing dot when matching", () => {
    allowEgressHost("s1", "CDN.Example.com.");
    expect(isEgressHostAllowed("s1", "cdn.example.com")).toBe(true);
  });

  it("scopes decisions per session", () => {
    allowEgressHost("s1", "x.com");
    expect(isEgressHostAllowed("s2", "x.com")).toBe(false);
  });

  it("cards a denied host once, then dedupes the retry loop", () => {
    expect(shouldCardEgressHost("s1", "x.com")).toBe(true);
    expect(shouldCardEgressHost("s1", "x.com")).toBe(false); // already carded
  });

  it("does not card a host that is already allowed", () => {
    allowEgressHost("s1", "x.com");
    expect(shouldCardEgressHost("s1", "x.com")).toBe(false);
  });

  it("clears a session's policy", () => {
    allowEgressHost("s1", "x.com");
    clearEgressPolicy("s1");
    expect(isEgressHostAllowed("s1", "x.com")).toBe(false);
  });
});
