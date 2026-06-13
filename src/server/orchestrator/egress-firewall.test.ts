/**
 * Tests for the Tier A egress allow-set logic (docs/172 Gap 1, SHI-90).
 */

import { describe, it, expect } from "vitest";
import {
  EGRESS_TIER_A_RESOLVE_HOSTS,
  isValidIp,
  isValidCidr,
  parseGitHubMetaCidrs,
  buildIpsetMembers,
} from "./egress-firewall.js";

describe("isValidIp", () => {
  it("accepts well-formed IPv4", () => {
    expect(isValidIp("140.82.112.3")).toBe(true);
    expect(isValidIp("0.0.0.0")).toBe(true);
    expect(isValidIp("255.255.255.255")).toBe(true);
  });
  it("rejects malformed IPv4", () => {
    expect(isValidIp("256.1.1.1")).toBe(false);
    expect(isValidIp("1.2.3")).toBe(false);
    expect(isValidIp("01.2.3.4")).toBe(false); // leading zero
    expect(isValidIp("1.2.3.4.5")).toBe(false);
  });
  it("accepts plausible IPv6 and rejects junk", () => {
    expect(isValidIp("2606:50c0:8000::153")).toBe(true);
    expect(isValidIp("::1")).toBe(true);
    expect(isValidIp("not:an:ip:zz")).toBe(false); // non-hex
    expect(isValidIp("1::2::3")).toBe(false); // double "::"
    expect(isValidIp("hostname")).toBe(false);
  });
});

describe("isValidCidr", () => {
  it("accepts valid v4/v6 CIDRs with in-range prefixes", () => {
    expect(isValidCidr("140.82.112.0/20")).toBe(true);
    expect(isValidCidr("192.30.252.0/22")).toBe(true);
    expect(isValidCidr("2606:50c0::/32")).toBe(true);
    expect(isValidCidr("10.0.0.1/32")).toBe(true);
  });
  it("rejects out-of-range prefixes and bare addresses", () => {
    expect(isValidCidr("140.82.112.0/33")).toBe(false);
    expect(isValidCidr("2606:50c0::/129")).toBe(false);
    expect(isValidCidr("140.82.112.0")).toBe(false); // no prefix
    expect(isValidCidr("140.82.112.0/")).toBe(false);
    expect(isValidCidr("garbage/20")).toBe(false);
  });
});

describe("parseGitHubMetaCidrs", () => {
  it("merges web/api/git CIDRs and de-duplicates, preserving order", () => {
    const meta = {
      verifiable_password_authentication: false,
      web: ["192.30.252.0/22", "185.199.108.0/22"],
      api: ["192.30.252.0/22", "140.82.112.0/20"], // dup of web's first
      git: ["143.55.64.0/20"],
      packages: ["140.82.112.22/32"], // ignored — not web/api/git
    };
    expect(parseGitHubMetaCidrs(meta)).toEqual([
      "192.30.252.0/22",
      "185.199.108.0/22",
      "140.82.112.0/20",
      "143.55.64.0/20",
    ]);
  });

  it("includes IPv6 ranges", () => {
    const meta = { api: ["2606:50c0::/32"] };
    expect(parseGitHubMetaCidrs(meta)).toContain("2606:50c0::/32");
  });

  it("drops non-string / invalid entries without throwing", () => {
    const meta = { web: ["192.30.252.0/22", 1234, null, "not-a-cidr", "10.0.0.0/99"] };
    expect(parseGitHubMetaCidrs(meta)).toEqual(["192.30.252.0/22"]);
  });

  it("tolerates missing keys, wrong types, and non-objects", () => {
    expect(parseGitHubMetaCidrs({})).toEqual([]);
    expect(parseGitHubMetaCidrs({ web: "192.30.252.0/22" })).toEqual([]); // not an array
    expect(parseGitHubMetaCidrs(null)).toEqual([]);
    expect(parseGitHubMetaCidrs("nope")).toEqual([]);
    expect(parseGitHubMetaCidrs(undefined)).toEqual([]);
  });
});

describe("buildIpsetMembers", () => {
  it("combines resolved IPs and CIDRs, validated and de-duplicated, sorted", () => {
    const members = buildIpsetMembers({
      ips: ["140.82.112.3", "140.82.112.3", "1.2.3.4"], // dup
      cidrs: ["192.30.252.0/22"],
    });
    expect(members).toEqual(["1.2.3.4", "140.82.112.3", "192.30.252.0/22"]);
  });

  it("drops invalid IPs/CIDRs (a bad dig line must not poison the set)", () => {
    const members = buildIpsetMembers({
      ips: ["140.82.112.3", "256.0.0.1", "", "  "],
      cidrs: ["192.30.252.0/22", "10.0.0.0/99", "garbage"],
    });
    expect(members).toEqual(["140.82.112.3", "192.30.252.0/22"]);
  });

  it("handles empty input", () => {
    expect(buildIpsetMembers({})).toEqual([]);
  });
});

describe("EGRESS_TIER_A_RESOLVE_HOSTS", () => {
  it("lists concrete FQDNs (no suffix wildcards, no GitHub — that's CIDR-sourced)", () => {
    expect(EGRESS_TIER_A_RESOLVE_HOSTS.length).toBeGreaterThan(0);
    for (const h of EGRESS_TIER_A_RESOLVE_HOSTS) {
      expect(h.startsWith(".")).toBe(false); // concrete, not a suffix entry
      expect(h).not.toContain("github"); // GitHub comes from gh api meta CIDRs
    }
  });
});
