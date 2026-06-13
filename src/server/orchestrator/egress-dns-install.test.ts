/**
 * Tests for the Tier B resolver launch wiring (docs/172 Gap 1, SHI-90).
 */

import { describe, it, expect, vi } from "vitest";
import type Docker from "dockerode";
import {
  egressDnsEnabled,
  orchestratorInternalNames,
  buildResolverConfigB64,
  launchEgressResolver,
  EGRESS_DNS_DEFAULT_UPSTREAMS,
} from "./egress-dns-install.js";

describe("egressDnsEnabled", () => {
  it("requires BOTH SESSION_EGRESS_DNS=1 and SESSION_EGRESS_ENFORCE=1", () => {
    expect(egressDnsEnabled({ SESSION_EGRESS_DNS: "1", SESSION_EGRESS_ENFORCE: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(egressDnsEnabled({ SESSION_EGRESS_DNS: "1" } as NodeJS.ProcessEnv)).toBe(false); // enforce off
    expect(egressDnsEnabled({ SESSION_EGRESS_ENFORCE: "1" } as NodeJS.ProcessEnv)).toBe(false); // dns off
    expect(egressDnsEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("orchestratorInternalNames", () => {
  it("returns DNS-resolvable names, skipping IP literals", () => {
    const names = orchestratorInternalNames({
      SHIPIT_ORCHESTRATOR_HOST: "shipit-orch",
      SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS: "orch2 10.0.0.5",
    } as NodeJS.ProcessEnv);
    expect(names).toContain("shipit-orch");
    expect(names).toContain("orch2");
    expect(names).not.toContain("10.0.0.5"); // IP literal — no DNS needed
  });
  it("is empty when nothing is configured", () => {
    expect(orchestratorInternalNames({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe("buildResolverConfigB64", () => {
  it("encodes a dnsmasq config that allowlists the base domains + extras", () => {
    const b64 = buildResolverConfigB64({ extraDomains: ["internal-registry.corp"] });
    const cfg = Buffer.from(b64, "base64").toString("utf-8");
    expect(cfg).toContain(`server=/anthropic.com/${  EGRESS_DNS_DEFAULT_UPSTREAMS[0]}`);
    expect(cfg).toContain("server=/internal-registry.corp/");
    expect(cfg).toContain("no-resolv"); // no default upstream → tunneling closed
  });
  it("includes internal names routed to Docker DNS without an ipset pin", () => {
    const cfg = Buffer.from(buildResolverConfigB64({ internalDomains: ["shipit-orch"] }), "base64").toString("utf-8");
    expect(cfg).toContain("server=/shipit-orch/127.0.0.11");
    expect(cfg).not.toContain("ipset=/shipit-orch/");
  });
});

function fakeDocker() {
  const calls: { create?: unknown } = {};
  const container = { start: vi.fn(async () => undefined), id: "resolver-xyz" };
  const docker = {
    createContainer: vi.fn(async (cfg: unknown) => {
      calls.create = cfg;
      return container;
    }),
  } as unknown as Docker;
  return { docker, container, calls };
}

describe("launchEgressResolver", () => {
  it("starts a long-lived resolver in the agent netns with the config + NET_ADMIN", async () => {
    const { docker, container, calls } = fakeDocker();
    const id = await launchEgressResolver(docker, {
      agentContainerId: "agent123",
      sidecarImage: "egress:1",
      configB64: "Y29uZmln",
      labels: { "shipit-parent-session": "s1" },
    });
    expect(id).toBe("resolver-xyz");
    const cfg = calls.create as {
      Entrypoint: string[];
      HostConfig: { NetworkMode: string; CapAdd: string[] };
      Env: string[];
      Labels: Record<string, string>;
    };
    expect(cfg.Entrypoint).toEqual(["/usr/local/bin/run-resolver.sh"]);
    expect(cfg.HostConfig.NetworkMode).toBe("container:agent123");
    expect(cfg.HostConfig.CapAdd).toEqual(["NET_ADMIN"]);
    expect(cfg.Env).toContain("EGRESS_DNSMASQ_CONFIG_B64=Y29uZmln");
    expect(cfg.Labels["shipit-parent-session"]).toBe("s1");
    expect(container.start).toHaveBeenCalled();
  });
});
