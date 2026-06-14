/**
 * Tests for the Tier C allow-once policy store (docs/172, SHI-90).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  isEgressHostAllowed,
  allowEgressHost,
  shouldCardEgressHost,
  clearEgressPolicy,
  setEgressDurableSource,
  _resetEgressPolicies,
} from "./egress-policy.js";

describe("egress-policy", () => {
  beforeEach(() => {
    _resetEgressPolicies();
    setEgressDurableSource(null);
  });

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

  describe("durable source reconciliation", () => {
    it("allows a host present in the durable source even without an in-memory grant", () => {
      setEgressDurableSource((sid) => (sid === "s1" ? [".durable.example.com"] : []));
      expect(isEgressHostAllowed("s1", "api.durable.example.com")).toBe(true);
      // scoped per session — s2's durable set is empty
      expect(isEgressHostAllowed("s2", "api.durable.example.com")).toBe(false);
    });

    it("still honors in-memory allow-once grants alongside the durable source", () => {
      setEgressDurableSource(() => []);
      allowEgressHost("s1", "once.example.com");
      expect(isEgressHostAllowed("s1", "once.example.com")).toBe(true);
    });

    it("a null durable source falls back to in-memory-only (legacy behavior)", () => {
      setEgressDurableSource(null);
      expect(isEgressHostAllowed("s1", "anything.example.com")).toBe(false);
    });
  });
});
