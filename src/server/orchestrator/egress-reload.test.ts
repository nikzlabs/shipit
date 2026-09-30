import { describe, it, expect, vi } from "vitest";
import type Docker from "dockerode";
import { reloadEgressSidecars, staleEgressSidecars } from "./egress-reload.js";
import { buildResolverConfigB64, EGRESS_RESOLVER_LABEL, OPS_DOCKER_PROXY_DNS_NAME } from "./egress-dns-install.js";
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
    const b64 = (cfg.Env ?? []).find((e) => e.startsWith("EGRESS_DNSMASQ_CONFIG_B64="))?.split("=")[1] ?? "";
    expect(Buffer.from(b64, "base64").toString("utf-8")).toContain("new.example.com");
  });

  it("re-emits the docker-socket-proxy resolver rule for an ops session (planning#92)", async () => {
    const { docker, created } = fakeDocker([{ Id: "old-resolver" }]);
    await reloadEgressSidecars({ docker, ...baseOpts, opsSession: true, reloadResolver: true, reloadProxy: false });
    const b64 = (created[0].Env ?? []).find((e) => e.startsWith("EGRESS_DNSMASQ_CONFIG_B64="))?.split("=")[1] ?? "";
    const cfg = Buffer.from(b64, "base64").toString("utf-8");
    expect(cfg).toContain(`server=/${OPS_DOCKER_PROXY_DNS_NAME}/127.0.0.11`);
  });

  it("does NOT emit the proxy rule for a non-ops reload", async () => {
    const { docker, created } = fakeDocker([{ Id: "old-resolver" }]);
    await reloadEgressSidecars({ docker, ...baseOpts, opsSession: false, reloadResolver: true, reloadProxy: false });
    const b64 = (created[0].Env ?? []).find((e) => e.startsWith("EGRESS_DNSMASQ_CONFIG_B64="))?.split("=")[1] ?? "";
    expect(Buffer.from(b64, "base64").toString("utf-8")).not.toContain(OPS_DOCKER_PROXY_DNS_NAME);
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

/** planning#626 — a kept agent's sidecars keep the names ShipIt had when it started them. */
describe("staleEgressSidecars", () => {
  const RESOLVER = `${EGRESS_RESOLVER_LABEL}=s1`;
  const PROXY = `${EGRESS_PROXY_LABEL}=s1`;
  const CURRENT_URL = "http://new-host:4123/api/egress/decision";

  function sidecarDocker(sidecars: { label: string; env: string[] }[]) {
    const docker = {
      listContainers: vi.fn(async (opts: { filters: { label: string[] } }) =>
        sidecars.flatMap((s, i) => (s.label === opts.filters.label[0] ? [{ Id: `sidecar-${i}` }] : []))),
      getContainer: vi.fn((id: string) => ({
        inspect: vi.fn(async () => ({ Config: { Env: sidecars[Number(id.slice("sidecar-".length))].env } })),
      })),
    };
    return docker as unknown as Docker & { listContainers: ReturnType<typeof vi.fn> };
  }

  const resolverEnv = (names: string[]) => [
    `EGRESS_DNSMASQ_CONFIG_B64=${buildResolverConfigB64({ internalDomains: names, extraDomains: ["fal.run"] })}`,
  ];
  const check = (docker: Docker, overrides: { internalNames?: string[]; decisionUrl?: string } = {}) =>
    staleEgressSidecars(docker, {
      sessionId: "s1",
      agentContainerId: "agent1",
      internalNames: ["new-host", "shipit"],
      decisionUrl: CURRENT_URL,
      ...overrides,
    });

  it("finds a resolver that forwards only the previous ShipIt's hostname", async () => {
    const docker = sidecarDocker([{ label: RESOLVER, env: resolverEnv(["old-host"]) }]);
    await expect(check(docker)).resolves.toEqual({ resolver: true, proxy: false });
  });

  it("finds a resolver that lacks the worker's fallback name", async () => {
    const docker = sidecarDocker([{ label: RESOLVER, env: resolverEnv(["new-host"]) }]);
    await expect(check(docker)).resolves.toMatchObject({ resolver: true });
  });

  it("accepts a resolver that forwards every current name, as after a plain restart", async () => {
    const docker = sidecarDocker([{ label: RESOLVER, env: resolverEnv(["new-host", "shipit"]) }]);
    await expect(check(docker)).resolves.toEqual({ resolver: false, proxy: false });
  });

  it("finds a proxy that asks the previous ShipIt for decisions", async () => {
    const docker = sidecarDocker([
      { label: PROXY, env: ["EGRESS_PROXY_DECISION_URL=http://old-host:4123/api/egress/decision"] },
    ]);
    await expect(check(docker)).resolves.toEqual({ resolver: false, proxy: true });
  });

  it("accepts a proxy that asks this process", async () => {
    const docker = sidecarDocker([{ label: PROXY, env: [`EGRESS_PROXY_DECISION_URL=${CURRENT_URL}`] }]);
    await expect(check(docker)).resolves.toEqual({ resolver: false, proxy: false });
  });

  it("reports nothing stale where there is no sidecar to replace", async () => {
    await expect(check(sidecarDocker([]))).resolves.toEqual({ resolver: false, proxy: false });
  });

  it("does not look for a tier this install does not run", async () => {
    const docker = sidecarDocker([{ label: RESOLVER, env: resolverEnv(["old-host"]) }]);
    await expect(check(docker, { internalNames: undefined, decisionUrl: undefined }))
      .resolves.toEqual({ resolver: false, proxy: false });
    expect(docker.listContainers).not.toHaveBeenCalled();
  });
});
