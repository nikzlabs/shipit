/**
 * Containers the agent starts through the Docker proxy get the open-policy firewall, so they
 * cannot reach this machine, private networks or the tailnet (docs/319-api-reach-through-host
 * req 8, plan §3a). The container starts on internal networks only; the egress network, its one
 * route out, is connected while it is paused and before it runs again.
 */
import type Docker from "dockerode";
import {
  COMPOSE_EGRESS_NETWORK_PREFIX,
  ensureEgressNetwork,
} from "./compose-service-egress.js";
import {
  allowEgressToSubnets,
  installEgressFirewall,
  NO_TIER_A_INPUTS,
} from "./egress-firewall-install.js";
import { extractNetworkGateways, extractNetworkSubnets } from "./egress-firewall.js";
import { EGRESS_PARENT_LABEL } from "./egress-orphan-reaper.js";
import { hostAddresses, localBlockActive } from "./local-block.js";
import { PARENT_SESSION_LABEL } from "./docker-proxy-helpers.js";

/**
 * Sidecars carry no `shipit-parent-session`, so the proxy's ownership checks never let the
 * session exec into one while it holds NET_ADMIN in the container's namespace.
 */
export const PROXY_EGRESS_SIDECAR_LABEL = "shipit-docker-proxy-egress-sidecar";

/** A start the proxy refuses; the caller answers 403 with this message. */
export class ProxyEgressRefusal extends Error {}

export interface ProxyEgressTarget {
  docker: Docker;
  sessionId: string;
  /** The container's full id. */
  containerId: string;
  sidecarImage: string;
  /** Ownership labels for what this creates (the stack label). */
  labels: Record<string, string>;
}

export function isEgressNetworkName(name: string): boolean {
  return name.startsWith(COMPOSE_EGRESS_NETWORK_PREFIX);
}

function egressNetworkName(sessionId: string): string {
  return `${COMPOSE_EGRESS_NETWORK_PREFIX}${sessionId}`;
}

function statusCode(error: unknown): number {
  return error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 0;
}

function notConnected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return statusCode(error) === 404 || /not connected|no such network|not found/i.test(message);
}

type Endpoints = Record<string, { NetworkID?: string } | undefined>;

function endpointsOf(info: Docker.ContainerInspectInfo): Endpoints {
  return info.NetworkSettings?.Networks ?? {};
}

const startLocks = new Map<string, Promise<unknown>>();

/**
 * Serialises starts and restarts of one container: a second one in between could give the new
 * namespace the egress route, or unpause it, before its own firewall is in.
 */
export async function withProxyStartLock<T>(
  docker: Docker,
  containerRef: string,
  fn: (containerId: string) => Promise<T>,
): Promise<T> {
  const { Id: id } = await docker.getContainer(containerRef).inspect();
  const previous = startLocks.get(id);
  const run = (async () => {
    await previous;
    return fn(id);
  })();
  const tail = run.catch(() => undefined);
  startLocks.set(id, tail);
  try {
    return await run;
  } finally {
    if (startLocks.get(id) === tail) startLocks.delete(id);
  }
}

/**
 * Before Docker starts the container: a new namespace has no firewall, so the egress network must
 * not be attached when it comes up. False when the container has no network at all.
 */
export async function prepareProxyContainerStart(target: ProxyEgressTarget): Promise<boolean> {
  const { docker, containerId, sessionId } = target;
  const info = await docker.getContainer(containerId).inspect();
  if (info.Config?.Labels?.[PARENT_SESSION_LABEL] !== sessionId) {
    throw new ProxyEgressRefusal("Container does not belong to this session");
  }
  if (info.HostConfig?.NetworkMode === "none") return false;

  const restartPolicy = info.HostConfig?.RestartPolicy?.Name;
  if (restartPolicy && restartPolicy !== "no") {
    throw new ProxyEgressRefusal(
      `the container has RestartPolicy "${restartPolicy}", and Docker would restart it without the firewall `
        + "that keeps it away from this machine and private networks; remove it and create it without one",
    );
  }

  const egressName = egressNetworkName(sessionId);
  const endpoints = endpointsOf(info);
  for (const [name, endpoint] of Object.entries(endpoints)) {
    if (name === egressName) continue;
    const network = await docker.getNetwork(endpoint?.NetworkID || name).inspect() as {
      Internal?: boolean;
      Options?: Record<string, string>;
    };
    if (!network.Internal || network.Options?.["com.docker.network.bridge.inhibit_ipv4"] !== "true") {
      throw new ProxyEgressRefusal(
        `network "${name}" is not internal, so the container would reach this machine and private networks `
          + "before ShipIt's firewall is in place; use a network created through this Docker access instead",
      );
    }
  }

  if (endpoints[egressName]) {
    try {
      await docker.getNetwork(egressName).disconnect({ Container: containerId, Force: true });
    } catch (error) {
      if (!notConnected(error)) throw error;
    }
  }
  return true;
}

async function networkRanges(
  docker: Docker,
  refs: Iterable<string>,
): Promise<{ subnets: string[]; gateways: string[] }> {
  const subnets = new Set<string>();
  const gateways = new Set<string>();
  for (const ref of new Set(refs)) {
    const network: unknown = await docker.getNetwork(ref).inspect();
    for (const subnet of extractNetworkSubnets(network)) subnets.add(subnet);
    for (const gateway of extractNetworkGateways(network)) gateways.add(gateway);
  }
  return { subnets: [...subnets], gateways: [...gateways] };
}

/** Leaves nothing running with the egress route and no firewall. */
async function stopAfterFailure(target: ProxyEgressTarget): Promise<void> {
  const container = target.docker.getContainer(target.containerId);
  let detached: boolean;
  try {
    await target.docker.getNetwork(egressNetworkName(target.sessionId))
      .disconnect({ Container: target.containerId, Force: true });
    detached = true;
  } catch (error) {
    detached = notConnected(error);
  }
  if (detached) {
    try { await container.unpause(); } catch { /* not paused */ }
    try {
      await container.stop({ t: 0 });
      return;
    } catch (error) {
      if (statusCode(error) === 304) return;
    }
  }
  try { await container.remove({ force: true }); } catch { /* already gone */ }
}

/**
 * After Docker reports the start: pause, attach the egress network, install the open-policy
 * firewall, open the container's own networks, unpause. Any failure stops the container and throws.
 */
export async function containProxyContainer(target: ProxyEgressTarget): Promise<void> {
  const { docker, containerId, sessionId, sidecarImage } = target;
  const container = docker.getContainer(containerId);
  try {
    await container.pause();
  } catch (error) {
    // A short-lived container can exit, or be auto-removed, before the pause; nothing then runs.
    let running = true;
    try {
      running = (await container.inspect()).State.Running;
    } catch (inspectError) {
      if (statusCode(inspectError) === 404) running = false;
    }
    if (!running) return;
    await stopAfterFailure(target);
    throw error;
  }

  try {
    // Fresh: this container's network may hold a range whose gateway the cached read still lists.
    const addresses = await hostAddresses(docker, sidecarImage, { fresh: true });
    const network = await ensureEgressNetwork(docker, sessionId, target.labels);
    try {
      await network.connect({
        Container: containerId,
        EndpointConfig: { GwPriority: 1 },
      } as Docker.NetworkConnectOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists|already connected/i.test(message)) throw error;
    }

    const endpoints = endpointsOf(await container.inspect());
    const { subnets, gateways } = await networkRanges(docker, [
      ...Object.entries(endpoints).map(([name, endpoint]) => endpoint?.NetworkID || name),
      egressNetworkName(sessionId),
    ]);
    const labels = {
      ...target.labels,
      [EGRESS_PARENT_LABEL]: containerId,
      [PROXY_EGRESS_SIDECAR_LABEL]: sessionId,
    };
    await installEgressFirewall(docker, {
      agentContainerId: containerId,
      sidecarImage,
      inputs: NO_TIER_A_INPUTS,
      policy: "open",
      hostAddresses: addresses,
      labels,
    });
    await allowEgressToSubnets(docker, {
      agentContainerId: containerId,
      sidecarImage,
      subnets,
      gateways,
      labels,
    });
    await container.unpause();
  } catch (error) {
    await stopAfterFailure(target);
    throw error;
  }
}

/** With the block active, why a container may not join `network` directly; undefined when it may. */
export function egressNetworkAttachRefusal(ref: string, network: { name?: string }): string | undefined {
  if (!localBlockActive()) return undefined;
  if (network.name === undefined) {
    return `Network "${ref}" carries no name to check against ShipIt's egress networks`;
  }
  if (!isEgressNetworkName(network.name)) return undefined;
  return `Network "${ref}" is a ShipIt egress network; a container joins it only after ShipIt has put `
    + "the firewall that keeps it away from this machine and private networks in place";
}
