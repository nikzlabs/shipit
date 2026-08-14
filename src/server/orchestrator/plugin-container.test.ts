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

  it("fails closed on an IPv6-only network, not only on an empty one", async () => {
    const { docker } = fakeDocker(["fd00:dead:beef::/64"]);
    await expect(ensureUntrustedPluginNetwork(docker, "shipit-plugin-test"))
      .rejects.toThrow(/no IPv4 subnet to deny/);
  });

  /**
   * The gap this closes (req 19). "Some IPv4 subnet registered" is not the same
   * property as "every address this network hands out is denied": a dual-stack
   * network passes the first and fails the second, because a container on it
   * also holds an IPv6 address in no registered CIDR — which
   * `api-container-guard.ts` reads as a browser or host caller, i.e. more
   * privileged than the agent container this one is isolated from. What sits
   * behind that door is `/api/sessions/<id>/git/credential`, a real GitHub
   * token, which is exactly the fetch credential req 19 says plugin code never
   * sees.
   *
   * **Latent, not live** (review finding): the orchestrator binds `0.0.0.0`
   * (`app-lifecycle.ts`), so no IPv6 listener answers today. The test is here
   * because the alternative is that the boundary opens silently the day the
   * topology gains one — the same reason the subnet is registered before the
   * container starts rather than after.
   */
  it("fails closed on a dual-stack network, whose IPv6 half it cannot deny", async () => {
    const { docker } = fakeDocker(["172.30.0.0/16", "fd00:dead:beef::/64"]);

    await expect(ensureUntrustedPluginNetwork(docker, "shipit-plugin-test"))
      .rejects.toThrow(/cannot deny at its own API/);
    // The IPv4 half is still registered on the way out — refusing to run is the
    // safe answer, and un-registering what did work would not make it safer.
    expect(isUntrustedContainerIp("172.30.4.9")).toBe(true);
  });

  // Pinned at creation rather than only checked afterwards: a daemon that hands
  // new bridge networks an IPv6 subnet would otherwise make every plugin
  // container undeniable, and this call is the only place to say otherwise.
  it("creates the network IPv4-only", async () => {
    const { docker, createSpecs } = fakeDocker(["172.30.0.0/16"]);
    await ensureUntrustedPluginNetwork(docker, "shipit-plugin-test");
    expect(createSpecs[0]).toMatchObject({ Driver: "bridge", EnableIPv6: false });
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
