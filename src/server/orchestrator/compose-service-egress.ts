/**
 * Fail-closed egress containment for Compose-managed service containers.
 *
 * The generated Compose network is `internal`, so a newly started service has
 * no internet route. We then pause the service, attach a private NAT-capable
 * egress bridge, install the same Tier A/B/C stack used by the agent in the
 * service's network namespace, and unpause it. Thus there is no interval in
 * which repository code can run with unrestricted egress.
 */

import os from "node:os";
import type Docker from "dockerode";
import type { ResolvedEgressConfig } from "./egress-allowlist.js";
import {
  buildTierAEgressInputs,
  installEgressFirewall,
  allowEgressToSubnets,
} from "./egress-firewall-install.js";
import { extractNetworkSubnets } from "./egress-firewall.js";
import {
  buildResolverConfigB64,
  launchEgressResolver,
  EGRESS_RESOLVER_LABEL,
} from "./egress-dns-install.js";
import { EGRESS_RESOLVER_UID } from "./egress-dns.js";
import {
  buildProxyAllowed,
  launchEgressProxy,
  EGRESS_PROXY_LABEL,
  EGRESS_PROXY_PORT,
  EGRESS_PROXY_UID,
} from "./egress-proxy-install.js";

export const COMPOSE_EGRESS_NETWORK_PREFIX = "shipit-egress-";

export interface ContainComposeServicesOptions {
  docker: Docker;
  sessionId: string;
  sidecarImage: string;
  config: ResolvedEgressConfig;
  serviceNames: string[];
  dnsEnabled: boolean;
  proxyEnabled: boolean;
  labels?: Record<string, string>;
  orchestratorHost?: string;
  orchestratorPort?: string;
  /** Replace live service resolver/proxy sidecars after an allowlist change. */
  refresh?: boolean;
}

function egressNetworkName(sessionId: string): string {
  return `${COMPOSE_EGRESS_NETWORK_PREFIX}${sessionId}`;
}

async function ensureEgressNetwork(
  docker: Docker,
  sessionId: string,
  labels: Record<string, string>,
): Promise<ReturnType<Docker["getNetwork"]>> {
  const name = egressNetworkName(sessionId);
  const existing = await docker.listNetworks({ filters: { name: [name] } });
  if (existing.some((network) => network.Name === name)) return docker.getNetwork(name);
  await docker.createNetwork({
    Name: name,
    Driver: "bridge",
    Internal: false,
    CheckDuplicate: true,
    Labels: { ...labels, "shipit-parent-session": sessionId },
  });
  return docker.getNetwork(name);
}

/**
 * Contain every running Compose container for the session. The operation is
 * idempotent per container id. Call it after each `compose up`, because Compose
 * can replace a container without changing the service name.
 */
export async function containComposeServices(opts: ContainComposeServicesOptions): Promise<void> {
  if (!opts.config.contained) return;
  const parentLabel = `shipit-parent-session=${opts.sessionId}`;
  const containers = await opts.docker.listContainers({ all: true, filters: { label: [parentLabel] } });
  const serviceContainers = containers.filter((entry) =>
    entry.State === "running" && Boolean(entry.Labels?.["shipit-service-name"])
      && !entry.Labels?.[EGRESS_RESOLVER_LABEL] && !entry.Labels?.[EGRESS_PROXY_LABEL]
  );
  const liveServiceIds = new Set(serviceContainers.map((entry) => entry.Id));
  for (const entry of containers) {
    const parent = entry.Labels?.["shipit-egress-parent"];
    if (!parent || liveServiceIds.has(parent)) continue;
    try { await opts.docker.getContainer(entry.Id).remove({ force: true }); } catch { /* best-effort reap */ }
  }
  if (serviceContainers.length === 0) return;

  const labels = { ...(opts.labels ?? {}), "shipit-parent-session": opts.sessionId };
  const network = await ensureEgressNetwork(opts.docker, opts.sessionId, labels);
  const sessionNetwork = opts.docker.getNetwork(`shipit-session-${opts.sessionId}`);
  const sessionSubnets = extractNetworkSubnets(await sessionNetwork.inspect());
  const inputs = await buildTierAEgressInputs();
  const discoveredServiceNames = serviceContainers
    .map((entry) => entry.Labels?.["shipit-service-name"])
    .filter((name): name is string => Boolean(name));
  const internalDomains = [
    ...new Set([...opts.serviceNames, ...discoveredServiceNames, opts.orchestratorHost ?? os.hostname()]),
  ];

  for (const info of serviceContainers) {
    const alreadyHasResolver = containers.some((entry) =>
      entry.Labels?.["shipit-egress-parent"] === info.Id && Boolean(entry.Labels?.[EGRESS_RESOLVER_LABEL])
    );
    const alreadyHasProxy = containers.some((entry) =>
      entry.Labels?.["shipit-egress-parent"] === info.Id && Boolean(entry.Labels?.[EGRESS_PROXY_LABEL])
    );
    if (opts.refresh) {
      for (const sidecar of containers.filter((entry) => entry.Labels?.["shipit-egress-parent"] === info.Id)) {
        try { await opts.docker.getContainer(sidecar.Id).remove({ force: true }); } catch { /* already gone */ }
      }
    } else if (opts.dnsEnabled && alreadyHasResolver && (!opts.proxyEnabled || alreadyHasProxy)) {
      continue;
    }
    const container = opts.docker.getContainer(info.Id);
    const sidecarLabels = { ...labels, "shipit-egress-parent": info.Id };
    let paused = false;
    try {
      const inspected = await container.inspect();
      if (inspected.State?.Paused) {
        // A previous orchestrator died inside the critical section. Removing
        // the frozen service is fail-closed; the next Compose up recreates it.
        await container.remove({ force: true });
        throw new Error(`service ${info.Labels?.["shipit-service-name"] ?? info.Id} was left paused during egress setup`);
      }
      await container.pause();
      paused = true;
      // A private per-session bridge supplies the resolver/proxy's internet
      // route. GwPriority makes it the default route after the attachment.
      try {
        await network.connect({
          Container: info.Id,
          EndpointConfig: { GwPriority: 1 },
        } as Docker.NetworkConnectOptions);
      } catch (error) {
        const code = error && typeof error === "object" && "statusCode" in error
          ? Number(error.statusCode)
          : 0;
        const message = error instanceof Error ? error.message : String(error);
        if (code !== 403 && !/already exists|already connected/i.test(message)) throw error;
      }

      await installEgressFirewall(opts.docker, {
        agentContainerId: info.Id,
        sidecarImage: opts.sidecarImage,
        inputs,
        resolverUid: opts.dnsEnabled ? EGRESS_RESOLVER_UID : undefined,
        proxyUid: opts.proxyEnabled ? EGRESS_PROXY_UID : undefined,
        proxyPort: opts.proxyEnabled ? EGRESS_PROXY_PORT : undefined,
        labels: sidecarLabels,
      });
      // The installer allows only its default egress bridge. Re-open the
      // internal session subnet so api→database, service→agent, and similar
      // intra-session connections keep working.
      await allowEgressToSubnets(opts.docker, {
        agentContainerId: info.Id,
        sidecarImage: opts.sidecarImage,
        subnets: sessionSubnets,
        labels: sidecarLabels,
      });
      if (opts.dnsEnabled) {
        await launchEgressResolver(opts.docker, {
          agentContainerId: info.Id,
          sidecarImage: opts.sidecarImage,
          configB64: buildResolverConfigB64({
            internalDomains,
            extraDomains: opts.config.extraHosts,
            ...(opts.config.base ? { base: opts.config.base } : {}),
          }),
          labels: { ...sidecarLabels, [EGRESS_RESOLVER_LABEL]: opts.sessionId },
        });
      }
      if (opts.proxyEnabled) {
        const host = opts.orchestratorHost ?? os.hostname();
        const port = opts.orchestratorPort ?? process.env.PORT ?? "3000";
        await launchEgressProxy(opts.docker, {
          agentContainerId: info.Id,
          sidecarImage: opts.sidecarImage,
          allowed: buildProxyAllowed({
            extraHosts: opts.config.extraHosts,
            ...(opts.config.base ? { base: opts.config.base } : {}),
          }),
          sessionId: opts.sessionId,
          decisionUrl: `http://${host}:${port}/api/egress/decision`,
          ...(opts.config.identityRules ? { identityRules: opts.config.identityRules } : {}),
          labels: { ...sidecarLabels, [EGRESS_PROXY_LABEL]: opts.sessionId },
        });
      }
      await container.unpause();
      paused = false;
    } catch (error) {
      // Never resume repository code unless the complete containment stack is
      // ready. Removing the service also makes Compose report the failed start.
      try { await container.remove({ force: true }); } catch { /* already gone */ }
      throw error;
    } finally {
      // Success unpauses above. On failure the container is removed; this is
      // only for a mocked/partial Docker implementation that did not remove it.
      if (paused) {
        try { await container.stop({ t: 0 }); } catch { /* fail closed */ }
      }
    }
  }
}
