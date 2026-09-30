import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { reloadEgressSidecars, staleEgressSidecars, containComposeServices, allowEgressToSubnets, installEgressFirewall } =
  vi.hoisted(() => ({
    reloadEgressSidecars: vi.fn(async (_o: Record<string, unknown>) => {}),
    staleEgressSidecars: vi.fn(async (_d: unknown, _o: Record<string, unknown>) => ({ resolver: false, proxy: false })),
    containComposeServices: vi.fn(async () => {}),
    allowEgressToSubnets: vi.fn(async (_d: unknown, o: { subnets: string[] }) => o.subnets),
    installEgressFirewall: vi.fn(async (_d: unknown, _o: { inputs: { cidrs: string[] } }) => {}),
  }));
vi.mock("./egress-reload.js", () => ({ reloadEgressSidecars, staleEgressSidecars }));
vi.mock("./egress-firewall-install.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, allowEgressToSubnets, installEgressFirewall };
});
vi.mock("./local-block.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, hostAddresses: vi.fn(async () => ["203.0.113.7"]) };
});
vi.mock("./compose-service-egress.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, containComposeServices };
});

import { SessionContainerManager } from "./session-container.js";
import { _setLocalBlockForTest, hostAddresses as readHostAddresses } from "./local-block.js";
import { LegacyEgressNamespaceError } from "./egress-firewall-install.js";
import type { ResolvedEgressConfig } from "./egress-allowlist.js";
import { OPS_DOCKER_HOST } from "./container-lifecycle.js";
import { OPS_DOCKER_PROXY_DNS_NAME } from "./egress-dns-install.js";

const SESSION_ID = "sess-reload-1";
const NETWORK = "shipit-test";

function createMockDocker(agentEnv: string[] = []) {
  return {
    ping: vi.fn(async () => true),
    listContainers: vi.fn(async () => [
      { Id: "agent-container-1", Labels: { "shipit-session-id": SESSION_ID }, State: "running" },
    ]),
    getContainer: vi.fn((id: string) => ({
      inspect: vi.fn(async () => ({
        Config: { Env: id === "orchestrator" ? [] : agentEnv },
        NetworkSettings: { Networks: { [NETWORK]: { IPAddress: id === "orchestrator" ? "172.18.0.2" : "172.18.0.7" } } },
      })),
    })),
    getNetwork: vi.fn(() => ({
      inspect: vi.fn(async () => ({ IPAM: { Config: [{ Subnet: "172.18.0.0/16", Gateway: "172.18.0.1" }] } })),
    })),
  };
}

async function buildManager(
  config: ResolvedEgressConfig | (() => ResolvedEgressConfig),
  opts: { agentEnv?: string[] } = {},
) {
  const docker = createMockDocker(opts.agentEnv);
  const manager = new SessionContainerManager({
    docker: docker as never,
    imageName: "shipit-session-worker:test",
    networkName: NETWORK,
    skipHealthCheck: true,
    stackName: "shipit-test",
    resolveEgressConfig: () => (typeof config === "function" ? config() : config),
    readOwnContainerId: async () => "orchestrator",
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

  it("contains Compose services with a fresh read of the host's addresses", async () => {
    const manager = await buildManager({ contained: true, extraHosts: [] });
    vi.mocked(readHostAddresses).mockClear();
    await manager.containComposeServices(SESSION_ID, ["web"]);
    // A cached read can list the gateway of a removed network whose range the session network reuses.
    expect(readHostAddresses).toHaveBeenCalledWith(expect.anything(), "shipit-egress-sidecar:test", { fresh: true });
    expect(containComposeServices).toHaveBeenCalledWith(expect.objectContaining({ hostAddresses: ["203.0.113.7"] }));
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
    // A container known to have a firewall; rediscovery records neither field.
    manager.get(SESSION_ID)!.egressContainedAtStart = true;
    expect(manager.get(SESSION_ID)?.egressUserHostsExcluded).toBeUndefined();

    await manager.reloadEgress(SESSION_ID);

    expect(manager.get(SESSION_ID)?.egressUserHostsExcluded).toBe(true);
  });

  it("records the ordinary allowlist coming back, not only the sealing", async () => {
    const manager = await buildManager({ contained: true, extraHosts: ["fal.run"] });
    manager.get(SESSION_ID)!.egressContainedAtStart = true;

    await manager.reloadEgress(SESSION_ID);

    expect(manager.get(SESSION_ID)?.egressUserHostsExcluded).toBe(false);
  });

  it("records nothing for a container whose own containment ShipIt cannot tell", async () => {
    // Rediscovered after a ShipIt restart: a reload establishes what the
    // sidecars hold, never whether this container's traffic reaches them.
    const manager = await buildManager({
      contained: true, extraHosts: [], base: ["lifeline.example"], userHostsExcluded: true,
    });
    expect(manager.get(SESSION_ID)?.egressContainedAtStart).toBeUndefined();

    await manager.reloadEgress(SESSION_ID);

    expect(manager.get(SESSION_ID)?.egressUserHostsExcluded).toBeUndefined();
  });

  it("records no sealing on a container that has no firewall to seal it", async () => {
    // A reload launches the resolver and proxy; the redirect that routes the
    // container's traffic through them is installed at creation. So sidecars on
    // a container that started OPEN change nothing, and recording a sealing
    // here would have the settings read call a container that reaches
    // everything sealed.
    const manager = await buildManager({
      contained: true, extraHosts: [], base: ["lifeline.example"], userHostsExcluded: true,
    });
    manager.get(SESSION_ID)!.egressContainedAtStart = false;

    await manager.reloadEgress(SESSION_ID);

    expect(reloadEgressSidecars).toHaveBeenCalledTimes(1);
    expect(manager.get(SESSION_ID)?.egressUserHostsExcluded).toBeUndefined();
  });

  it("leaves the record unknown when the replacement failed part-way", async () => {
    // `reloadEgressSidecars` replaces the resolver and then the proxy, so a
    // throw leaves the container enforcing neither policy whole. Keeping the
    // previous value would be a confident wrong answer about a container whose
    // DNS has already changed.
    const manager = await buildManager({ contained: true, extraHosts: ["fal.run"] });
    manager.get(SESSION_ID)!.egressContainedAtStart = true;
    await manager.reloadEgress(SESSION_ID);
    expect(manager.get(SESSION_ID)?.egressUserHostsExcluded).toBe(false);

    reloadEgressSidecars.mockRejectedValueOnce(new Error("proxy launch failed"));
    await expect(manager.reloadEgress(SESSION_ID)).rejects.toThrow("proxy launch failed");

    expect(manager.get(SESSION_ID)?.egressUserHostsExcluded).toBeUndefined();
  });

  it("records nothing when no reload reached the container", async () => {
    const manager = await buildManager({
      contained: true, extraHosts: [], userHostsExcluded: true,
    });
    manager.get(SESSION_ID)!.egressContainedAtStart = true;
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

/** docs/319 req 2, req 5 — open sessions get the block, and SSH changes reach it too. */
describe("reloadEgress — open policy with the local block", () => {
  let savedEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.SESSION_EGRESS_ENFORCE = "1";
    process.env.SESSION_EGRESS_SIDECAR_IMAGE = "shipit-egress-sidecar:test";
    _setLocalBlockForTest(true);
    reloadEgressSidecars.mockClear();
    containComposeServices.mockClear();
    allowEgressToSubnets.mockClear();
    installEgressFirewall.mockClear();
  });
  afterEach(() => {
    process.env = savedEnv;
    _setLocalBlockForTest(false);
  });

  it("reinstalls the open firewall with the new SSH destination, and reloads no resolver", async () => {
    let targets: { address: string; port: number }[] = [];
    const manager = await buildManager(() => ({ contained: false, extraHosts: [], sshTargets: [...targets] }));
    await expect(manager.reloadEgress(SESSION_ID)).resolves.toBe(false);
    expect(installEgressFirewall).not.toHaveBeenCalled();

    targets = [{ address: "10.0.0.5", port: 2222 }];
    await expect(manager.reloadEgress(SESSION_ID)).resolves.toBe(true);
    expect(installEgressFirewall).toHaveBeenCalledTimes(1);
    expect(installEgressFirewall.mock.calls[0][1]).toMatchObject({
      policy: "open",
      inputs: { hosts: [], cidrs: [] },
      sshTargets: [{ address: "10.0.0.5", port: 2222 }],
      hostAddresses: ["203.0.113.7"],
      localTcp: [{ subnet: "172.18.0.2/32", port: Number(process.env.PORT || "3000") }],
    });
    expect(reloadEgressSidecars).not.toHaveBeenCalled();
  });

  it("also applies the block when egress limits are off for the whole install", async () => {
    process.env.SESSION_EGRESS_ENFORCE = "0";
    const manager = await buildManager({
      contained: true, extraHosts: [], sshTargets: [{ address: "nas.example", port: 22 }],
    });
    await manager.reloadEgress(SESSION_ID);
    expect(installEgressFirewall.mock.calls[0]?.[1]).toMatchObject({ policy: "open" });
  });
});

describe("reconcileAdoptedFirewalls (docs/319)", () => {
  let savedEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.SESSION_EGRESS_SIDECAR_IMAGE = "shipit-egress-sidecar:test";
    _setLocalBlockForTest(true);
    allowEgressToSubnets.mockClear();
    installEgressFirewall.mockClear();
    containComposeServices.mockClear();
  });
  afterEach(() => {
    process.env = savedEnv;
    _setLocalBlockForTest(false);
  });

  it("replaces only ShipIt's own address in an adopted agent, with no reinstall", async () => {
    const manager = await buildManager({ contained: false, extraHosts: [] });
    await manager.reconcileAdoptedFirewalls({ retryDelayMs: 0 });
    expect(installEgressFirewall).not.toHaveBeenCalled();
    expect(allowEgressToSubnets).toHaveBeenCalledTimes(1);
    expect(allowEgressToSubnets.mock.calls[0][1]).toMatchObject({
      agentContainerId: "agent-container-1",
      subnets: [],
      localTcp: [{ subnet: "172.18.0.2/32", port: Number(process.env.PORT || "3000") }],
    });
  });

  it("reinstalls a namespace from before docs/319, which has no chain to update", async () => {
    const manager = await buildManager({ contained: false, extraHosts: [], sshTargets: [{ address: "10.0.0.5", port: 22 }] });
    allowEgressToSubnets.mockRejectedValueOnce(new LegacyEgressNamespaceError("old"));
    await manager.reconcileAdoptedFirewalls({ retryDelayMs: 0 });
    expect(installEgressFirewall).toHaveBeenCalledTimes(1);
    expect(installEgressFirewall.mock.calls[0][1]).toMatchObject({
      policy: "open",
      sshTargets: [{ address: "10.0.0.5", port: 22 }],
    });
    expect(manager.get(SESSION_ID)?.firewallPolicy).toBe("open");
  });

  it("contains Compose services again only where their session network is from before docs/319", async () => {
    const manager = await buildManager({ contained: false, extraHosts: [] });
    const docker = manager.dockerClient as unknown as {
      listContainers: ReturnType<typeof vi.fn>;
      getNetwork: ReturnType<typeof vi.fn>;
    };
    docker.listContainers.mockResolvedValue([
      { Id: "svc-old", Labels: { "shipit-parent-session": "old", "shipit-service-name": "web" }, State: "running" },
      { Id: "svc-new", Labels: { "shipit-parent-session": "new", "shipit-service-name": "web" }, State: "running" },
    ]);
    docker.getNetwork.mockImplementation((name: string) => ({
      inspect: vi.fn(async () => (name === "shipit-session-new"
        ? { Internal: true, Options: { "com.docker.network.bridge.inhibit_ipv4": "true" } }
        : { Internal: false, IPAM: { Config: [{ Subnet: "172.18.0.0/16" }] } })),
    }));
    await manager.reconcileAdoptedFirewalls({ retryDelayMs: 0 });
    const calls = containComposeServices.mock.calls as unknown as [{ sessionId: string }][];
    expect(calls.map((call) => call[0].sessionId)).toEqual(["old"]);
  });

  it("retries a failed refresh", async () => {
    const manager = await buildManager({ contained: false, extraHosts: [] });
    allowEgressToSubnets.mockRejectedValueOnce(new Error("sidecar busy"));
    await manager.reconcileAdoptedFirewalls({ retryDelayMs: 0 });
    expect(allowEgressToSubnets).toHaveBeenCalledTimes(2);
  });
});

/**
 * planning#626 — a recreated ShipIt has a new hostname. A kept agent's resolver
 * forwards only the names it was started with, and its proxy calls the decision
 * URL it was started with, so both must be brought up to date at start.
 */
describe("reconcileAdoptedFirewalls — a kept contained agent's sidecars", () => {
  let savedEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.SESSION_EGRESS_ENFORCE = "1";
    process.env.SESSION_EGRESS_SIDECAR_IMAGE = "shipit-egress-sidecar:test";
    delete process.env.SESSION_EGRESS_DNS;
    delete process.env.SESSION_EGRESS_PROXY;
    delete process.env.SHIPIT_ORCHESTRATOR_HOST;
    delete process.env.SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS;
    process.env.PORT = "4123";
    _setLocalBlockForTest(true);
    reloadEgressSidecars.mockClear();
    staleEgressSidecars.mockClear();
    staleEgressSidecars.mockResolvedValue({ resolver: false, proxy: false });
    allowEgressToSubnets.mockClear();
  });
  afterEach(() => {
    process.env = savedEnv;
    _setLocalBlockForTest(false);
  });

  it("asks about the names the worker falls back to and this process's decision URL", async () => {
    const manager = await buildManager({ contained: true, extraHosts: [] });
    await manager.reconcileAdoptedFirewalls({ retryDelayMs: 0 });
    expect(staleEgressSidecars).toHaveBeenCalledTimes(1);
    const opts = staleEgressSidecars.mock.calls[0][1];
    expect(opts).toMatchObject({ sessionId: SESSION_ID, agentContainerId: "agent-container-1" });
    expect(opts.internalNames).toContain("shipit");
    expect(opts.decisionUrl).toMatch(/^http:\/\/[^/]+:4123\/api\/egress\/decision$/);
  });

  it("replaces the stale sidecars with the session's current policy", async () => {
    staleEgressSidecars.mockResolvedValue({ resolver: true, proxy: false });
    const manager = await buildManager({
      contained: true, extraHosts: ["fal.run"], base: ["example.com"], identityRules: "rules",
    });
    await manager.reconcileAdoptedFirewalls({ retryDelayMs: 0 });
    expect(reloadEgressSidecars).toHaveBeenCalledTimes(1);
    expect(reloadEgressSidecars.mock.calls[0][0]).toMatchObject({
      agentContainerId: "agent-container-1",
      sessionId: SESSION_ID,
      opsSession: false,
      extraHosts: ["fal.run"],
      base: ["example.com"],
      identityRules: "rules",
      reloadResolver: true,
      reloadProxy: false,
    });
  });

  it("replaces them with the policy as it is after the inspection, not before", async () => {
    let hosts = ["revoked.example"];
    staleEgressSidecars.mockImplementation(async () => {
      hosts = [];
      return { resolver: true, proxy: true };
    });
    const manager = await buildManager(() => ({ contained: true, extraHosts: [...hosts] }));
    await manager.reconcileAdoptedFirewalls({ retryDelayMs: 0 });
    expect(reloadEgressSidecars.mock.calls[0][0]).toMatchObject({ extraHosts: [] });
  });

  it("leaves current sidecars alone, as after a plain restart, and still updates ShipIt's address", async () => {
    const manager = await buildManager({ contained: true, extraHosts: [] });
    await manager.reconcileAdoptedFirewalls({ retryDelayMs: 0 });
    expect(reloadEgressSidecars).not.toHaveBeenCalled();
    expect(allowEgressToSubnets).toHaveBeenCalledTimes(1);
  });

  it("keeps the ops Docker proxy's name for an adopted ops session", async () => {
    staleEgressSidecars.mockResolvedValue({ resolver: true, proxy: true });
    const manager = await buildManager(
      { contained: true, extraHosts: [] },
      { agentEnv: [`DOCKER_HOST=${OPS_DOCKER_HOST}`] },
    );
    await manager.reconcileAdoptedFirewalls({ retryDelayMs: 0 });
    expect(staleEgressSidecars.mock.calls[0][1].internalNames).toContain(OPS_DOCKER_PROXY_DNS_NAME);
    expect(reloadEgressSidecars.mock.calls[0][0]).toMatchObject({ opsSession: true });
  });

  it("does not look for sidecars in an open session, which has none", async () => {
    const manager = await buildManager({ contained: false, extraHosts: [] });
    await manager.reconcileAdoptedFirewalls({ retryDelayMs: 0 });
    expect(staleEgressSidecars).not.toHaveBeenCalled();
  });

  it("retries a failed replacement", async () => {
    staleEgressSidecars.mockResolvedValue({ resolver: true, proxy: false });
    reloadEgressSidecars.mockRejectedValueOnce(new Error("resolver busy"));
    const manager = await buildManager({ contained: true, extraHosts: [] });
    await manager.reconcileAdoptedFirewalls({ retryDelayMs: 0 });
    expect(reloadEgressSidecars).toHaveBeenCalledTimes(2);
  });
});
