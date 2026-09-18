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

const SESSION_ID = "sess-heal-1";
const ORCH_NETWORK = "shipit-test";
const COMPOSE_NETWORK = `shipit-session-${SESSION_ID}`;
const AGENT_ID = "agent-container-1";

function createMockDocker(members: Record<string, unknown>) {
  const connect = vi.fn(async () => {});
  const disconnect = vi.fn(async () => {});
  const inspect = vi.fn(async () => ({
    Name: COMPOSE_NETWORK,
    IPAM: { Config: [{ Subnet: "172.19.0.0/16" }] },
    Containers: members,
  }));
  const docker = {
    ping: vi.fn(async () => true),
    listContainers: vi.fn(async () => [
      { Id: AGENT_ID, Labels: { "shipit-session-id": SESSION_ID }, State: "running" },
    ]),
    getContainer: vi.fn(() => ({
      inspect: vi.fn(async () => ({
        NetworkSettings: { Networks: { [ORCH_NETWORK]: { IPAddress: "172.18.0.7" } } },
      })),
    })),
    getNetwork: vi.fn(() => ({ connect, disconnect, inspect })),
    _connect: connect,
    _disconnect: disconnect,
  };
  return docker;
}

async function buildManager(members: Record<string, unknown>) {
  const docker = createMockDocker(members);
  const manager = new SessionContainerManager({
    docker: docker as never,
    imageName: "shipit-session-worker:test",
    networkName: ORCH_NETWORK,
    skipHealthCheck: true,
    stackName: "shipit-test",
    resolveEgressConfig: () => ({ contained: true, extraHosts: [] }),
  });
  const count = await manager.rediscover(new Set([SESSION_ID]), () => ({
    workspaceDir: "/workspace/sessions/sess-heal-1/workspace",
    dockerAccess: true,
  }));
  expect(count).toBe(1);
  return { docker, manager };
}

describe("ensureConnectedToSessionNetwork — heal stranded agent (docs/128)", () => {
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

  it("no-ops (no reconnect, no sidecar) when the agent is already a member of the live network", async () => {
    const { docker, manager } = await buildManager({ [AGENT_ID]: { Name: "agent" } });

    const healed = await manager.ensureConnectedToSessionNetwork(SESSION_ID, COMPOSE_NETWORK);

    expect(healed).toBe(false);
    expect(docker._connect).not.toHaveBeenCalled();
    expect(docker._disconnect).not.toHaveBeenCalled();
    expect(allowEgressToSubnets).not.toHaveBeenCalled();
  });

  it("force-disconnects the stale endpoint and reconnects (re-opening egress) when the agent is stranded off the live network", async () => {
    const { docker, manager } = await buildManager({ "proxy-container-9": { Name: "docker-socket-proxy" } });

    const healed = await manager.ensureConnectedToSessionNetwork(SESSION_ID, COMPOSE_NETWORK);

    expect(healed).toBe(true);
    expect(docker._disconnect).toHaveBeenCalledWith({ Container: AGENT_ID, Force: true });
    expect(docker._connect).toHaveBeenCalledWith({ Container: AGENT_ID });
    expect(allowEgressToSubnets).toHaveBeenCalledTimes(1);
    expect(allowEgressToSubnets).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentContainerId: AGENT_ID, subnets: ["172.19.0.0/16"] }),
    );
  });

  it("no-ops when the network does not exist yet (a later compose-up join creates the attachment)", async () => {
    const docker = createMockDocker({});
    docker.getNetwork = vi.fn(() => ({
      connect: docker._connect,
      disconnect: docker._disconnect,
      inspect: vi.fn(async () => {
        throw new Error("network shipit-session-sess-heal-1 not found");
      }),
    })) as never;
    const manager = new SessionContainerManager({
      docker: docker as never,
      imageName: "shipit-session-worker:test",
      networkName: ORCH_NETWORK,
      skipHealthCheck: true,
      stackName: "shipit-test",
      resolveEgressConfig: () => ({ contained: true, extraHosts: [] }),
    });
    await manager.rediscover(new Set([SESSION_ID]), () => ({
      workspaceDir: "/workspace/sessions/sess-heal-1/workspace",
      dockerAccess: true,
    }));

    const healed = await manager.ensureConnectedToSessionNetwork(SESSION_ID, COMPOSE_NETWORK);

    expect(healed).toBe(false);
    expect(docker._connect).not.toHaveBeenCalled();
    expect(allowEgressToSubnets).not.toHaveBeenCalled();
  });

  it("returns false for an unknown session (no container record)", async () => {
    const { manager } = await buildManager({ [AGENT_ID]: {} });
    const healed = await manager.ensureConnectedToSessionNetwork("no-such-session", COMPOSE_NETWORK);
    expect(healed).toBe(false);
  });
});
