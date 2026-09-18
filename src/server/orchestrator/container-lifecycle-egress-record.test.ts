import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Docker from "dockerode";

const { installEgressFirewall, buildTierAEgressInputs } = vi.hoisted(() => ({
  installEgressFirewall: vi.fn(async () => {}),
  buildTierAEgressInputs: vi.fn(async () => ({ hosts: [], cidrs: [] })),
}));
vi.mock("./egress-firewall-install.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, installEgressFirewall, buildTierAEgressInputs };
});

import { createContainer, type LifecycleDeps } from "./container-lifecycle.js";
import type { ContainerConfig } from "./session-container.js";
import type { ResolvedEgressConfig } from "./egress-allowlist.js";
import { TEST_CREDENTIALS_DIR } from "./credentials-test-helpers.js";

/**
 * `egressUserHostsExcluded` is what `services/settings-read.ts` tells the user
 * about whether the egress allowlist is doing anything to their session
 * (docs/299-agent-settings-access req 3). It must come from the policy this
 * container ACTUALLY had applied — true only where a sealing one was installed,
 * because "sealed" said of a container that reaches everything is the failure
 * that requirement exists to prevent.
 */

const SESSION_ID = "sess-egress-record";

function fakeDocker(): Docker {
  return {
    createVolume: async () => {},
    getVolume: () => ({
      inspect: async () => { throw Object.assign(new Error("none"), { statusCode: 404 }); },
      remove: async () => {},
    }),
    listContainers: async () => [],
    listNetworks: async () => [],
    listVolumes: async () => ({ Volumes: [] }),
    getNetwork: () => ({ remove: async () => {} }),
    getContainer: () => ({
      inspect: async () => { throw Object.assign(new Error("none"), { statusCode: 404 }); },
      stop: async () => {},
      remove: async () => {},
    }),
    createContainer: async () => ({
      id: "cid-egress",
      start: async () => {},
      inspect: async () => ({
        Config: { Labels: {} },
        NetworkSettings: { Networks: { "shipit-net": { IPAddress: "172.20.0.9" } } },
      }),
    }),
  } as unknown as Docker;
}

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-egress-record-"));
  tmpDirs.push(d);
  fs.mkdirSync(path.join(d, "session", "workspace"), { recursive: true });
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  installEgressFirewall.mockClear();
});

async function createWith(
  egress: ResolvedEgressConfig,
  over: Partial<LifecycleDeps> = {},
): Promise<{ egressUserHostsExcluded?: boolean; egressContainedAtStart?: boolean }> {
  const tmp = tmpDir();
  const deps = {
    docker: fakeDocker(),
    containers: new Map(),
    standbySessionIds: new Set<string>(),
    destroyEpochs: new Map<string, number>(),
    emitter: new EventEmitter(),
    baseLabels: () => ({ "shipit-managed": "true" }),
    networkName: "shipit-net",
    workerPort: 9100,
    imageName: "shipit-worker:test",
    skipHealthCheck: true,
    resolveEgressConfig: () => egress,
    ...over,
  } as unknown as LifecycleDeps;
  const config: ContainerConfig = {
    sessionId: SESSION_ID,
    sessionDir: path.join(tmp, "session"),
    workspaceDir: path.join(tmp, "session", "workspace"),
    sessionStateDir: path.join(tmp, "session", "state"),
    credentialsDir: TEST_CREDENTIALS_DIR,
    imageName: "shipit-worker:test",
    memoryLimit: 512 * 1024 * 1024,
    cpuQuota: 50_000,
    pidsLimit: 256,
  } as unknown as ContainerConfig;
  return createContainer(deps, config);
}

const SEALED: ResolvedEgressConfig = {
  contained: true,
  extraHosts: [],
  base: ["lifeline.example"],
  userHostsExcluded: true,
};

describe("createContainer — the applied egress exclusion it records", () => {
  it("records the sealing it installed", async () => {
    const sc = await createWith(SEALED, {
      egressEnforce: true,
      egressSidecarImage: "shipit-egress-sidecar:test",
    } as Partial<LifecycleDeps>);

    expect(installEgressFirewall).toHaveBeenCalledTimes(1);
    expect(sc.egressUserHostsExcluded).toBe(true);
  });

  it("records no sealing where enforcement installs no firewall at all", async () => {
    // SESSION_EGRESS_ENFORCE=0: the config resolves sealed and nothing applies
    // it, so the container reaches everything. Recording the resolved value
    // would describe a policy that was never installed.
    const sc = await createWith(SEALED, { egressEnforce: false } as Partial<LifecycleDeps>);

    expect(installEgressFirewall).not.toHaveBeenCalled();
    expect(sc.egressUserHostsExcluded).toBe(false);
  });

  it("records no sealing for a container nothing contains", async () => {
    const sc = await createWith(
      { contained: false, extraHosts: [] },
      { egressEnforce: true, egressSidecarImage: "shipit-egress-sidecar:test" } as Partial<LifecycleDeps>,
    );

    expect(sc.egressContainedAtStart).toBe(false);
    expect(sc.egressUserHostsExcluded).toBe(false);
  });

  it("records no sealing for an ordinary contained container", async () => {
    const sc = await createWith(
      { contained: true, extraHosts: ["api.example.com"] },
      { egressEnforce: true, egressSidecarImage: "shipit-egress-sidecar:test" } as Partial<LifecycleDeps>,
    );

    expect(sc.egressUserHostsExcluded).toBe(false);
  });
});
