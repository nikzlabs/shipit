import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { reloadEgressSidecars, containComposeServices, allowEgressToSubnets, installEgressFirewall } =
  vi.hoisted(() => ({
    reloadEgressSidecars: vi.fn(async () => {}),
    containComposeServices: vi.fn(async () => {}),
    allowEgressToSubnets: vi.fn(async (_d: unknown, o: { subnets: string[] }) => o.subnets),
    installEgressFirewall: vi.fn(async (_d: unknown, _o: { inputs: { cidrs: string[] } }) => {}),
  }));
vi.mock("./egress-reload.js", () => ({ reloadEgressSidecars }));
vi.mock("./egress-firewall-install.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, allowEgressToSubnets, installEgressFirewall };
});
vi.mock("./compose-service-egress.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, containComposeServices };
});

import { SessionContainerManager } from "./session-container.js";
import type { ResolvedEgressConfig } from "./egress-allowlist.js";

const SESSION_ID = "sess-reload-1";
const NETWORK = "shipit-test";

function createMockDocker() {
  return {
    ping: vi.fn(async () => true),
    listContainers: vi.fn(async () => [
      { Id: "agent-container-1", Labels: { "shipit-session-id": SESSION_ID }, State: "running" },
    ]),
    getContainer: vi.fn(() => ({
      inspect: vi.fn(async () => ({
        NetworkSettings: { Networks: { [NETWORK]: { IPAddress: "172.18.0.7" } } },
      })),
    })),
  };
}

async function buildManager(config: ResolvedEgressConfig | (() => ResolvedEgressConfig)) {
  const docker = createMockDocker();
  const manager = new SessionContainerManager({
    docker: docker as never,
    imageName: "shipit-session-worker:test",
    networkName: NETWORK,
    skipHealthCheck: true,
    stackName: "shipit-test",
    resolveEgressConfig: () => (typeof config === "function" ? config() : config),
  });
  await manager.rediscover(new Set([SESSION_ID]), () => ({
    workspaceDir: `/workspace/sessions/${SESSION_ID}/workspace`,
    dockerAccess: false,
  }));
  return manager;
}

describe("reloadEgress — the return value is the agent's reload (planning#380)", () => {
  let savedEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.SESSION_EGRESS_ENFORCE = "1";
    process.env.SESSION_EGRESS_SIDECAR_IMAGE = "shipit-egress-sidecar:test";
    reloadEgressSidecars.mockClear();
    containComposeServices.mockClear();
    allowEgressToSubnets.mockClear();
    installEgressFirewall.mockClear();
  });
  afterEach(() => {
    process.env = savedEnv;
  });

  it("reloads the agent's sidecars and reports it", async () => {
    const manager = await buildManager({ contained: true, extraHosts: ["fal.run"] });
    await expect(manager.reloadEgress(SESSION_ID)).resolves.toBe(true);
    expect(reloadEgressSidecars).toHaveBeenCalledTimes(1);
  });

  it("reports false when the agent container is not running, service refresh notwithstanding", async () => {
    const manager = await buildManager({ contained: true, extraHosts: ["fal.run"] });
    manager.get(SESSION_ID)!.status = "stopped";

    await expect(manager.reloadEgress(SESSION_ID)).resolves.toBe(false);
    expect(reloadEgressSidecars).not.toHaveBeenCalled();
    expect(containComposeServices).toHaveBeenCalledTimes(1);
  });

  it("declines entirely for an Open session", async () => {
    const manager = await buildManager({ contained: false, extraHosts: [] });
    await expect(manager.reloadEgress(SESSION_ID)).resolves.toBe(false);
    expect(reloadEgressSidecars).not.toHaveBeenCalled();
    expect(containComposeServices).not.toHaveBeenCalled();
  });

  it("declines when the deployment cannot enforce", async () => {
    process.env.SESSION_EGRESS_ENFORCE = "0";
    const manager = await buildManager({ contained: true, extraHosts: [] });
    await expect(manager.reloadEgress(SESSION_ID)).resolves.toBe(false);
    expect(reloadEgressSidecars).not.toHaveBeenCalled();
  });

  /*
    A reload replaces the resolver and proxy with the CURRENTLY resolved policy,
    so what the container shuts out changes without a restart. The record has to
    move with it: `services/settings-read.ts` tells the user whether the egress
    allowlist is doing anything to this session, and a record frozen at creation
    would have it describing a policy that was replaced (docs/299 req 3).
  */
  it("records the exclusion the reload actually applied", async () => {
    const manager = await buildManager({
      contained: true, extraHosts: [], base: ["lifeline.example"], userHostsExcluded: true,
    });
    // Rediscovered, so nothing is recorded until something is applied.
    expect(manager.get(SESSION_ID)?.egressUserHostsExcluded).toBeUndefined();

    await manager.reloadEgress(SESSION_ID);

    expect(manager.get(SESSION_ID)?.egressUserHostsExcluded).toBe(true);
  });

  it("records the ordinary allowlist coming back, not only the sealing", async () => {
    const manager = await buildManager({ contained: true, extraHosts: ["fal.run"] });
    await manager.reloadEgress(SESSION_ID);
    expect(manager.get(SESSION_ID)?.egressUserHostsExcluded).toBe(false);
  });

  it("records nothing when no reload reached the container", async () => {
    const manager = await buildManager({
      contained: true, extraHosts: [], userHostsExcluded: true,
    });
    manager.get(SESSION_ID)!.status = "stopped";

    await manager.reloadEgress(SESSION_ID);

    expect(manager.get(SESSION_ID)?.egressUserHostsExcluded).toBeUndefined();
  });
});

/**
 * docs/305 — an IP-literal SSH destination is admitted by the Tier A ipset, and
 * `allowEgressToSubnets` can only ADD to it. So a revoke has to rebuild the
 * firewall; otherwise the address stays reachable — with any credential, not
 * just ShipIt's — until the namespace is recreated.
 */
describe("reloadEgress — SSH CIDR grants", () => {
  let savedEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.SESSION_EGRESS_ENFORCE = "1";
    process.env.SESSION_EGRESS_SIDECAR_IMAGE = "shipit-egress-sidecar:test";
    allowEgressToSubnets.mockClear();
    installEgressFirewall.mockClear();
  });
  afterEach(() => {
    process.env = savedEnv;
  });

  it("adds a newly granted address without rebuilding the firewall", async () => {
    const manager = await buildManager({
      contained: true, extraHosts: [], extraCidrs: ["100.83.12.47/32"],
    });
    await manager.reloadEgress(SESSION_ID);

    expect(allowEgressToSubnets).toHaveBeenCalledTimes(1);
    expect(allowEgressToSubnets.mock.calls[0][1]).toMatchObject({ subnets: ["100.83.12.47/32"] });
    expect(installEgressFirewall).not.toHaveBeenCalled();
  });

  it("rebuilds the firewall when an address is revoked, so the rule goes away", async () => {
    let cidrs = ["100.83.12.47/32"];
    const manager = await buildManager(() => ({
      contained: true, extraHosts: [], extraCidrs: [...cidrs],
    }));
    await manager.reloadEgress(SESSION_ID);
    installEgressFirewall.mockClear();

    cidrs = [];
    await manager.reloadEgress(SESSION_ID);
    expect(installEgressFirewall).toHaveBeenCalledTimes(1);
  });

  it("rebuilds when one of several is revoked, and keeps the rest", async () => {
    let cidrs = ["10.0.0.1/32", "10.0.0.2/32"];
    const manager = await buildManager(() => ({
      contained: true, extraHosts: [], extraCidrs: [...cidrs],
    }));
    await manager.reloadEgress(SESSION_ID);
    installEgressFirewall.mockClear();

    cidrs = ["10.0.0.2/32"];
    await manager.reloadEgress(SESSION_ID);
    const { inputs } = installEgressFirewall.mock.calls[0][1];
    expect(inputs.cidrs).toContain("10.0.0.2/32");
    expect(inputs.cidrs).not.toContain("10.0.0.1/32");
  });

  it("does nothing when the grant has not moved", async () => {
    const manager = await buildManager({
      contained: true, extraHosts: [], extraCidrs: ["10.0.0.1/32"],
    });
    await manager.reloadEgress(SESSION_ID);
    allowEgressToSubnets.mockClear();
    installEgressFirewall.mockClear();

    await manager.reloadEgress(SESSION_ID);
    expect(allowEgressToSubnets).not.toHaveBeenCalled();
    expect(installEgressFirewall).not.toHaveBeenCalled();
  });
});
