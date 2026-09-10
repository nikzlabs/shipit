import { beforeEach, describe, expect, it, vi } from "vitest";
import type Docker from "dockerode";

const { installFirewall, launchResolver, launchProxy } = vi.hoisted(() => ({
  installFirewall: vi.fn(
    async (_docker: unknown, _opts: Record<string, unknown>): Promise<void> => undefined,
  ),
  launchResolver: vi.fn(
    async (_docker: unknown, _opts: { configB64: string }): Promise<string> => "resolver-id",
  ),
  launchProxy: vi.fn(
    async (
      _docker: unknown,
      _opts: { allowed: string; sessionId: string; decisionUrl?: string },
    ): Promise<string> => "proxy-id",
  ),
}));

vi.mock("./egress-firewall-install.js", async (load) => ({
  // eslint-disable-next-line no-restricted-syntax -- Vitest partial-module mock typing
  ...(await load<typeof import("./egress-firewall-install.js")>()),
  buildTierAEgressInputs: vi.fn(async () => ({ hosts: ["api.github.com"], cidrs: [] })),
  installEgressFirewall: installFirewall,
}));
vi.mock("./egress-dns-install.js", async (load) => ({
  // eslint-disable-next-line no-restricted-syntax -- Vitest partial-module mock typing
  ...(await load<typeof import("./egress-dns-install.js")>()),
  launchEgressResolver: launchResolver,
}));
vi.mock("./egress-proxy-install.js", async (load) => ({
  // eslint-disable-next-line no-restricted-syntax -- Vitest partial-module mock typing
  ...(await load<typeof import("./egress-proxy-install.js")>()),
  launchEgressProxy: launchProxy,
}));

import {
  preparePluginNetns,
  unreachableDeclaredHosts,
  PLUGIN_NETNS_LABEL,
  PLUGIN_NETNS_PARENT_LABEL,
  UNCONTAINED_PLUGIN_EGRESS,
  type PluginEgressPolicy,
} from "./plugin-egress.js";
import { egressHostReach } from "./egress-host-reach.js";
import { hostMatchesEntry } from "./egress-allowlist.js";
import { allowEgressHost, listEgressAllowedHosts, _resetEgressPolicies } from "./egress-policy.js";

const SESSION = "s-1";
const NETWORK = "shipit-plugin-cli";

interface Created {
  id: string;
  opts: Record<string, unknown>;
}

function fakeDocker(events: string[] = []) {
  const created: Created[] = [];
  const removed: string[] = [];
  let listed: Docker.ContainerInfo[] = [];
  let seq = 0;
  let listError: string | null = null;
  let sidecarRemoveError: string | null = null;
  let failHolder: { id: string; shouldFail: () => boolean } | null = null;
  const docker = {
    createContainer: async (opts: Record<string, unknown>) => {
      const id = `c-${++seq}`;
      created.push({ id, opts });
      return {
        id,
        start: async () => { events.push(`start:${id}`); },
        remove: async () => {
          if (failHolder?.id === id && failHolder.shouldFail()) {
            throw new Error(`container ${id} is using its network — cannot remove`);
          }
          removed.push(id);
        },
      };
    },
    listContainers: async () => {
      if (listError) throw new Error(listError);
      return listed;
    },
    getContainer: (id: string) => ({
      remove: async () => {
        if (sidecarRemoveError) throw new Error(sidecarRemoveError);
        removed.push(id);
      },
    }),
  };
  return {
    docker: docker as unknown as Docker,
    created,
    removed,
    setListed: (entries: Docker.ContainerInfo[]) => { listed = entries; },
    failHolderRemove: (id: string, shouldFail: () => boolean) => { failHolder = { id, shouldFail }; },
    failListing: (msg: string) => { listError = msg; },
    failSidecarRemove: (msg: string) => { sidecarRemoveError = msg; },
  };
}

function contained(over: Partial<PluginEgressPolicy> = {}): PluginEgressPolicy {
  return {
    contained: true,
    config: { contained: true, base: ["base.example"], extraHosts: ["extra.example"] },
    allowOnceHosts: ["once.example"],
    sidecarImage: "egress-sidecar:test",
    dnsEnabled: true,
    proxyEnabled: true,
    ...over,
  };
}

function prepare(docker: Docker, policy: PluginEgressPolicy) {
  return preparePluginNetns({
    docker, sessionId: SESSION, network: NETWORK, holderImage: "worker:test", policy,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("preparePluginNetns — an uncontained session", () => {
  it("hands back the plugin network itself and creates nothing", async () => {
    const fake = fakeDocker();

    const netns = await prepare(fake.docker, UNCONTAINED_PLUGIN_EGRESS);

    expect(netns.networkMode).toBe(NETWORK);
    expect(fake.created).toHaveLength(0);
    expect(installFirewall).not.toHaveBeenCalled();
    await netns.release();
    expect(fake.removed).toEqual([]);
  });
});

describe("preparePluginNetns — a contained session", () => {
  it("installs every tier into a holder and runs the workload in ITS namespace", async () => {
    const events: string[] = [];
    const fake = fakeDocker(events);
    installFirewall.mockImplementationOnce(async () => { events.push("firewall"); });
    launchResolver.mockImplementationOnce(async () => { events.push("resolver"); return "r"; });
    launchProxy.mockImplementationOnce(async () => { events.push("proxy"); return "p"; });

    const netns = await prepare(fake.docker, contained());

    const holder = fake.created[0];
    expect(netns.networkMode).toBe(`container:${holder.id}`);
    expect(events).toEqual([`start:${holder.id}`, "firewall", "resolver", "proxy"]);
  });

  it("puts the holder on the untrusted plugin network, with nothing of the session in it", async () => {
    const fake = fakeDocker();

    await prepare(fake.docker, contained());

    const holder = fake.created[0].opts;
    const host = holder.HostConfig as Record<string, unknown>;
    expect(host.NetworkMode).toBe(NETWORK);
    expect(String(host.NetworkMode).startsWith("container:")).toBe(false);
    expect(host.NetworkMode).not.toBe("host");
    expect(host.Mounts ?? []).toEqual([]);
    expect(host.Binds ?? []).toEqual([]);
    expect(host.VolumesFrom ?? []).toEqual([]);
    expect(holder.Env ?? []).toEqual([]);
    expect(host.CapDrop).toEqual(["ALL"]);
    expect(host.CapAdd ?? []).toEqual([]);
    expect(host.Privileged ?? false).toBe(false);
    expect(host.SecurityOpt).toEqual(["no-new-privileges"]);
    expect(holder.NetworkingConfig).toBeUndefined();
    expect((holder.Labels as Record<string, string>)[PLUGIN_NETNS_LABEL]).toBe(SESSION);
  });

  it("carries only the plugin label, so no session-scoped sweep can delete it mid-call", async () => {
    const fake = fakeDocker();

    await prepare(fake.docker, contained());

    for (const { opts } of fake.created) {
      const labels = opts.Labels as Record<string, string>;
      expect(labels).not.toHaveProperty("shipit-parent-session");
      expect(labels).not.toHaveProperty("shipit-service-name");
      expect(labels[PLUGIN_NETNS_LABEL]).toBe(SESSION);
    }
    for (const call of [launchResolver.mock.calls[0], launchProxy.mock.calls[0]]) {
      const labels = (call[1] as unknown as { labels: Record<string, string> }).labels;
      expect(labels).not.toHaveProperty("shipit-parent-session");
      expect(labels[PLUGIN_NETNS_PARENT_LABEL]).toBe(fake.created[0].id);
    }
  });

  it("enables route_localnet on the holder when Tier C is on, and not otherwise", async () => {
    const withProxy = fakeDocker();
    await prepare(withProxy.docker, contained());
    expect((withProxy.created[0].opts.HostConfig as Record<string, unknown>).Sysctls)
      .toEqual({ "net.ipv4.conf.all.route_localnet": "1" });

    const withoutProxy = fakeDocker();
    await prepare(withoutProxy.docker, contained({ proxyEnabled: false }));
    expect((withoutProxy.created[0].opts.HostConfig as Record<string, unknown>).Sysctls)
      .toBeUndefined();
  });

  it("resolves and dials exactly the session's own allowlist, plus its allow-once hosts", async () => {
    const fake = fakeDocker();

    await prepare(fake.docker, contained());

    expect(launchResolver).toHaveBeenCalledWith(fake.docker, expect.objectContaining({
      agentContainerId: fake.created[0].id,
      configB64: expect.any(String),
    }));
    const dnsmasq = Buffer.from(
      launchResolver.mock.calls[0][1].configB64, "base64",
    ).toString("utf-8");
    for (const host of ["base.example", "extra.example", "once.example"]) {
      expect(dnsmasq).toContain(host);
    }
    expect(launchProxy).toHaveBeenCalledWith(fake.docker, expect.objectContaining({
      allowed: "base.example extra.example once.example",
      sessionId: SESSION,
    }));
  });

  it("gives the namespace no way to resolve the orchestrator", async () => {
    const fake = fakeDocker();
    vi.stubEnv("SHIPIT_ORCHESTRATOR_HOST", "orchestrator.internal");

    await prepare(fake.docker, contained());

    const dnsmasq = Buffer.from(
      launchResolver.mock.calls[0][1].configB64, "base64",
    ).toString("utf-8");
    expect(dnsmasq).not.toContain("orchestrator.internal");
    vi.unstubAllEnvs();
  });

  it("gives the SNI proxy no decision endpoint to ask", async () => {
    const fake = fakeDocker();

    await prepare(fake.docker, contained());

    expect(launchProxy.mock.calls[0][1].decisionUrl).toBeUndefined();
  });

  it("skips a tier the session itself does not run", async () => {
    const fake = fakeDocker();

    await prepare(fake.docker, contained({ dnsEnabled: false, proxyEnabled: false }));

    const installed = installFirewall.mock.calls[0][1];
    expect(installed).not.toHaveProperty("resolverUid");
    expect(installed).not.toHaveProperty("proxyUid");
    expect(launchResolver).not.toHaveBeenCalled();
    expect(launchProxy).not.toHaveBeenCalled();
  });

  it("removes the sidecars and then the holder on release", async () => {
    const fake = fakeDocker();
    const netns = await prepare(fake.docker, contained());
    const holderId = fake.created[0].id;
    fake.setListed([
      { Id: "resolver-1", Labels: { [PLUGIN_NETNS_PARENT_LABEL]: holderId } },
      { Id: "proxy-other", Labels: { [PLUGIN_NETNS_PARENT_LABEL]: "c-99" } },
    ] as unknown as Docker.ContainerInfo[]);

    await netns.release();

    expect(fake.removed).toEqual(["resolver-1", holderId]);
  });
});

describe("what the container reaches and what the card reports", () => {
  it("agree, host by host, including the allow-once decision", async () => {
    _resetEgressPolicies();
    const config = {
      contained: true,
      base: ["base.example"],
      extraHosts: [".suffix.example"],
    };
    allowEgressHost(SESSION, "once.example");

    const fake = fakeDocker();
    await prepare(fake.docker, contained({
      config,
      allowOnceHosts: listEgressAllowedHosts(SESSION),
    }));
    const proxyAllowed = launchProxy.mock.calls[0][1].allowed.split(" ");

    const reportsAllowed = egressHostReach({
      contained: true,
      dnsControlDeployed: true,
      config,
      sessionId: SESSION,
    });
    for (const host of [
      "base.example",
      "api.suffix.example",
      "once.example",
      "denied.example",
    ]) {
      expect({ host, allowed: reportsAllowed(host) === "allowed" }).toEqual({
        host,
        allowed: proxyAllowed.some((entry) => hostMatchesEntry(host, entry)),
      });
    }
    _resetEgressPolicies();
  });

  it("and agree that a floor-only deployment can grant nothing", async () => {
    const config = { contained: true, base: ["base.example"], extraHosts: ["extra.example"] };
    const fake = fakeDocker();
    await prepare(fake.docker, contained({ config, dnsEnabled: false, proxyEnabled: false }));

    expect(launchResolver).not.toHaveBeenCalled();
    expect(launchProxy).not.toHaveBeenCalled();
    const inputs = (installFirewall.mock.calls[0][1] as { inputs: { hosts: string[] } }).inputs;
    expect(inputs.hosts).not.toContain("base.example");
    expect(inputs.hosts).not.toContain("extra.example");

    const reach = egressHostReach({ contained: true, dnsControlDeployed: false, config, sessionId: SESSION });
    expect(reach("base.example")).toBe("blocked-by-deployment");
    expect(reach("extra.example")).toBe("blocked-by-deployment");
    expect(reach("api.anthropic.com")).toBe("allowed");
  });
});

describe("unreachableDeclaredHosts", () => {
  it("names only the declared hosts this session does not already permit", () => {
    expect(unreachableDeclaredHosts(
      contained({
        config: { contained: true, base: ["base.example"], extraHosts: [".suffix.example"] },
        allowOnceHosts: ["once.example"],
      }),
      ["base.example", "api.suffix.example", "once.example", "vendor.example", "VENDOR.example"],
    )).toEqual(["vendor.example"]);
  });

  it("says nothing when the session denies nothing, or the plugin declared nothing", () => {
    expect(unreachableDeclaredHosts(UNCONTAINED_PLUGIN_EGRESS, ["vendor.example"])).toEqual([]);
    expect(unreachableDeclaredHosts(contained(), [])).toEqual([]);
  });

  it("names a host the allowlist carries but a floor-only deployment does not admit", () => {
    expect(unreachableDeclaredHosts(
      contained({
        config: { contained: true, base: ["base.example"], extraHosts: [".suffix.example"] },
        allowOnceHosts: ["once.example"],
        dnsEnabled: false,
        proxyEnabled: false,
      }),
      ["base.example", "api.suffix.example", "once.example", "api.anthropic.com"],
    )).toEqual(["base.example", "api.suffix.example", "once.example"]);
  });
});

describe("preparePluginNetns — failing closed", () => {
  it("refuses when the deployment has no egress sidecar image", async () => {
    const fake = fakeDocker();

    await expect(prepare(fake.docker, contained({ sidecarImage: undefined })))
      .rejects.toThrow(/SESSION_EGRESS_SIDECAR_IMAGE/);
    expect(fake.created).toHaveLength(0);
  });

  it("gives up rather than hanging when a tier install never returns", async () => {
    const fake = fakeDocker();
    installFirewall.mockImplementationOnce(() => new Promise<void>(() => { /* never */ }));

    await expect(preparePluginNetns({
      docker: fake.docker,
      sessionId: SESSION,
      network: NETWORK,
      holderImage: "worker:test",
      policy: contained(),
      setupTimeoutMs: 20,
    })).rejects.toThrow(/did not finish within/);
    expect(fake.removed).toEqual([fake.created[0].id]);
  });

  it("sweeps again when a sidecar appears between the listing and the holder removal", async () => {
    const fake = fakeDocker();
    const netns = await prepare(fake.docker, contained());
    const holderId = fake.created[0].id;
    let holderAttempts = 0;
    fake.failHolderRemove(holderId, () => {
      holderAttempts++;
      if (holderAttempts > 1) return false;
      fake.setListed([
        { Id: "late-sidecar", Labels: { [PLUGIN_NETNS_PARENT_LABEL]: holderId } },
      ] as unknown as Docker.ContainerInfo[]);
      return true;
    });

    await netns.release();

    expect(fake.removed).toContain("late-sidecar");
    expect(fake.removed).toContain(holderId);
  });

  it("logs the holder it could not remove after both sweeps", async () => {
    const fake = fakeDocker();
    const netns = await prepare(fake.docker, contained());
    const holderId = fake.created[0].id;
    fake.failHolderRemove(holderId, () => true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(netns.release()).resolves.toBeUndefined();

      expect(fake.removed).not.toContain(holderId);
      const line = warn.mock.calls.map((c) => c.join(" ")).find((c) => c.includes(holderId));
      expect(line).toBeDefined();
      expect(line).toContain(SESSION);
      expect(line).toContain("cannot remove");
    } finally {
      warn.mockRestore();
    }
  });

  it("logs a sidecar sweep the daemon would not answer", async () => {
    const fake = fakeDocker();
    const netns = await prepare(fake.docker, contained());
    fake.failListing("daemon is not responding");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await netns.release();

      const line = warn.mock.calls.map((c) => c.join(" ")).find((c) => c.includes("daemon is not responding"));
      expect(line).toBeDefined();
      expect(line).toContain(SESSION);
    } finally {
      warn.mockRestore();
    }
  });

  it("logs a sidecar it could not remove", async () => {
    const fake = fakeDocker();
    const netns = await prepare(fake.docker, contained());
    fake.setListed([
      { Id: "resolver-1", Labels: { [PLUGIN_NETNS_PARENT_LABEL]: fake.created[0].id } },
    ] as unknown as Docker.ContainerInfo[]);
    fake.failSidecarRemove("removal already in progress");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await netns.release();

      const line = warn.mock.calls.map((c) => c.join(" ")).find((c) => c.includes("resolver-1"));
      expect(line).toBeDefined();
      expect(line).toContain("removal already in progress");
    } finally {
      warn.mockRestore();
    }
  });

  it("says nothing when the holder comes down cleanly", async () => {
    const fake = fakeDocker();
    const netns = await prepare(fake.docker, contained());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await netns.release();

      expect(fake.removed).toContain(fake.created[0].id);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("tears the holder down and throws when a tier cannot be installed", async () => {
    const fake = fakeDocker();
    installFirewall.mockRejectedValueOnce(new Error("no NET_ADMIN on this host"));

    await expect(prepare(fake.docker, contained())).rejects.toThrow(/NET_ADMIN/);
    expect(fake.removed).toEqual([fake.created[0].id]);
  });
});
