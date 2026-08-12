import { beforeEach, describe, expect, it, vi } from "vitest";
import type Docker from "dockerode";

const { installFirewall, launchResolver, launchProxy } = vi.hoisted(() => ({
  installFirewall: vi.fn(async () => undefined),
  launchResolver: vi.fn(async () => "resolver-id"),
  launchProxy: vi.fn(async () => "proxy-id"),
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

import { containComposeServices } from "./compose-service-egress.js";

function fakeDocker(events: string[]) {
  const container = {
    pause: vi.fn(async () => { events.push("pause"); }),
    unpause: vi.fn(async () => { events.push("unpause"); }),
    remove: vi.fn(async () => { events.push("remove"); }),
    stop: vi.fn(async () => { events.push("stop"); }),
  };
  const network = {
    connect: vi.fn(async () => { events.push("connect"); }),
  };
  const docker = {
    listContainers: vi.fn(async () => [{
      Id: "service-1",
      Labels: { "shipit-service-name": "web", "shipit-parent-session": "session-1" },
    }]),
    listNetworks: vi.fn(async () => [{ Name: "shipit-egress-session-1" }]),
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
    })).rejects.toThrow("iptables failed");

    expect(container.unpause).not.toHaveBeenCalled();
    expect(events).toEqual(["pause", "connect", "remove", "stop"]);
  });

  it("does nothing for an open session", async () => {
    const events: string[] = [];
    const { docker } = fakeDocker(events);
    await containComposeServices({
      docker,
      sessionId: "session-1",
      sidecarImage: "egress:test",
      config: { contained: false, extraHosts: [] },
      serviceNames: ["web"],
      dnsEnabled: true,
      proxyEnabled: true,
    });
    expect(events).toEqual([]);
  });
});
