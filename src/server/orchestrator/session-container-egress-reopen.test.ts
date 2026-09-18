import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { allowEgressToSubnets } = vi.hoisted(() => ({
  allowEgressToSubnets: vi.fn(async () => ["172.19.0.0/16"]),
}));
vi.mock("./egress-firewall-install.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, allowEgressToSubnets };
});
vi.mock("./egress-firewall.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, extractNetworkSubnets: () => ["172.19.0.0/16"] };
});

import { SessionContainerManager } from "./session-container.js";
import type { ResolvedEgressConfig } from "./egress-allowlist.js";

const SESSION_ID = "sess-redisc-1";
const NETWORK = "shipit-test";
const COMPOSE_NETWORK = `shipit-session-${SESSION_ID}`;

function createMockDocker() {
  const connect = vi.fn(async () => {});
  const docker = {
    ping: vi.fn(async () => true),
    listContainers: vi.fn(async () => [
      {
        Id: "agent-container-1",
        Labels: { "shipit-session-id": SESSION_ID },
        State: "running",
      },
    ]),
    getContainer: vi.fn(() => ({
      inspect: vi.fn(async () => ({
        NetworkSettings: { Networks: { [NETWORK]: { IPAddress: "172.18.0.7" } } },
      })),
    })),
    getNetwork: vi.fn(() => ({
      connect,
      inspect: vi.fn(async () => ({ Name: COMPOSE_NETWORK, IPAM: { Config: [] } })),
    })),
    _connect: connect,
  };
  return docker;
}

async function buildRediscoveredManager(
  resolveEgressConfig?: (sessionId: string) => ResolvedEgressConfig,
) {
  const docker = createMockDocker();
  const manager = new SessionContainerManager({
    docker: docker as any,
    imageName: "shipit-session-worker:test",
    networkName: NETWORK,
    skipHealthCheck: true,
    stackName: "shipit-test",
    ...(resolveEgressConfig ? { resolveEgressConfig } : {}),
  });
  const count = await manager.rediscover(new Set([SESSION_ID]), () => ({
    workspaceDir: "/workspace/sessions/sess-redisc-1/workspace",
    dockerAccess: true,
  }));
  expect(count).toBe(1);
  expect(manager.get(SESSION_ID)?.egressContainedAtStart).toBeUndefined();
  return { docker, manager };
}

describe("connectToNetwork — re-open preview egress after rediscover (GH #1509)", () => {
  let savedEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.SESSION_EGRESS_ENFORCE = "1";
    process.env.SESSION_EGRESS_SIDECAR_IMAGE = "shipit-egress-sidecar:test";
    allowEgressToSubnets.mockClear();
  });
  afterEach(() => {
    process.env = savedEnv;
  });

  it("punches the hole when boot containment is unknown but the resolved policy is contained", async () => {
    const { manager } = await buildRediscoveredManager(() => ({ contained: true, extraHosts: [] }));

    await manager.connectToNetwork(SESSION_ID, COMPOSE_NETWORK);

    expect(allowEgressToSubnets).toHaveBeenCalledTimes(1);
    expect(allowEgressToSubnets).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentContainerId: "agent-container-1",
        sidecarImage: "shipit-egress-sidecar:test",
        subnets: ["172.19.0.0/16"],
      }),
    );
  });

  it("does NOT touch the boot field (egress status API relies on undefined = unknown)", async () => {
    const { manager } = await buildRediscoveredManager(() => ({ contained: true, extraHosts: [] }));
    await manager.connectToNetwork(SESSION_ID, COMPOSE_NETWORK);
    expect(manager.get(SESSION_ID)?.egressContainedAtStart).toBeUndefined();
  });

  it("respects Open mode — no punch when the resolved policy is uncontained", async () => {
    const { manager } = await buildRediscoveredManager(() => ({ contained: false, extraHosts: [] }));
    await manager.connectToNetwork(SESSION_ID, COMPOSE_NETWORK);
    expect(allowEgressToSubnets).not.toHaveBeenCalled();
  });

  it("no punch when no egress config resolver and enforcement on falls back to contained=true", async () => {
    const { manager } = await buildRediscoveredManager(undefined);
    await manager.connectToNetwork(SESSION_ID, COMPOSE_NETWORK);
    expect(allowEgressToSubnets).toHaveBeenCalledTimes(1);
  });

  it("no punch when enforcement is disabled", async () => {
    process.env.SESSION_EGRESS_ENFORCE = "0";
    const { manager } = await buildRediscoveredManager(() => ({ contained: true, extraHosts: [] }));
    await manager.connectToNetwork(SESSION_ID, COMPOSE_NETWORK);
    expect(allowEgressToSubnets).not.toHaveBeenCalled();
  });

  it("still connects the agent to the compose network regardless of the egress decision", async () => {
    const { docker, manager } = await buildRediscoveredManager(() => ({ contained: false, extraHosts: [] }));
    await manager.connectToNetwork(SESSION_ID, COMPOSE_NETWORK);
    expect(docker._connect).toHaveBeenCalledWith({ Container: "agent-container-1" });
  });
});

describe("connectToNetwork — egress allow ordered after the Tier-A install (docs/172)", () => {
  let savedEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.SESSION_EGRESS_ENFORCE = "1";
    process.env.SESSION_EGRESS_SIDECAR_IMAGE = "shipit-egress-sidecar:test";
    allowEgressToSubnets.mockClear();
  });
  afterEach(() => {
    process.env = savedEnv;
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("does NOT apply the subnet allow until the firewall-install readiness resolves, then applies it once", async () => {
    const { manager } = await buildRediscoveredManager(() => ({ contained: true, extraHosts: [] }));

    let signalInstallDone!: () => void;
    const installing = new Promise<void>((resolve) => { signalInstallDone = resolve; });
    manager.get(SESSION_ID)!.egressFirewallReady = installing;

    const joinP = manager.connectToNetwork(SESSION_ID, COMPOSE_NETWORK);
    await flush();

    expect(allowEgressToSubnets).not.toHaveBeenCalled();

    signalInstallDone();
    await joinP;

    expect(allowEgressToSubnets).toHaveBeenCalledTimes(1);
    expect(allowEgressToSubnets).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentContainerId: "agent-container-1", subnets: ["172.19.0.0/16"] }),
    );
  });

  it("records the joined network so a firewall re-install can re-open it", async () => {
    const { manager } = await buildRediscoveredManager(() => ({ contained: true, extraHosts: [] }));
    await manager.connectToNetwork(SESSION_ID, COMPOSE_NETWORK);
    expect(manager.get(SESSION_ID)?.joinedSessionNetworks?.has(COMPOSE_NETWORK)).toBe(true);
  });

  it("reopenJoinedSessionEgress re-applies the allow for every joined network (idempotent re-open after an OUTPUT flush)", async () => {
    const { manager } = await buildRediscoveredManager(() => ({ contained: true, extraHosts: [] }));
    await manager.connectToNetwork(SESSION_ID, COMPOSE_NETWORK);
    expect(allowEgressToSubnets).toHaveBeenCalledTimes(1);
    allowEgressToSubnets.mockClear();

    await manager.reopenJoinedSessionEgress(SESSION_ID);

    expect(allowEgressToSubnets).toHaveBeenCalledTimes(1);
    expect(allowEgressToSubnets).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentContainerId: "agent-container-1", subnets: ["172.19.0.0/16"] }),
    );
  });

  it("reopenJoinedSessionEgress is a no-op when no network has been joined", async () => {
    const { manager } = await buildRediscoveredManager(() => ({ contained: true, extraHosts: [] }));
    await manager.reopenJoinedSessionEgress(SESSION_ID);
    expect(allowEgressToSubnets).not.toHaveBeenCalled();
  });
});
