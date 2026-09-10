import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { reloadEgressSidecars, containComposeServices } = vi.hoisted(() => ({
  reloadEgressSidecars: vi.fn(async () => {}),
  containComposeServices: vi.fn(async () => {}),
}));
vi.mock("./egress-reload.js", () => ({ reloadEgressSidecars }));
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

async function buildManager(config: ResolvedEgressConfig) {
  const docker = createMockDocker();
  const manager = new SessionContainerManager({
    docker: docker as never,
    imageName: "shipit-session-worker:test",
    networkName: NETWORK,
    skipHealthCheck: true,
    stackName: "shipit-test",
    resolveEgressConfig: () => config,
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
});
