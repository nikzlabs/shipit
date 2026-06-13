/**
 * Tests for the Tier B controlled-resolver config (docs/172 Gap 1, SHI-90).
 */

import { describe, it, expect } from "vitest";
import {
  allowlistEntryToDomain,
  buildDnsmasqConfig,
  EGRESS_IPSET_V4,
  EGRESS_IPSET_V6,
} from "./egress-dns.js";

describe("allowlistEntryToDomain", () => {
  it("strips a leading dot from suffix entries and normalizes", () => {
    expect(allowlistEntryToDomain(".anthropic.com")).toBe("anthropic.com");
    expect(allowlistEntryToDomain("chatgpt.com")).toBe("chatgpt.com");
    expect(allowlistEntryToDomain(".GitHub.COM")).toBe("github.com");
  });
});

describe("buildDnsmasqConfig", () => {
  const base = { publicDomains: [".anthropic.com", "github.com"], publicUpstreams: ["1.1.1.1"] };

  it("forwards each allowlisted public domain to the upstream", () => {
    const cfg = buildDnsmasqConfig(base);
    expect(cfg).toContain("server=/anthropic.com/1.1.1.1");
    expect(cfg).toContain("server=/github.com/1.1.1.1");
  });

  it("pins resolved IPs of allowlisted domains into the egress ipset", () => {
    const cfg = buildDnsmasqConfig(base);
    expect(cfg).toContain(`ipset=/anthropic.com/${EGRESS_IPSET_V4},${EGRESS_IPSET_V6}`);
    expect(cfg).toContain(`ipset=/github.com/${EGRESS_IPSET_V4},${EGRESS_IPSET_V6}`);
  });

  it("has NO default server (the property that closes DNS tunneling)", () => {
    const cfg = buildDnsmasqConfig(base);
    expect(cfg).toContain("no-resolv");
    // every server= line is domain-scoped (server=/<domain>/...), none is a bare default
    const serverLines = cfg.split("\n").filter((l) => l.startsWith("server="));
    expect(serverLines.length).toBeGreaterThan(0);
    expect(serverLines.every((l) => /^server=\/[^/]+\//.test(l))).toBe(true);
  });

  it("routes internal names to Docker embedded DNS, WITHOUT an ipset pin", () => {
    const cfg = buildDnsmasqConfig({ ...base, internalDomains: ["orch.internal"] });
    expect(cfg).toContain("server=/orch.internal/127.0.0.11");
    // internal domain must not be pinned to the firewall set
    expect(cfg).not.toContain("ipset=/orch.internal/");
  });

  it("supports multiple upstreams per domain", () => {
    const cfg = buildDnsmasqConfig({ publicDomains: ["github.com"], publicUpstreams: ["1.1.1.1", "8.8.8.8"] });
    expect(cfg).toContain("server=/github.com/1.1.1.1");
    expect(cfg).toContain("server=/github.com/8.8.8.8");
  });

  it("de-duplicates domains and drops the leading dot consistently", () => {
    const cfg = buildDnsmasqConfig({ publicDomains: [".github.com", "github.com"], publicUpstreams: ["1.1.1.1"] });
    expect(cfg.split("\n").filter((l) => l === `ipset=/github.com/${  EGRESS_IPSET_V4  },${  EGRESS_IPSET_V6}`)).toHaveLength(1);
  });

  it("drops to the resolver user (for the firewall owner-match)", () => {
    expect(buildDnsmasqConfig(base)).toContain("user=egressdns");
  });

  it("throws if no upstream is given", () => {
    expect(() => buildDnsmasqConfig({ publicDomains: ["github.com"], publicUpstreams: [] })).toThrow(/upstream/);
  });
});
