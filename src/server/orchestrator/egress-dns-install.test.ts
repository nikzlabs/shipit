/**
 * Tests for the Tier B resolver launch wiring (docs/172 Gap 1, SHI-90).
 */

import os from "node:os";
import { describe, it, expect, vi } from "vitest";
import type Docker from "dockerode";
import {
  egressDnsEnabled,
  orchestratorInternalNames,
  orchestratorCallbackHost,
  buildResolverConfigB64,
  launchEgressResolver,
  EGRESS_DNS_DEFAULT_UPSTREAMS,
  EGRESS_RESOLVER_LABEL,
} from "./egress-dns-install.js";

describe("egressDnsEnabled", () => {
  it("is ON by default (with enforcement on by default)", () => {
    expect(egressDnsEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(egressDnsEnabled({ SESSION_EGRESS_DNS: "1", SESSION_EGRESS_ENFORCE: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });
  it("is disabled by an explicit SESSION_EGRESS_DNS=0", () => {
    expect(egressDnsEnabled({ SESSION_EGRESS_DNS: "0" } as NodeJS.ProcessEnv)).toBe(false);
  });
  it("requires Tier A — resolves OFF when enforcement is opted out", () => {
    expect(egressDnsEnabled({ SESSION_EGRESS_ENFORCE: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(egressDnsEnabled({ SESSION_EGRESS_DNS: "1", SESSION_EGRESS_ENFORCE: "0" } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("orchestratorCallbackHost", () => {
  it("prefers SHIPIT_ORCHESTRATOR_HOST, else falls back to os.hostname()", () => {
    expect(orchestratorCallbackHost({ SHIPIT_ORCHESTRATOR_HOST: "shipit" } as NodeJS.ProcessEnv)).toBe("shipit");
    expect(orchestratorCallbackHost({} as NodeJS.ProcessEnv)).toBe(os.hostname());
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
  it("falls back to os.hostname() when *_ORCHESTRATOR_* is unset, matching SHIPIT_HOST", () => {
    // The bug from SHI-90 Tier B host verification: an unset SHIPIT_ORCHESTRATOR_HOST
    // used to yield [] here while SHIPIT_HOST was still set to os.hostname(), so the
    // resolver allowlisted nothing and the callback channel broke. Now they agree.
    expect(orchestratorInternalNames({} as NodeJS.ProcessEnv)).toEqual([os.hostname()]);
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

describe("EGRESS_RESOLVER_LABEL", () => {
  it("is a distinct label from shipit-parent-session (so the compose stale-sweep can spare it)", () => {
    expect(EGRESS_RESOLVER_LABEL).toBe("shipit-egress-resolver");
    expect(EGRESS_RESOLVER_LABEL).not.toBe("shipit-parent-session");
  });
});

describe("launchEgressResolver", () => {
  it("starts a long-lived resolver in the agent netns with the config + NET_ADMIN", async () => {
    const { docker, container, calls } = fakeDocker();
    const id = await launchEgressResolver(docker, {
      agentContainerId: "agent123",
      sidecarImage: "egress:1",
      configB64: "Y29uZmln",
      labels: { "shipit-parent-session": "s1", [EGRESS_RESOLVER_LABEL]: "s1" },
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
    // Carries the distinct resolver label so killStaleContainers spares it.
    expect(cfg.Labels[EGRESS_RESOLVER_LABEL]).toBe("s1");
    expect(container.start).toHaveBeenCalled();
  });
});
