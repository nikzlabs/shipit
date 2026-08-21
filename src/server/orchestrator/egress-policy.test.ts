/**
 * Tests for the Tier C allow-once policy store (docs/172, planning#92).
 */

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

  /**
   * docs/262 req 24 — the enumerator a plugin container's launcher needs,
   * because its SNI proxy is on a network denied ShipIt's whole API and so
   * cannot ask the decision endpoint one host at a time.
   */
  describe("listEgressAllowedHosts", () => {
    it("lists this session's in-memory decisions, normalized and scoped", () => {
      allowEgressHost("s1", "API.Example.Com");
      allowEgressHost("s1", "other.example");
      allowEgressHost("s2", "elsewhere.example");

      expect(listEgressAllowedHosts("s1").sort()).toEqual(["api.example.com", "other.example"]);
      expect(listEgressAllowedHosts("s3")).toEqual([]);
    });

    // Deliberately NOT reconciled with the durable source, unlike
    // `isEgressHostAllowed`: an ordinary caller already carries the durable
    // hosts in its `ResolvedEgressConfig.extraHosts`, and a second copy is a
    // second thing to drift — while a docs/211 sandbox's config carries none of
    // them, which is why the two are not interchangeable (planning#380).
    it("leaves the durable source to the caller's own config", () => {
      setEgressDurableSource(() => [".durable.example.com"]);
      expect(listEgressAllowedHosts("s1")).toEqual([]);
      expect(isEgressHostAllowed("s1", "api.durable.example.com")).toBe(true);
    });
  });

  /**
   * planning#380 — the predicate half of the same rule, for a reader asking what
   * a session actually reaches rather than what the decision point answers.
   */
  describe("isEgressAllowOnceHost", () => {
    it("answers from the in-memory set alone, ignoring the durable source", () => {
      setEgressDurableSource(() => [".durable.example.com"]);
      allowEgressHost("s1", "once.example.com");
      expect(isEgressAllowOnceHost("s1", "once.example.com")).toBe(true);
      // The divergence that matters: a docs/211 sandbox holds this durable entry
      // in the store and never in its own resolved config.
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
