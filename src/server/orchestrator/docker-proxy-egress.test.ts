import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Docker from "dockerode";

const { installFirewall, allowSubnets, readHostAddresses } = vi.hoisted(() => ({
  installFirewall: vi.fn(async (_docker: unknown, _opts: unknown) => undefined),
  allowSubnets: vi.fn(async (_docker: unknown, _opts: unknown) => [] as string[]),
  readHostAddresses: vi.fn(async (_docker: unknown, _image: string) => ["203.0.113.7"]),
}));

vi.mock("./egress-firewall-install.js", async (load) => ({
  // eslint-disable-next-line no-restricted-syntax -- Vitest partial-module mock typing
  ...(await load<typeof import("./egress-firewall-install.js")>()),
  installEgressFirewall: installFirewall,
  allowEgressToSubnets: allowSubnets,
}));
vi.mock("./local-block.js", async (load) => ({
  // eslint-disable-next-line no-restricted-syntax -- Vitest partial-module mock typing
  ...(await load<typeof import("./local-block.js")>()),
  hostAddresses: readHostAddresses,
}));

import {
  containProxyContainer,
  egressNetworkAttachRefusal,
  prepareProxyContainerStart,
  withProxyStartLock,
  PROXY_EGRESS_SIDECAR_LABEL,
  ProxyEgressRefusal,
  type ProxyEgressTarget,
} from "./docker-proxy-egress.js";
import { NO_TIER_A_INPUTS } from "./egress-firewall-install.js";
import { _setLocalBlockForTest } from "./local-block.js";

const SESSION_ID = "0123456789abcdef-session";
const EGRESS = `shipit-egress-${SESSION_ID}`;
const SESSION_NET = `shipit-session-${SESSION_ID.slice(0, 12)}`;

interface FakeNetwork {
  Name: string;
  Internal: boolean;
  Options?: Record<string, string>;
  IPAM: { Config: { Subnet: string; Gateway?: string }[] };
}

function statusError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

function fakeDocker(events: string[]) {
  const networks = new Map<string, FakeNetwork>([
    [SESSION_NET, {
      Name: SESSION_NET,
      Internal: true,
      Options: { "com.docker.network.bridge.inhibit_ipv4": "true" },
      IPAM: { Config: [{ Subnet: "172.30.0.0/24", Gateway: "172.30.0.1" }] },
    }],
    [EGRESS, { Name: EGRESS, Internal: false, IPAM: { Config: [{ Subnet: "172.31.0.0/24", Gateway: "172.31.0.1" }] } }],
  ]);
  const attached = new Set<string>([SESSION_NET]);
  const inspectInfo = {
    Id: "c-full-id",
    Config: { Labels: { "shipit-parent-session": SESSION_ID } as Record<string, string> },
    HostConfig: { NetworkMode: SESSION_NET, RestartPolicy: { Name: "" } } as Record<string, unknown>,
    State: { Running: true },
  };
  const container = {
    inspect: vi.fn(async () => ({
      ...inspectInfo,
      NetworkSettings: {
        Networks: Object.fromEntries([...attached].map((name) => [name, { NetworkID: `${name}-id` }])),
      },
    })),
    pause: vi.fn(async () => { events.push("pause"); }),
    unpause: vi.fn(async () => { events.push("unpause"); }),
    stop: vi.fn(async (_opts?: unknown) => { events.push("stop"); }),
    remove: vi.fn(async (_opts?: unknown) => { events.push("remove"); }),
  };
  const byRef = (ref: string) => ref.replace(/-id$/, "");
  const connect = vi.fn(async (name: string, _opts: unknown) => {
    events.push(`connect:${name}`);
    attached.add(name);
  });
  const disconnect = vi.fn(async (name: string, _opts: unknown) => {
    events.push(`disconnect:${name}`);
    if (!attached.delete(name)) throw statusError(404, "container is not connected to the network");
  });
  const docker = {
    getContainer: vi.fn(() => container),
    getNetwork: vi.fn((ref: string) => {
      const name = byRef(ref);
      return {
        inspect: vi.fn(async () => {
          const net = networks.get(name);
          if (!net) throw statusError(404, "no such network");
          return net;
        }),
        connect: (opts: unknown) => connect(name, opts),
        disconnect: (opts: unknown) => disconnect(name, opts),
      };
    }),
    listNetworks: vi.fn(async () => [...networks.values()].map((n) => ({ Name: n.Name }))),
    createNetwork: vi.fn(async (opts: { Name: string; Labels: Record<string, string> }) => {
      events.push(`create:${opts.Name}`);
      networks.set(opts.Name, { Name: opts.Name, Internal: false, IPAM: { Config: [{ Subnet: "172.31.0.0/24" }] } });
    }),
  } as unknown as Docker;
  return { docker, container, networks, attached, inspectInfo, connect, disconnect };
}

function target(docker: Docker): ProxyEgressTarget {
  return {
    docker,
    sessionId: SESSION_ID,
    containerId: "c-full-id",
    sidecarImage: "egress:test",
    labels: { "shipit-stack": "shipit-a" },
  };
}

describe("prepareProxyContainerStart", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("detaches the egress network, so the new namespace starts with no route out", async () => {
    const events: string[] = [];
    const fake = fakeDocker(events);
    fake.attached.add(EGRESS);

    await expect(prepareProxyContainerStart(target(fake.docker))).resolves.toBe(true);

    expect(events).toEqual([`disconnect:${EGRESS}`]);
    expect(fake.disconnect).toHaveBeenCalledWith(EGRESS, { Container: "c-full-id", Force: true });
  });

  it("detaches nothing from a container that is not on the egress network", async () => {
    const events: string[] = [];
    const fake = fakeDocker(events);

    await expect(prepareProxyContainerStart(target(fake.docker))).resolves.toBe(true);
    expect(events).toEqual([]);
  });

  it("reports no containment for a container with no network", async () => {
    const events: string[] = [];
    const fake = fakeDocker(events);
    fake.inspectInfo.HostConfig.NetworkMode = "none";
    fake.attached.clear();
    fake.attached.add("none");

    await expect(prepareProxyContainerStart(target(fake.docker))).resolves.toBe(false);
    expect(events).toEqual([]);
  });

  it("refuses a container the session does not own", async () => {
    const fake = fakeDocker([]);
    fake.inspectInfo.Config.Labels = { "shipit-parent-session": "other-session" };

    await expect(prepareProxyContainerStart(target(fake.docker))).rejects.toBeInstanceOf(ProxyEgressRefusal);
  });

  it("refuses a stored restart policy, which Docker would act on without a firewall", async () => {
    const fake = fakeDocker([]);
    fake.inspectInfo.HostConfig.RestartPolicy = { Name: "always" };

    await expect(prepareProxyContainerStart(target(fake.docker))).rejects.toThrow(/RestartPolicy "always"/);
  });

  it("refuses an internal network that gives the host an address on it", async () => {
    const fake = fakeDocker([]);
    delete fake.networks.get(SESSION_NET)!.Options;
    await expect(prepareProxyContainerStart(target(fake.docker))).rejects.toThrow("not internal");
  });

  it("refuses a network that is not internal, which would be a route before the firewall", async () => {
    const fake = fakeDocker([]);
    fake.networks.get(SESSION_NET)!.Internal = false;

    const result = prepareProxyContainerStart(target(fake.docker));
    await expect(result).rejects.toBeInstanceOf(ProxyEgressRefusal);
    await expect(result).rejects.toThrow(`network "${SESSION_NET}" is not internal`);
  });
});

describe("containProxyContainer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installFirewall.mockImplementation(async () => undefined);
    allowSubnets.mockImplementation(async () => []);
    readHostAddresses.mockImplementation(async () => ["203.0.113.7"]);
  });

  it("pauses, attaches egress, installs the open firewall and opens its networks before unpausing", async () => {
    const events: string[] = [];
    const fake = fakeDocker(events);
    installFirewall.mockImplementationOnce(async () => { events.push("firewall"); });
    allowSubnets.mockImplementationOnce(async () => { events.push("allow"); return []; });

    await containProxyContainer(target(fake.docker));

    expect(events).toEqual(["pause", `connect:${EGRESS}`, "firewall", "allow", "unpause"]);
    expect(fake.connect).toHaveBeenCalledWith(EGRESS, { Container: "c-full-id", EndpointConfig: { GwPriority: 1 } });
    // A cached read can still list the gateway of a removed network whose range this one reuses.
    expect(readHostAddresses).toHaveBeenCalledWith(fake.docker, "egress:test", { fresh: true });
    expect(installFirewall).toHaveBeenCalledWith(fake.docker, expect.objectContaining({
      agentContainerId: "c-full-id",
      sidecarImage: "egress:test",
      inputs: NO_TIER_A_INPUTS,
      policy: "open",
      hostAddresses: ["203.0.113.7"],
    }));
    const allow = allowSubnets.mock.calls[0]![1] as { subnets: string[]; gateways: string[] };
    expect(allow.subnets.sort()).toEqual(["172.30.0.0/24", "172.31.0.0/24"]);
    expect(allow.gateways.sort()).toEqual(["172.30.0.1", "172.31.0.1"]);
  });

  it("labels its sidecars for the orphan reaper, and not as the session's own containers", async () => {
    const fake = fakeDocker([]);
    await containProxyContainer(target(fake.docker));

    const labels = (installFirewall.mock.calls[0]![1] as { labels: Record<string, string> }).labels;
    expect(labels).toEqual({
      "shipit-stack": "shipit-a",
      "shipit-egress-parent": "c-full-id",
      [PROXY_EGRESS_SIDECAR_LABEL]: SESSION_ID,
    });
    expect(labels).not.toHaveProperty("shipit-parent-session");
  });

  it("creates the session's egress network, named by the full session id, when it is missing", async () => {
    const events: string[] = [];
    const fake = fakeDocker(events);
    fake.networks.delete(EGRESS);

    await containProxyContainer(target(fake.docker));

    expect(events).toContain(`create:${EGRESS}`);
    expect(fake.docker.createNetwork).toHaveBeenCalledWith(expect.objectContaining({
      Name: EGRESS,
      Internal: false,
      Labels: { "shipit-stack": "shipit-a", "shipit-parent-session": SESSION_ID },
    }));
  });

  it("detaches egress, then stops the container, when the firewall cannot be installed", async () => {
    const events: string[] = [];
    const fake = fakeDocker(events);
    installFirewall.mockRejectedValueOnce(new Error("iptables failed"));

    await expect(containProxyContainer(target(fake.docker))).rejects.toThrow("iptables failed");

    expect(events).toEqual(["pause", `connect:${EGRESS}`, `disconnect:${EGRESS}`, "unpause", "stop"]);
    expect(fake.container.stop).toHaveBeenCalledWith({ t: 0 });
    expect(fake.attached.has(EGRESS)).toBe(false);
  });

  it("fails closed when the subnet rules cannot be installed", async () => {
    const events: string[] = [];
    const fake = fakeDocker(events);
    allowSubnets.mockRejectedValueOnce(new Error("allow-subnet failed"));

    await expect(containProxyContainer(target(fake.docker))).rejects.toThrow("allow-subnet failed");
    expect(events.slice(-3)).toEqual([`disconnect:${EGRESS}`, "unpause", "stop"]);
  });

  it("removes the container when it cannot be stopped", async () => {
    const events: string[] = [];
    const fake = fakeDocker(events);
    installFirewall.mockRejectedValueOnce(new Error("iptables failed"));
    fake.container.stop.mockRejectedValueOnce(statusError(500, "stop failed"));

    await expect(containProxyContainer(target(fake.docker))).rejects.toThrow("iptables failed");
    expect(fake.container.remove).toHaveBeenCalledWith({ force: true });
  });

  it("removes the still-paused container, never unpausing it, when egress cannot be detached", async () => {
    const events: string[] = [];
    const fake = fakeDocker(events);
    installFirewall.mockRejectedValueOnce(new Error("iptables failed"));
    fake.disconnect.mockImplementationOnce(async () => { throw statusError(500, "daemon busy"); });

    await expect(containProxyContainer(target(fake.docker))).rejects.toThrow("iptables failed");
    expect(fake.container.unpause).not.toHaveBeenCalled();
    expect(fake.container.stop).not.toHaveBeenCalled();
    expect(fake.container.remove).toHaveBeenCalledWith({ force: true });
  });

  it("fails closed, before any route out, when the host's addresses cannot be read", async () => {
    const events: string[] = [];
    const fake = fakeDocker(events);
    readHostAddresses.mockRejectedValueOnce(new Error("could not read the host's addresses (exit 1)"));

    await expect(containProxyContainer(target(fake.docker))).rejects.toThrow("host's addresses");
    expect(fake.connect).not.toHaveBeenCalled();
    expect(installFirewall).not.toHaveBeenCalled();
    expect(events).toContain("stop");
  });

  it("does nothing for a container that exited before it could be paused", async () => {
    const fake = fakeDocker([]);
    fake.container.pause.mockRejectedValueOnce(statusError(409, "container is not running"));
    fake.inspectInfo.State.Running = false;

    await expect(containProxyContainer(target(fake.docker))).resolves.toBeUndefined();
    expect(fake.connect).not.toHaveBeenCalled();
    expect(installFirewall).not.toHaveBeenCalled();
  });

  it("does nothing for a container Docker already removed", async () => {
    const fake = fakeDocker([]);
    fake.container.pause.mockRejectedValueOnce(statusError(404, "no such container"));
    fake.container.inspect.mockRejectedValueOnce(statusError(404, "no such container"));

    await expect(containProxyContainer(target(fake.docker))).resolves.toBeUndefined();
    expect(fake.connect).not.toHaveBeenCalled();
  });

  it("stops a container that is still running when the pause fails", async () => {
    const events: string[] = [];
    const fake = fakeDocker(events);
    fake.container.pause.mockRejectedValueOnce(statusError(500, "pause failed"));

    await expect(containProxyContainer(target(fake.docker))).rejects.toThrow("pause failed");
    expect(events).toContain("stop");
    expect(fake.connect).not.toHaveBeenCalled();
  });
});

describe("withProxyStartLock", () => {
  it("runs a second start of the same container only after the first has finished", async () => {
    const fake = fakeDocker([]);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = withProxyStartLock(fake.docker, "web", async (id) => {
      order.push(`first:${id}`);
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push("first done");
    });
    const second = withProxyStartLock(fake.docker, "c-full-id", async () => { order.push("second"); });

    await vi.waitFor(() => expect(order).toEqual(["first:c-full-id"]));
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:c-full-id", "first done", "second"]);
  });

  it("still runs the next start when the previous one failed", async () => {
    const fake = fakeDocker([]);
    await expect(withProxyStartLock(fake.docker, "c", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(withProxyStartLock(fake.docker, "c", async () => "ran")).resolves.toBe("ran");
  });
});

describe("egressNetworkAttachRefusal", () => {
  afterEach(() => { _setLocalBlockForTest(false); });

  it("refuses nothing while the block is inactive", () => {
    _setLocalBlockForTest(false);
    expect(egressNetworkAttachRefusal("n", { name: EGRESS })).toBeUndefined();
    expect(egressNetworkAttachRefusal("n", {})).toBeUndefined();
  });

  it("refuses an egress network by the name Docker holds, whatever the caller called it", () => {
    _setLocalBlockForTest(true);
    expect(egressNetworkAttachRefusal("3f2a", { name: EGRESS })).toMatch(/"3f2a" is a ShipIt egress network/);
    expect(egressNetworkAttachRefusal(SESSION_NET, { name: SESSION_NET })).toBeUndefined();
  });

  it("refuses a network whose name it cannot read", () => {
    _setLocalBlockForTest(true);
    expect(egressNetworkAttachRefusal("n", {})).toMatch(/no name/);
  });
});
