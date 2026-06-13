/**
 * Tests for the Tier A egress install wiring (docs/172 Gap 1, SHI-90).
 *
 * Covers the unit-testable seams: the flag gate, the GitHub-meta fetch
 * (parse / cache / fallback), the allow-set inputs, and the installer's env
 * construction + fail-closed behavior (via a fake Docker). The actual
 * iptables/netns application is verified on a live host, not here.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type Docker from "dockerode";
import {
  egressEnforceEnabled,
  fetchGitHubMetaCidrs,
  buildTierAEgressInputs,
  installEgressFirewall,
  _resetEgressCidrCache,
} from "./egress-firewall-install.js";
import { EGRESS_GITHUB_CIDRS_FALLBACK, EGRESS_TIER_A_RESOLVE_HOSTS } from "./egress-firewall.js";

beforeEach(() => _resetEgressCidrCache());

// ---------------------------------------------------------------------------
// Flag gate
// ---------------------------------------------------------------------------

describe("egressEnforceEnabled", () => {
  it("is OFF by default and for any value other than '1'", () => {
    expect(egressEnforceEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(egressEnforceEnabled({ SESSION_EGRESS_ENFORCE: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(egressEnforceEnabled({ SESSION_EGRESS_ENFORCE: "true" } as NodeJS.ProcessEnv)).toBe(false);
  });
  it("is ON only for exactly '1'", () => {
    expect(egressEnforceEnabled({ SESSION_EGRESS_ENFORCE: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fetchGitHubMetaCidrs
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe("fetchGitHubMetaCidrs", () => {
  it("parses + validates a live meta response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ web: ["192.30.252.0/22"], api: ["140.82.112.0/20"], git: ["143.55.64.0/20"] }),
    );
    const cidrs = await fetchGitHubMetaCidrs({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(cidrs).toEqual(["140.82.112.0/20", "143.55.64.0/20", "192.30.252.0/22"]); // sorted, deduped
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("caches within the TTL (no second fetch)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ api: ["140.82.112.0/20"] }));
    const now = vi.fn(() => 1000);
    await fetchGitHubMetaCidrs({ fetchImpl: fetchImpl as unknown as typeof fetch, now });
    await fetchGitHubMetaCidrs({ fetchImpl: fetchImpl as unknown as typeof fetch, now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the TTL expires", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ api: ["140.82.112.0/20"] }));
    let t = 1000;
    const now = () => t;
    await fetchGitHubMetaCidrs({ fetchImpl: fetchImpl as unknown as typeof fetch, now, ttlMs: 100 });
    t += 200;
    await fetchGitHubMetaCidrs({ fetchImpl: fetchImpl as unknown as typeof fetch, now, ttlMs: 100 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("falls back to baked-in CIDRs on network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const cidrs = await fetchGitHubMetaCidrs({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(cidrs).toEqual([...EGRESS_GITHUB_CIDRS_FALLBACK]);
  });

  it("falls back on non-2xx and on an empty/garbage parse", async () => {
    const err = await fetchGitHubMetaCidrs({
      fetchImpl: (async () => jsonResponse({}, false, 503)) as unknown as typeof fetch,
    });
    expect(err).toEqual([...EGRESS_GITHUB_CIDRS_FALLBACK]);
    _resetEgressCidrCache();
    const empty = await fetchGitHubMetaCidrs({
      fetchImpl: (async () => jsonResponse({ web: ["not-a-cidr"] })) as unknown as typeof fetch,
    });
    expect(empty).toEqual([...EGRESS_GITHUB_CIDRS_FALLBACK]);
  });
});

// ---------------------------------------------------------------------------
// buildTierAEgressInputs
// ---------------------------------------------------------------------------

describe("buildTierAEgressInputs", () => {
  it("returns the concrete resolve-hosts plus fetched CIDRs", async () => {
    const inputs = await buildTierAEgressInputs({
      fetchImpl: (async () => jsonResponse({ api: ["140.82.112.0/20"] })) as unknown as typeof fetch,
    });
    expect(inputs.hosts).toEqual([...EGRESS_TIER_A_RESOLVE_HOSTS]);
    expect(inputs.cidrs).toContain("140.82.112.0/20");
  });
});

// ---------------------------------------------------------------------------
// installEgressFirewall (fake Docker)
// ---------------------------------------------------------------------------

function fakeDocker(exitCode: number) {
  const calls: { create?: unknown } = {};
  const container = {
    start: vi.fn(async () => undefined),
    wait: vi.fn(async () => ({ StatusCode: exitCode })),
    logs: vi.fn(async () => Buffer.from("installer log")),
    remove: vi.fn(async () => undefined),
  };
  const docker = {
    createContainer: vi.fn(async (cfg: unknown) => {
      calls.create = cfg;
      return container;
    }),
  } as unknown as Docker;
  return { docker, container, calls };
}

describe("installEgressFirewall", () => {
  const inputs = { hosts: ["api.anthropic.com"], cidrs: ["140.82.112.0/20"] };

  it("launches the sidecar in the agent netns with NET_ADMIN and the allow-set env", async () => {
    const { docker, container, calls } = fakeDocker(0);
    await installEgressFirewall(docker, { agentContainerId: "agent123", sidecarImage: "egress:1", inputs });

    const cfg = calls.create as {
      Image: string;
      HostConfig: { NetworkMode: string; CapAdd: string[] };
      Env: string[];
    };
    expect(cfg.Image).toBe("egress:1");
    expect(cfg.HostConfig.NetworkMode).toBe("container:agent123");
    expect(cfg.HostConfig.CapAdd).toEqual(["NET_ADMIN"]);
    expect(cfg.Env).toContain("EGRESS_ALLOWED_HOSTS=api.anthropic.com");
    expect(cfg.Env).toContain("EGRESS_ALLOWED_CIDRS=140.82.112.0/20");
    expect(container.start).toHaveBeenCalled();
    expect(container.remove).toHaveBeenCalled(); // cleaned up
  });

  it("throws (fail-closed) when the installer exits non-zero, and still removes the sidecar", async () => {
    const { docker, container } = fakeDocker(1);
    await expect(
      installEgressFirewall(docker, { agentContainerId: "a", sidecarImage: "egress:1", inputs }),
    ).rejects.toThrow(/exited 1/);
    expect(container.remove).toHaveBeenCalled();
  });
});
