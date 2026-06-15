/**
 * Tests for the egress reload seam (docs/172 Gap 1, SHI-90) — relaunching the
 * Tier B resolver + Tier C proxy after a durable allowlist add, without a
 * container restart. Pure orchestration; the in-netns swap is verified live.
 */

import { describe, it, expect, vi } from "vitest";
import type Docker from "dockerode";
import { reloadEgressSidecars } from "./egress-reload.js";
import { EGRESS_RESOLVER_LABEL } from "./egress-dns-install.js";
import { EGRESS_PROXY_LABEL } from "./egress-proxy-install.js";

interface CreatedContainer {
  Image: string;
  Entrypoint?: string[];
  Labels?: Record<string, string>;
  HostConfig?: { NetworkMode?: string; CapAdd?: string[] };
  Env?: string[];
}

function fakeDocker(existing: { Id: string }[] = []) {
  const removed: string[] = [];
  const created: CreatedContainer[] = [];
  const listFilters: unknown[] = [];
  const docker = {
    listContainers: vi.fn(async (opts: { filters?: unknown }) => {
      listFilters.push(opts.filters);
      return existing;
    }),
    getContainer: vi.fn((id: string) => ({
      remove: vi.fn(async () => {
        removed.push(id);
      }),
    })),
    createContainer: vi.fn(async (cfg: CreatedContainer) => {
      created.push(cfg);
      return { id: `new-${created.length}`, start: vi.fn(async () => undefined) };
    }),
  } as unknown as Docker;
  return { docker, removed, created, listFilters };
}

const baseOpts = {
  agentContainerId: "agent1",
  sessionId: "s1",
  sidecarImage: "egress:dev",
  extraHosts: ["new.example.com"],
  baseLabels: { "shipit-session": "true" },
};

describe("reloadEgressSidecars", () => {
  it("removes the old resolver + relaunches it with the new domains when reloadResolver", async () => {
    const { docker, removed, created } = fakeDocker([{ Id: "old-resolver" }]);
    await reloadEgressSidecars({ docker, ...baseOpts, reloadResolver: true, reloadProxy: false });

    expect(removed).toContain("old-resolver");
    expect(created).toHaveLength(1);
    const cfg = created[0];
    expect(cfg.Entrypoint).toEqual(["/usr/local/bin/run-resolver.sh"]);
    expect(cfg.HostConfig?.NetworkMode).toBe("container:agent1");
    expect(cfg.Labels?.[EGRESS_RESOLVER_LABEL]).toBe("s1");
    // The regenerated dnsmasq config (base64) embeds the new host's domain.
    const b64 = (cfg.Env ?? []).find((e) => e.startsWith("EGRESS_DNSMASQ_CONFIG_B64="))?.split("=")[1] ?? "";
    expect(Buffer.from(b64, "base64").toString("utf-8")).toContain("new.example.com");
  });

  it("removes the old proxy + relaunches it with the new allowlist when reloadProxy", async () => {
    const { docker, removed, created } = fakeDocker([{ Id: "old-proxy" }]);
    await reloadEgressSidecars({ docker, ...baseOpts, reloadResolver: false, reloadProxy: true, orchPort: "3000" });

    expect(removed).toContain("old-proxy");
    expect(created).toHaveLength(1);
    const cfg = created[0];
    expect(cfg.Entrypoint).toEqual(["/usr/local/bin/sni-proxy"]);
    expect(cfg.Labels?.[EGRESS_PROXY_LABEL]).toBe("s1");
    const allowed = (cfg.Env ?? []).find((e) => e.startsWith("EGRESS_PROXY_ALLOWED="))?.slice("EGRESS_PROXY_ALLOWED=".length) ?? "";
    expect(allowed.split(" ")).toContain("new.example.com");
  });

  it("reloads both tiers when both flags are set", async () => {
    const { docker, created } = fakeDocker();
    await reloadEgressSidecars({ docker, ...baseOpts, reloadResolver: true, reloadProxy: true });
    const entrypoints = created.map((c) => c.Entrypoint?.[0]);
    expect(entrypoints).toContain("/usr/local/bin/run-resolver.sh");
    expect(entrypoints).toContain("/usr/local/bin/sni-proxy");
  });

  it("is a no-op create when neither flag is set", async () => {
    const { docker, created, removed } = fakeDocker();
    await reloadEgressSidecars({ docker, ...baseOpts, reloadResolver: false, reloadProxy: false });
    expect(created).toHaveLength(0);
    expect(removed).toHaveLength(0);
  });
});
