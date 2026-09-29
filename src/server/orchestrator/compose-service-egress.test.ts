import { beforeEach, describe, expect, it, vi } from "vitest";
import type Docker from "dockerode";

const { installFirewall, allowSubnets, launchResolver, launchProxy, buildInputs } = vi.hoisted(() => ({
  installFirewall: vi.fn(async () => undefined),
  allowSubnets: vi.fn(async () => ["172.30.0.0/24"]),
  launchResolver: vi.fn(async () => "resolver-id"),
  launchProxy: vi.fn(async () => "proxy-id"),
  buildInputs: vi.fn(async () => ({ hosts: ["api.github.com"], cidrs: [] })),
}));

vi.mock("./egress-firewall-install.js", async (load) => ({
  // eslint-disable-next-line no-restricted-syntax -- Vitest partial-module mock typing
  ...(await load<typeof import("./egress-firewall-install.js")>()),
  buildTierAEgressInputs: buildInputs,
  installEgressFirewall: installFirewall,
  allowEgressToSubnets: allowSubnets,
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

import { containComposeServices } from "./compose-service-egress.js";
import { NO_TIER_A_INPUTS } from "./egress-firewall-install.js";

function fakeDocker(events: string[]) {
  const container = {
    pause: vi.fn(async () => { events.push("pause"); }),
    inspect: vi.fn(async (): Promise<{ State: { Paused: boolean; StartedAt?: string } }> => ({
      State: { Paused: false },
    })),
    unpause: vi.fn(async () => { events.push("unpause"); }),
    remove: vi.fn(async () => { events.push("remove"); }),
    stop: vi.fn(async () => { events.push("stop"); }),
  };
  const network = {
    connect: vi.fn(async () => { events.push("connect"); }),
    disconnect: vi.fn(async () => undefined),
    inspect: vi.fn(async (): Promise<{ Internal: boolean; IPAM: { Config: { Subnet: string; Gateway?: string }[] } }> => ({
      Internal: true,
      IPAM: { Config: [{ Subnet: "172.30.0.0/24" }] },
    })),
  };
  const docker = {
    version: vi.fn(async () => ({ ApiVersion: "1.48" })),
    listContainers: vi.fn(async () => [{
      Id: "service-1",
      State: "running",
      Labels: { "shipit-service-name": "web", "shipit-parent-session": "session-1" },
    }]),
    listNetworks: vi.fn(async () => [{ Name: "shipit-egress-session-1" }]),
    createNetwork: vi.fn(async () => undefined),
    getNetwork: vi.fn(() => network),
    getContainer: vi.fn(() => container),
  } as unknown as Docker;
  return { docker, container, network };
}

describe("containComposeServices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pauses before attaching egress and resumes only after all tiers are installed", async () => {
    const events: string[] = [];
    const { docker } = fakeDocker(events);
    installFirewall.mockImplementationOnce(async () => { events.push("firewall"); });
    launchResolver.mockImplementationOnce(async () => { events.push("resolver"); return "resolver-id"; });
    launchProxy.mockImplementationOnce(async () => { events.push("proxy"); return "proxy-id"; });

    await containComposeServices({
      docker,
      sessionId: "session-1",
      sidecarImage: "egress:test",
      config: { contained: true, extraHosts: ["packages.example"] },
      serviceNames: ["web"],
      dnsEnabled: true,
      proxyEnabled: true,
      orchestratorHost: "orchestrator",
    });

    expect(events).toEqual(["pause", "connect", "firewall", "resolver", "proxy", "unpause"]);
    expect(allowSubnets).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      subnets: ["172.30.0.0/24"],
    }));
  });

  it("removes the paused service when containment setup fails", async () => {
    const events: string[] = [];
    const { docker, container } = fakeDocker(events);
    installFirewall.mockRejectedValueOnce(new Error("iptables failed"));

    await expect(containComposeServices({
      docker,
      sessionId: "session-1",
      sidecarImage: "egress:test",
      config: { contained: true, extraHosts: [] },
      serviceNames: ["web"],
      dnsEnabled: true,
      proxyEnabled: true,
    })).rejects.toThrow("egress containment failed for 1 Compose service");

    expect(container.unpause).toHaveBeenCalled();
    expect(events).toEqual(["pause", "connect", "unpause", "stop"]);
  });

  it("force-removes a service when stop and NAT detach both fail", async () => {
    const events: string[] = [];
    const { docker, container, network } = fakeDocker(events);
    installFirewall.mockRejectedValueOnce(new Error("iptables failed"));
    container.stop.mockRejectedValueOnce(new Error("stop failed"));
    network.disconnect = vi.fn(async () => { throw new Error("disconnect failed"); });

    await expect(containComposeServices({
      docker,
      sessionId: "session-1",
      sidecarImage: "egress:test",
      config: { contained: true, extraHosts: [] },
      serviceNames: ["web"],
      dnsEnabled: true,
      proxyEnabled: true,
    })).rejects.toThrow("egress containment failed for 1 Compose service");

    expect(container.remove).toHaveBeenCalledWith({ force: true });
  });

  it("gives an open session the open firewall with no allowlist, resolver or proxy", async () => {
    const events: string[] = [];
    const { docker } = fakeDocker(events);
    installFirewall.mockImplementationOnce(async () => { events.push("firewall"); });
    await containComposeServices({
      docker,
      sessionId: "session-1",
      sidecarImage: "egress:test",
      config: { contained: false, extraHosts: ["packages.example"] },
      serviceNames: ["web"],
      dnsEnabled: true,
      proxyEnabled: true,
    });
    expect(events).toEqual(["pause", "connect", "firewall", "unpause"]);
    expect(installFirewall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      policy: "open",
      inputs: NO_TIER_A_INPUTS,
      resolverUid: undefined,
      proxyUid: undefined,
      proxyPort: undefined,
    }));
    expect(buildInputs).not.toHaveBeenCalled();
    expect(launchResolver).not.toHaveBeenCalled();
    expect(launchProxy).not.toHaveBeenCalled();
  });

  it("lets an explicit open policy override a contained config", async () => {
    const events: string[] = [];
    const { docker } = fakeDocker(events);
    await containComposeServices({
      docker,
      sessionId: "session-1",
      sidecarImage: "egress:test",
      config: { contained: true, extraHosts: [] },
      serviceNames: ["web"],
      policy: "open",
      dnsEnabled: true,
      proxyEnabled: true,
    });
    expect(installFirewall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ policy: "open" }));
    expect(launchResolver).not.toHaveBeenCalled();
    expect(launchProxy).not.toHaveBeenCalled();
  });

  it.each(["contained", "open"] as const)(
    "passes the host's addresses and both networks' gateways under the %s policy",
    async (policy) => {
      const events: string[] = [];
      const { docker, network } = fakeDocker(events);
      const egress = {
        ...network,
        inspect: vi.fn(async () => ({ Internal: false, IPAM: { Config: [{ Subnet: "172.31.0.0/24" }] } })),
      };
      vi.mocked(docker.getNetwork).mockImplementation((name) => (
        name === "shipit-egress-session-1" ? egress : network
      ) as never);
      network.inspect.mockResolvedValue({
        Internal: true,
        IPAM: { Config: [{ Subnet: "172.30.0.0/24", Gateway: "172.30.0.254" }] },
      });

      await containComposeServices({
        docker,
        sessionId: "session-1",
        sidecarImage: "egress:test",
        config: { contained: policy === "contained", extraHosts: [] },
        serviceNames: ["web"],
        hostAddresses: ["203.0.113.7"],
        dnsEnabled: false,
        proxyEnabled: false,
      });

      expect(installFirewall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        policy,
        hostAddresses: ["203.0.113.7"],
      }));
      expect(allowSubnets).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        subnets: ["172.30.0.0/24", "172.31.0.0/24"],
        gateways: ["172.30.0.254", "172.31.0.1"],
      }));
    },
  );

  it("reinstalls a service's firewall when the policy changes", async () => {
    const events: string[] = [];
    const { docker, container } = fakeDocker(events);
    container.inspect.mockResolvedValue({ State: { Paused: false, StartedAt: "2026-09-29T00:00:00Z" } });
    const run = (policy: "contained" | "open") => containComposeServices({
      docker,
      sessionId: "session-policy",
      sidecarImage: "egress:test",
      config: { contained: true, extraHosts: [] },
      serviceNames: ["web"],
      policy,
      dnsEnabled: false,
      proxyEnabled: false,
    });

    await run("open");
    await run("open");
    expect(installFirewall).toHaveBeenCalledTimes(1);
    await run("contained");
    expect(installFirewall).toHaveBeenCalledTimes(2);
    expect(installFirewall).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      policy: "contained",
    }));
  });

  it("refuses an open-policy service whose session network is not internal", async () => {
    const events: string[] = [];
    const { docker, network, container } = fakeDocker(events);
    network.inspect.mockResolvedValue({ Internal: false, IPAM: { Config: [] } });
    await expect(containComposeServices({
      docker,
      sessionId: "session-1",
      sidecarImage: "egress:test",
      config: { contained: false, extraHosts: [] },
      serviceNames: ["web"],
      dnsEnabled: false,
      proxyEnabled: false,
    })).rejects.toThrow("is not internal");
    expect(container.stop).toHaveBeenCalledWith({ t: 0 });
    expect(installFirewall).not.toHaveBeenCalled();
  });

  it("tolerates an existing egress-network endpoint and still reinstalls containment", async () => {
    const events: string[] = [];
    const { docker, network, container } = fakeDocker(events);
    network.connect.mockRejectedValueOnce(Object.assign(new Error("endpoint already exists"), { statusCode: 403 }));
    await containComposeServices({
      docker,
      sessionId: "session-1",
      sidecarImage: "egress:test",
      config: { contained: true, extraHosts: [] },
      serviceNames: ["web"],
      dnsEnabled: false,
      proxyEnabled: false,
    });
    expect(installFirewall).toHaveBeenCalled();
    expect(container.remove).not.toHaveBeenCalled();
    expect(container.unpause).toHaveBeenCalled();
  });

  it("fails closed on an unrelated network authorization error", async () => {
    const events: string[] = [];
    const { docker, network, container } = fakeDocker(events);
    network.connect.mockRejectedValueOnce(Object.assign(new Error("authorization denied"), { statusCode: 403 }));
    await expect(containComposeServices({
      docker,
      sessionId: "session-1",
      sidecarImage: "egress:test",
      config: { contained: true, extraHosts: [] },
      serviceNames: ["web"],
      dnsEnabled: false,
      proxyEnabled: false,
    })).rejects.toThrow("egress containment failed for 1 Compose service");
    expect(container.stop).toHaveBeenCalled();
  });

  it("ignores the exact stale unpause error after Compose replaces the service", async () => {
    const events: string[] = [];
    const { docker, container } = fakeDocker(events);
    const oldResolver = { remove: vi.fn(async () => undefined) };
    vi.mocked(docker.getContainer).mockImplementation((id) => (
      id === "old-resolver" ? oldResolver : container
    ) as never);
    container.unpause.mockRejectedValueOnce(new Error("Container service-1 is not paused"));
    vi.mocked(docker.listContainers)
      .mockResolvedValueOnce([{
        Id: "service-1",
        State: "running",
        Labels: { "shipit-service-name": "web", "shipit-parent-session": "session-1" },
      }] as never)
      .mockResolvedValueOnce([{
        Id: "service-2",
        State: "running",
        Labels: { "shipit-service-name": "web", "shipit-parent-session": "session-1" },
      }] as never)
      .mockResolvedValueOnce([{
        Id: "old-resolver",
        State: "running",
        Labels: {
          "shipit-egress-service-sidecar": "true",
          "shipit-egress-parent": "service-1",
          "shipit-parent-session": "session-1",
        },
      }] as never);

    await expect(containComposeServices({
      docker,
      sessionId: "session-1",
      sidecarImage: "egress:test",
      config: { contained: true, extraHosts: [] },
      serviceNames: ["web"],
      dnsEnabled: false,
      proxyEnabled: false,
    })).resolves.toBeUndefined();

    expect(oldResolver.remove).toHaveBeenCalledWith({ force: true });
    expect(container.remove).toHaveBeenCalledWith({ force: true });
  });

  it("fails closed on the same unpause error when the container is still active", async () => {
    const events: string[] = [];
    const { docker, container } = fakeDocker(events);
    container.unpause.mockRejectedValue(new Error("Container service-1 is not paused"));

    await expect(containComposeServices({
      docker,
      sessionId: "session-1",
      sidecarImage: "egress:test",
      config: { contained: true, extraHosts: [] },
      serviceNames: ["web"],
      dnsEnabled: false,
      proxyEnabled: false,
    })).rejects.toThrow("egress containment failed for 1 Compose service");
    expect(container.remove).toHaveBeenCalledWith({ force: true });
  });

  it("fails closed when the same container is restarting", async () => {
    const events: string[] = [];
    const { docker, container, network } = fakeDocker(events);
    container.pause.mockRejectedValueOnce(new Error("container is restarting, cannot pause"));
    vi.mocked(docker.listContainers)
      .mockResolvedValueOnce([{
        Id: "service-1",
        State: "running",
        Labels: { "shipit-service-name": "web", "shipit-parent-session": "session-1" },
      }] as never)
      .mockResolvedValueOnce([{
        Id: "service-1",
        State: "restarting",
        Labels: { "shipit-service-name": "web", "shipit-parent-session": "session-1" },
      }] as never);

    await expect(containComposeServices({
      docker,
      sessionId: "session-1",
      sidecarImage: "egress:test",
      config: { contained: true, extraHosts: [] },
      serviceNames: ["web"],
      dnsEnabled: false,
      proxyEnabled: false,
    })).rejects.toThrow("egress containment failed for 1 Compose service");
    expect(network.disconnect).toHaveBeenCalledWith({ Container: "service-1", Force: true });
  });

  it("rejects Docker engines without gateway-priority support", async () => {
    const events: string[] = [];
    const { docker } = fakeDocker(events);
    vi.mocked(docker.version).mockResolvedValueOnce({ ApiVersion: "1.47" } as never);
    await expect(containComposeServices({
      docker,
      sessionId: "session-1",
      sidecarImage: "egress:test",
      config: { contained: true, extraHosts: [] },
      serviceNames: ["web"],
      dnsEnabled: false,
      proxyEnabled: false,
    })).rejects.toThrow("API 1.48 or newer");
  });

  it("does not require a new engine when there are no Compose services", async () => {
    const events: string[] = [];
    const { docker } = fakeDocker(events);
    vi.mocked(docker.listContainers).mockResolvedValueOnce([]);
    vi.mocked(docker.version).mockResolvedValueOnce({ ApiVersion: "1.47" } as never);
    await expect(containComposeServices({
      docker,
      sessionId: "session-1",
      sidecarImage: "egress:test",
      config: { contained: true, extraHosts: [] },
      serviceNames: [],
      dnsEnabled: false,
      proxyEnabled: false,
    })).resolves.toBeUndefined();
    expect(docker.version).not.toHaveBeenCalled();
  });

  it("fails closed when the intra-session subnet cannot be reopened", async () => {
    const events: string[] = [];
    const { docker, container } = fakeDocker(events);
    allowSubnets.mockRejectedValueOnce(new Error("subnet rule failed"));
    await expect(containComposeServices({
      docker,
      sessionId: "session-1",
      sidecarImage: "egress:test",
      config: { contained: true, extraHosts: [] },
      serviceNames: ["web"],
      dnsEnabled: false,
      proxyEnabled: false,
    })).rejects.toThrow("egress containment failed for 1 Compose service");
    expect(container.stop).toHaveBeenCalledWith({ t: 0 });
  });

  it("removes a service left paused by an interrupted containment pass", async () => {
    const events: string[] = [];
    const { docker, container } = fakeDocker(events);
    container.inspect.mockResolvedValueOnce({ State: { Paused: true } });
    await expect(containComposeServices({
      docker,
      sessionId: "session-1",
      sidecarImage: "egress:test",
      config: { contained: true, extraHosts: [] },
      serviceNames: ["web"],
      dnsEnabled: true,
      proxyEnabled: true,
    })).rejects.toThrow("egress containment failed for 1 Compose service");
    expect(container.stop).toHaveBeenCalledWith({ t: 0 });
    expect(container.unpause).toHaveBeenCalled();
  });
});
