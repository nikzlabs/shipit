/**
 * Tests for the Tier C SNI proxy launch wiring (docs/172 Gap 1, SHI-90).
 */

import { describe, it, expect, vi } from "vitest";
import type Docker from "dockerode";
import {
  egressProxyEnabled,
  buildProxyAllowed,
  launchEgressProxy,
  EGRESS_PROXY_UID,
  EGRESS_PROXY_PORT,
  EGRESS_PROXY_LISTEN,
  EGRESS_PROXY_LABEL,
} from "./egress-proxy-install.js";
import { EGRESS_DEFAULT_ALLOWLIST } from "./egress-allowlist.js";

describe("egressProxyEnabled", () => {
  it("requires SESSION_EGRESS_PROXY=1 AND Tier B (DNS) AND Tier A (enforce)", () => {
    const all = { SESSION_EGRESS_PROXY: "1", SESSION_EGRESS_DNS: "1", SESSION_EGRESS_ENFORCE: "1" };
    expect(egressProxyEnabled(all as NodeJS.ProcessEnv)).toBe(true);
    expect(egressProxyEnabled({ SESSION_EGRESS_PROXY: "1", SESSION_EGRESS_DNS: "1" } as NodeJS.ProcessEnv)).toBe(false); // enforce off
    expect(egressProxyEnabled({ SESSION_EGRESS_PROXY: "1", SESSION_EGRESS_ENFORCE: "1" } as NodeJS.ProcessEnv)).toBe(false); // dns off
    expect(egressProxyEnabled({ SESSION_EGRESS_DNS: "1", SESSION_EGRESS_ENFORCE: "1" } as NodeJS.ProcessEnv)).toBe(false); // proxy off
    expect(egressProxyEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("buildProxyAllowed", () => {
  it("is the base allowlist as a space-separated string (mirrors the resolver domains)", () => {
    const allowed = buildProxyAllowed();
    const entries = allowed.split(" ");
    for (const e of EGRESS_DEFAULT_ALLOWLIST) expect(entries).toContain(e);
  });
  it("appends operator extras", () => {
    const allowed = buildProxyAllowed({ extraHosts: ["internal-registry.corp"] });
    expect(allowed.split(" ")).toContain("internal-registry.corp");
  });
});

describe("EGRESS_PROXY_LABEL", () => {
  it("is distinct from the parent-session and resolver labels (so the stale-sweep spares it)", () => {
    expect(EGRESS_PROXY_LABEL).toBe("shipit-egress-proxy");
    expect(EGRESS_PROXY_LABEL).not.toBe("shipit-parent-session");
    expect(EGRESS_PROXY_LABEL).not.toBe("shipit-egress-resolver");
  });
});

function fakeDocker() {
  const calls: { create?: unknown } = {};
  const container = { start: vi.fn(async () => undefined), id: "proxy-xyz" };
  const docker = {
    createContainer: vi.fn(async (cfg: unknown) => {
      calls.create = cfg;
      return container;
    }),
  } as unknown as Docker;
  return { docker, container, calls };
}

describe("launchEgressProxy", () => {
  it("starts a long-lived proxy in the agent netns as the proxy uid, WITHOUT NET_ADMIN", async () => {
    const { docker, container, calls } = fakeDocker();
    const id = await launchEgressProxy(docker, {
      agentContainerId: "agent123",
      sidecarImage: "egress:1",
      allowed: ".anthropic.com github.com",
      sessionId: "s1",
      labels: { "shipit-parent-session": "s1", [EGRESS_PROXY_LABEL]: "s1" },
    });
    expect(id).toBe("proxy-xyz");
    const cfg = calls.create as {
      Entrypoint: string[];
      User: string;
      HostConfig: { NetworkMode: string; CapAdd?: string[] };
      Env: string[];
      Labels: Record<string, string>;
    };
    expect(cfg.Entrypoint).toEqual(["/usr/local/bin/sni-proxy"]);
    expect(cfg.User).toBe(String(EGRESS_PROXY_UID));
    expect(cfg.HostConfig.NetworkMode).toBe("container:agent123");
    expect(cfg.HostConfig.CapAdd).toBeUndefined(); // least privilege: no NET_ADMIN
    expect(cfg.Env).toContain(`EGRESS_PROXY_LISTEN=${EGRESS_PROXY_LISTEN}`);
    expect(cfg.Env).toContain(`EGRESS_PROXY_PORT=${EGRESS_PROXY_PORT}`);
    expect(cfg.Env).toContain("EGRESS_PROXY_ALLOWED=.anthropic.com github.com");
    expect(cfg.Env).toContain("EGRESS_PROXY_SESSION_ID=s1");
    // No decision URL passed → deny-fast (no allow-once query)
    expect(cfg.Env.some((e) => e.startsWith("EGRESS_PROXY_DECISION_URL="))).toBe(false);
    expect(cfg.Labels[EGRESS_PROXY_LABEL]).toBe("s1");
    expect(container.start).toHaveBeenCalled();
  });

  it("passes the decision URL when allow-once is wired (Tier C C2)", async () => {
    const { docker, calls } = fakeDocker();
    await launchEgressProxy(docker, {
      agentContainerId: "agent123",
      sidecarImage: "egress:1",
      allowed: "github.com",
      sessionId: "s1",
      decisionUrl: "http://shipit:3000/api/egress/decision",
    });
    const cfg = calls.create as { Env: string[] };
    expect(cfg.Env).toContain("EGRESS_PROXY_DECISION_URL=http://shipit:3000/api/egress/decision");
  });
});
