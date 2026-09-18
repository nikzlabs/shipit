import { describe, it, expect, afterEach } from "vitest";
import type Docker from "dockerode";
import {
  ensureUntrustedPluginNetwork,
  registerExistingPluginNetworks,
  waitForContainerExit,
} from "./plugin-container.js";
import { clearUntrustedContainerNetworks, isUntrustedContainerIp } from "./api-container-guard.js";

afterEach(() => {
  clearUntrustedContainerNetworks();
});

function fakeDocker(subnets: string[] | null) {
  const created: string[] = [];
  const createSpecs: Record<string, unknown>[] = [];
  const notFound = (): never => {
    throw Object.assign(new Error("no such network"), { statusCode: 404 });
  };
  return {
    created,
    createSpecs,
    docker: {
      getNetwork: (name: string) => ({
        inspect: async () => {
          if (!created.includes(name)) notFound();
          return { IPAM: { Config: (subnets ?? []).map((Subnet) => ({ Subnet })) } };
        },
      }),
      createNetwork: async (spec: { Name: string }) => {
        createSpecs.push(spec);
        created.push(spec.Name);
      },
    } as unknown as Docker,
  };
}

describe("ensureUntrustedPluginNetwork", () => {
  it("creates the network and denies its whole subnet at ShipIt's API", async () => {
    const { docker, created } = fakeDocker(["172.30.0.0/16"]);
    await ensureUntrustedPluginNetwork(docker, "shipit-plugin-test");

    expect(created).toEqual(["shipit-plugin-test"]);
    expect(isUntrustedContainerIp("172.30.4.9")).toBe(true);
  });

  it("is idempotent — an existing network is inspected, not recreated", async () => {
    const { docker, created } = fakeDocker(["172.30.0.0/16"]);
    await ensureUntrustedPluginNetwork(docker, "shipit-plugin-test");
    await ensureUntrustedPluginNetwork(docker, "shipit-plugin-test");
    expect(created).toEqual(["shipit-plugin-test"]);
  });

  it("fails closed when there is no IPv4 subnet to deny", async () => {
    const { docker } = fakeDocker([]);
    await expect(ensureUntrustedPluginNetwork(docker, "shipit-plugin-test"))
      .rejects.toThrow(/no IPv4 subnet to deny/);
  });

  it("fails closed on an IPv6-only network, not only on an empty one", async () => {
    const { docker } = fakeDocker(["fd00:dead:beef::/64"]);
    await expect(ensureUntrustedPluginNetwork(docker, "shipit-plugin-test"))
      .rejects.toThrow(/no IPv4 subnet to deny/);
  });

  it("fails closed on a dual-stack network, whose IPv6 half it cannot deny", async () => {
    const { docker } = fakeDocker(["172.30.0.0/16", "fd00:dead:beef::/64"]);

    await expect(ensureUntrustedPluginNetwork(docker, "shipit-plugin-test"))
      .rejects.toThrow(/cannot deny at its own API/);
    expect(isUntrustedContainerIp("172.30.4.9")).toBe(true);
  });

  it("creates the network IPv4-only", async () => {
    const { docker, createSpecs } = fakeDocker(["172.30.0.0/16"]);
    await ensureUntrustedPluginNetwork(docker, "shipit-plugin-test");
    expect(createSpecs[0]).toMatchObject({ Driver: "bridge", EnableIPv6: false });
  });
});

describe("registerExistingPluginNetworks", () => {
  it("re-denies the subnets of networks a previous process left behind", async () => {
    const { docker, created } = fakeDocker(["172.30.0.0/16"]);
    created.push("shipit-plugin-cli");
    expect(isUntrustedContainerIp("172.30.4.9")).toBe(false);

    await registerExistingPluginNetworks(docker, ["shipit-plugin-cli"]);

    expect(isUntrustedContainerIp("172.30.4.9")).toBe(true);
  });

  it("creates nothing for a network that does not exist", async () => {
    const { docker, createSpecs } = fakeDocker(["172.30.0.0/16"]);

    await registerExistingPluginNetworks(docker, ["shipit-plugin-cli"]);

    expect(createSpecs).toEqual([]);
  });

  it("warns rather than throwing on a subnet it cannot deny", async () => {
    const { docker, created } = fakeDocker(["fd00:dead:beef::/64"]);
    created.push("shipit-plugin-cli");

    await expect(registerExistingPluginNetworks(docker, ["shipit-plugin-cli"]))
      .resolves.toBeUndefined();
  });
});

describe("waitForContainerExit", () => {
  it("returns the container's status code", async () => {
    const container = {
      wait: async () => ({ StatusCode: 7 }),
      kill: async () => undefined,
    } as unknown as Docker.Container;
    expect(await waitForContainerExit(container, 5_000)).toBe(7);
  });

  it("gives up on a container whose kill never settles the wait", async () => {
    let killed = false;
    const container = {
      wait: () => new Promise<{ StatusCode: number }>(() => undefined),
      kill: async () => { killed = true; },
    } as unknown as Docker.Container;

    expect(await waitForContainerExit(container, 1)).toBe("timeout");
    expect(killed).toBe(true);
  }, 20_000);
});
