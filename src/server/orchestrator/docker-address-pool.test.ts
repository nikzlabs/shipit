import { describe, it, expect, vi, afterEach } from "vitest";
import { BUILT_IN_POOL_NETWORKS, addressPoolNetworks, warnIfAddressPoolIsSmall } from "./docker-address-pool.js";

describe("addressPoolNetworks", () => {
  it("is the daemon's built-in count when no pool is configured", () => {
    expect(addressPoolNetworks(undefined)).toBe(BUILT_IN_POOL_NETWORKS);
    expect(addressPoolNetworks(null)).toBe(BUILT_IN_POOL_NETWORKS);
    expect(addressPoolNetworks([])).toBe(BUILT_IN_POOL_NETWORKS);
  });

  it("counts the networks of the pool the VPS setup script configures", () => {
    expect(addressPoolNetworks([{ Base: "172.16.0.0/12", Size: 24 }])).toBe(4096);
  });

  it("adds the pools together", () => {
    expect(addressPoolNetworks([
      { Base: "10.10.0.0/16", Size: 24 },
      { Base: "10.20.0.0/16", Size: 20 },
    ])).toBe(256 + 16);
  });

  it("does not count an IPv6 pool as IPv4 capacity", () => {
    expect(addressPoolNetworks([{ Base: "fd00::/48", Size: 64 }])).toBe(BUILT_IN_POOL_NETWORKS);
  });

  it("is null for a pool it cannot read", () => {
    expect(addressPoolNetworks([{ Base: "10.10.0.0", Size: 24 }])).toBeNull();
    expect(addressPoolNetworks([{ Base: "10.10.0.0/24", Size: 16 }])).toBeNull();
  });
});

describe("warnIfAddressPoolIsSmall", () => {
  afterEach(() => vi.restoreAllMocks());

  it("warns on a daemon with the default pools, and names both places the setting lives", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await warnIfAddressPoolIsSmall({ info: async () => ({ DefaultAddressPools: null }) });

    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0][0]);
    expect(text).toContain("Settings → Docker Engine");
    expect(text).toContain("/etc/docker/daemon.json");
  });

  it("is silent on a daemon with a wider pool", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await warnIfAddressPoolIsSmall({
      info: async () => ({ DefaultAddressPools: [{ Base: "172.16.0.0/12", Size: 24 }] }),
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("does not fail the start when Docker does not answer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(warnIfAddressPoolIsSmall({
      info: async () => { throw new Error("daemon unreachable"); },
    })).resolves.toBeUndefined();
  });
});
