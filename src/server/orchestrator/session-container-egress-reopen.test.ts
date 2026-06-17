/**
 * Regression test for GH #1509 — the *residual* preview-unreachability that the
 * `url` field alone doesn't solve.
 *
 * `egressContainedAtStart` is the agent container's boot-time containment, set
 * ONLY on a fresh `create()`. After an orchestrator restart the still-running
 * container is *rediscovered* (`container-discovery.ts`) and *reconnected*
 * WITHOUT that field — but its netns egress firewall persisted with the
 * container, so the agent is STILL contained. The old gate in
 * `allowEgressToSessionNetwork` treated the unknown (`undefined`) value as "not
 * contained" and silently skipped the egress hole-punch on the post-restart
 * compose (re)start, leaving the agent unable to reach its own preview
 * (curl / Playwright ETIMEDOUT).
 *
 * These tests exercise `connectToNetwork` against a *rediscovered* record (the
 * real path that produces `egressContainedAtStart === undefined`) and assert
 * the hole-punch now fires when the resolved policy says contained, while still
 * respecting an Open-mode session and disabled enforcement.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Observe the egress hole-punch and stub the subnet extraction so the test
// doesn't need a real IPAM block. `egressEnforceEnabled` stays REAL (it reads
// the env this test toggles).
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

/**
 * Build a manager and seed it with a *rediscovered* container record — the
 * record shape that has `egressContainedAtStart === undefined`.
 */
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
  // Precondition: the rediscovered record genuinely has no boot-time policy.
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

    // The fix: an unknown (rediscovered) boot value falls back to the resolved
    // policy instead of silently no-oping.
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
    // Deriving locally must not overwrite the record — otherwise the
    // "pending · restart to apply" diff would be falsified after a restart.
    expect(manager.get(SESSION_ID)?.egressContainedAtStart).toBeUndefined();
  });

  it("respects Open mode — no punch when the resolved policy is uncontained", async () => {
    const { manager } = await buildRediscoveredManager(() => ({ contained: false, extraHosts: [] }));
    await manager.connectToNetwork(SESSION_ID, COMPOSE_NETWORK);
    expect(allowEgressToSubnets).not.toHaveBeenCalled();
  });

  it("no punch when no egress config resolver and enforcement on falls back to contained=true", async () => {
    // Without a resolver, fall back to the creation default (contained) so a
    // misconfigured-but-enforcing deployment still re-opens preview egress.
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
