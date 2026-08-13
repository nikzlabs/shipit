/**
 * docs/262 — the shared plugin-container primitives.
 *
 * The network one is a security control, so its failure mode is what matters:
 * a network ShipIt cannot deny at its own API must stop the container from
 * starting, not be logged and stepped over.
 */

import { describe, it, expect, afterEach } from "vitest";
import type Docker from "dockerode";
import { ensureUntrustedPluginNetwork, waitForContainerExit } from "./plugin-container.js";
import { clearUntrustedContainerNetworks, isUntrustedContainerIp } from "./api-container-guard.js";

afterEach(() => {
  clearUntrustedContainerNetworks();
});

function fakeDocker(subnets: string[] | null) {
  const created: string[] = [];
  const notFound = (): never => {
    throw Object.assign(new Error("no such network"), { statusCode: 404 });
  };
  return {
    created,
    docker: {
      getNetwork: (name: string) => ({
        inspect: async () => {
          if (!created.includes(name)) notFound();
          return { IPAM: { Config: (subnets ?? []).map((Subnet) => ({ Subnet })) } };
        },
      }),
      createNetwork: async (spec: { Name: string }) => { created.push(spec.Name); },
    } as unknown as Docker,
  };
}

describe("ensureUntrustedPluginNetwork", () => {
  it("creates the network and denies its whole subnet at ShipIt's API", async () => {
    const { docker, created } = fakeDocker(["172.30.0.0/16"]);
    await ensureUntrustedPluginNetwork(docker, "shipit-plugin-test");

    expect(created).toEqual(["shipit-plugin-test"]);
    // The subnet is registered BEFORE any container joins, so the first request
    // out of it — the one worth making — is already denied.
    expect(isUntrustedContainerIp("172.30.4.9")).toBe(true);
  });

  it("is idempotent — an existing network is inspected, not recreated", async () => {
    const { docker, created } = fakeDocker(["172.30.0.0/16"]);
    await ensureUntrustedPluginNetwork(docker, "shipit-plugin-test");
    await ensureUntrustedPluginNetwork(docker, "shipit-plugin-test");
    expect(created).toEqual(["shipit-plugin-test"]);
  });

  it("fails closed when there is no IPv4 subnet to deny", async () => {
    // The guard's CIDR match is IPv4-only, so an IPv6-only network would leave
    // the container indistinguishable from a browser or host caller.
    const { docker } = fakeDocker([]);
    await expect(ensureUntrustedPluginNetwork(docker, "shipit-plugin-test"))
      .rejects.toThrow(/no IPv4 subnet to deny/);
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

  // The bounded reap: a kill that does not work must not turn a nominal
  // timeout into an unbounded hang holding the generation's volume.
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
