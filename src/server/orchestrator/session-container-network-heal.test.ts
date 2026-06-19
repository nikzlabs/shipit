/**
 * docs/128 — regression test for the *stranded ops agent after a proxy/network
 * recreate*.
 *
 * The agent reaches the ops `docker-socket-proxy` over the per-session compose
 * network. It is attached to that network imperatively, and that attachment is
 * normally only re-established on an orchestrator-driven `docker compose up`. But
 * when the proxy is recreated by its own `restart: unless-stopped` policy (or a
 * host/daemon restart, or a network prune), the compose network/bridge is rebuilt
 * out from under the long-lived agent: the new proxy joins the NEW bridge while
 * the agent stays bolted to the OLD, now-empty bridge — same IPAM subnet,
 * different L2 segment → ARP blackhole, so `DOCKER_HOST=tcp://docker-socket-proxy`
 * is permanently unreachable for the rest of the session.
 *
 * `ensureConnectedToSessionNetwork` is the condition-based heal that closes that
 * gap (driven by the service-poll heartbeat). These tests assert it is a cheap
 * membership-gated no-op while the agent is correctly attached, and that it
 * force-disconnects + reconnects (re-opening egress) when the agent has been
 * stranded off the live network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Observe the egress hole-punch and stub the subnet extraction so the test
// doesn't need a real IPAM block.
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

/**
 * Build a mock Docker whose compose-network inspect reports `members` as the
 * connected container set (keyed by container id, as Docker does).
 */
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
    // Live network has only the recreated proxy — the agent was left on the old bridge.
    const { docker, manager } = await buildManager({ "proxy-container-9": { Name: "docker-socket-proxy" } });

    const healed = await manager.ensureConnectedToSessionNetwork(SESSION_ID, COMPOSE_NETWORK);

    expect(healed).toBe(true);
    // Clears any dangling endpoint Docker still tracks under this name first...
    expect(docker._disconnect).toHaveBeenCalledWith({ Container: AGENT_ID, Force: true });
    // ...then reconnects the agent and re-opens egress to the (recreated) subnet.
    expect(docker._connect).toHaveBeenCalledWith({ Container: AGENT_ID });
    expect(allowEgressToSubnets).toHaveBeenCalledTimes(1);
    expect(allowEgressToSubnets).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentContainerId: AGENT_ID, subnets: ["172.19.0.0/16"] }),
    );
  });

  it("no-ops when the network does not exist yet (a later compose-up join creates the attachment)", async () => {
    const docker = createMockDocker({});
    // Network inspect rejects → network absent.
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
