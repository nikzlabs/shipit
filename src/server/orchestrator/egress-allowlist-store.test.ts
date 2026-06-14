/**
 * Tests for the durable egress allowlist + containment store (docs/172, SHI-90).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { EgressAllowlistStore, EGRESS_GLOBAL_SCOPE } from "./egress-allowlist-store.js";

describe("EgressAllowlistStore", () => {
  let dbManager: DatabaseManager;
  let store: EgressAllowlistStore;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
    store = new EgressAllowlistStore(dbManager);
  });

  afterEach(() => {
    dbManager.close();
  });

  describe("allowlist hosts", () => {
    it("adds, lists, and removes hosts per scope", () => {
      expect(store.addHost(EGRESS_GLOBAL_SCOPE, "api.example.com")).toBe(true);
      expect(store.addHost(EGRESS_GLOBAL_SCOPE, ".cdn.example.com")).toBe(true);
      expect(store.listHosts(EGRESS_GLOBAL_SCOPE)).toEqual(["api.example.com", ".cdn.example.com"]);

      expect(store.removeHost(EGRESS_GLOBAL_SCOPE, "api.example.com")).toBe(true);
      expect(store.listHosts(EGRESS_GLOBAL_SCOPE)).toEqual([".cdn.example.com"]);
    });

    it("normalizes case + trailing dot and preserves a leading dot (suffix)", () => {
      store.addHost(EGRESS_GLOBAL_SCOPE, "API.Example.Com.");
      store.addHost(EGRESS_GLOBAL_SCOPE, ".Sub.Example.com");
      expect(store.listHosts(EGRESS_GLOBAL_SCOPE)).toEqual(["api.example.com", ".sub.example.com"]);
    });

    it("is idempotent — re-adding a host returns false and does not duplicate", () => {
      expect(store.addHost(EGRESS_GLOBAL_SCOPE, "x.com")).toBe(true);
      expect(store.addHost(EGRESS_GLOBAL_SCOPE, "x.com")).toBe(false);
      expect(store.listHosts(EGRESS_GLOBAL_SCOPE)).toEqual(["x.com"]);
    });

    it("rejects a blank host", () => {
      expect(store.addHost(EGRESS_GLOBAL_SCOPE, "   ")).toBe(false);
      expect(store.listHosts(EGRESS_GLOBAL_SCOPE)).toEqual([]);
    });

    it("scopes hosts per session and merges global + session in effectiveHosts", () => {
      store.addHost(EGRESS_GLOBAL_SCOPE, "global.example.com");
      store.addHost("session-1", "session.example.com");
      store.addHost("session-2", "other.example.com");

      expect(store.listHosts("session-1")).toEqual(["session.example.com"]);
      expect(store.effectiveHosts("session-1")).toEqual(["global.example.com", "session.example.com"]);
      // session-2's host is not visible to session-1.
      expect(store.effectiveHosts("session-1")).not.toContain("other.example.com");
    });

    it("de-dupes a host present in both global and session scope", () => {
      store.addHost(EGRESS_GLOBAL_SCOPE, "dup.example.com");
      store.addHost("session-1", "dup.example.com");
      expect(store.effectiveHosts("session-1")).toEqual(["dup.example.com"]);
    });
  });

  describe("containment toggle", () => {
    it("defaults the global switch to Contained (true) when unset — fail-secure", () => {
      expect(store.getGlobalEnabled()).toBe(true);
    });

    it("persists the global switch", () => {
      store.setGlobalEnabled(false);
      expect(store.getGlobalEnabled()).toBe(false);
      store.setGlobalEnabled(true);
      expect(store.getGlobalEnabled()).toBe(true);
    });

    it("returns null for an unset session override (inherit)", () => {
      expect(store.getSessionOverride("session-1")).toBeNull();
    });

    it("persists and clears a session override", () => {
      store.setSessionOverride("session-1", false);
      expect(store.getSessionOverride("session-1")).toBe(false);
      store.setSessionOverride("session-1", true);
      expect(store.getSessionOverride("session-1")).toBe(true);
      store.setSessionOverride("session-1", null);
      expect(store.getSessionOverride("session-1")).toBeNull();
    });
  });

  describe("resolveContained", () => {
    it("defaults to Contained (no global, no override)", () => {
      expect(store.resolveContained("session-1")).toBe(true);
    });

    it("inherits the global switch when there is no override", () => {
      store.setGlobalEnabled(false);
      expect(store.resolveContained("session-1")).toBe(false);
    });

    it("lets a session override win over the global switch in both directions", () => {
      store.setGlobalEnabled(false); // global Open
      store.setSessionOverride("session-1", true); // force Contained
      expect(store.resolveContained("session-1")).toBe(true);

      store.setGlobalEnabled(true); // global Contained
      store.setSessionOverride("session-2", false); // force Open
      expect(store.resolveContained("session-2")).toBe(false);
    });
  });

  describe("clearSession", () => {
    it("drops the session's hosts + override but leaves global intact", () => {
      store.addHost(EGRESS_GLOBAL_SCOPE, "global.example.com");
      store.addHost("session-1", "session.example.com");
      store.setSessionOverride("session-1", false);

      store.clearSession("session-1");

      expect(store.listHosts("session-1")).toEqual([]);
      expect(store.getSessionOverride("session-1")).toBeNull();
      expect(store.listHosts(EGRESS_GLOBAL_SCOPE)).toEqual(["global.example.com"]);
    });
  });
});
