import { describe, it, expect, beforeEach } from "vitest";
import {
  isEgressHostAllowed,
  isEgressAllowOnceHost,
  allowEgressHost,
  shouldCardEgressHost,
  clearEgressPolicy,
  setEgressDurableSource,
  listEgressAllowedHosts,
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
    expect(shouldCardEgressHost("s1", "x.com")).toBe(false);
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

  describe("listEgressAllowedHosts", () => {
    it("lists this session's in-memory decisions, normalized and scoped", () => {
      allowEgressHost("s1", "API.Example.Com");
      allowEgressHost("s1", "other.example");
      allowEgressHost("s2", "elsewhere.example");

      expect(listEgressAllowedHosts("s1").sort()).toEqual(["api.example.com", "other.example"]);
      expect(listEgressAllowedHosts("s3")).toEqual([]);
    });

    it("leaves the durable source to the caller's own config", () => {
      setEgressDurableSource(() => [".durable.example.com"]);
      expect(listEgressAllowedHosts("s1")).toEqual([]);
      expect(isEgressHostAllowed("s1", "api.durable.example.com")).toBe(true);
    });
  });

  describe("isEgressAllowOnceHost", () => {
    it("answers from the in-memory set alone, ignoring the durable source", () => {
      setEgressDurableSource(() => [".durable.example.com"]);
      allowEgressHost("s1", "once.example.com");
      expect(isEgressAllowOnceHost("s1", "once.example.com")).toBe(true);
      expect(isEgressAllowOnceHost("s1", "api.durable.example.com")).toBe(false);
      expect(isEgressHostAllowed("s1", "api.durable.example.com")).toBe(true);
    });

    it("normalizes and scopes like the reconciled predicate", () => {
      allowEgressHost("s1", ".Fal.Run.");
      expect(isEgressAllowOnceHost("s1", "cdn.fal.run")).toBe(true);
      expect(isEgressAllowOnceHost("s2", "cdn.fal.run")).toBe(false);
    });
  });

  describe("durable source reconciliation", () => {
    it("allows a host present in the durable source even without an in-memory grant", () => {
      setEgressDurableSource((sid) => (sid === "s1" ? [".durable.example.com"] : []));
      expect(isEgressHostAllowed("s1", "api.durable.example.com")).toBe(true);
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
