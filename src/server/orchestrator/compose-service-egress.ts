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
import { createHash } from "node:crypto";
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
export const COMPOSE_EGRESS_SIDECAR_LABEL = "shipit-egress-service-sidecar";
export const COMPOSE_EGRESS_POLICY_LABEL = "shipit-egress-policy-hash";

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
  try {
    await docker.createNetwork({
      Name: name,
      Driver: "bridge",
      Internal: false,
      CheckDuplicate: true,
      Labels: { ...labels, "shipit-parent-session": sessionId },
    });
  } catch (error) {
    const code = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 0;
    if (code !== 409) throw error;
  }
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
    (entry.State === "running" || entry.State === "paused") && Boolean(entry.Labels?.["shipit-service-name"])
      && !entry.Labels?.[EGRESS_RESOLVER_LABEL] && !entry.Labels?.[EGRESS_PROXY_LABEL]
  );
  const liveServiceIds = new Set(serviceContainers.map((entry) => entry.Id));
  for (const entry of containers) {
    if (!entry.Labels?.[COMPOSE_EGRESS_SIDECAR_LABEL]) continue;
    const parent = entry.Labels?.["shipit-egress-parent"];
    if (!parent || liveServiceIds.has(parent)) continue;
    try { await opts.docker.getContainer(entry.Id).remove({ force: true }); } catch { /* best-effort reap */ }
  }
  if (serviceContainers.length === 0) return;

  const labels = { ...(opts.labels ?? {}), "shipit-parent-session": opts.sessionId };
  const network = await ensureEgressNetwork(opts.docker, opts.sessionId, labels);
  const sessionNetwork = opts.docker.getNetwork(`shipit-session-${opts.sessionId}`);
  const sessionNetworkInfo = await sessionNetwork.inspect();
  if (!sessionNetworkInfo.Internal) {
    // Never attach the NAT egress bridge to a service whose bootstrap network
    // was reused from Open mode or an older ShipIt version.
    for (const info of serviceContainers) {
      try { await opts.docker.getContainer(info.Id).stop({ t: 0 }); } catch { /* fail closed */ }
    }
    throw new Error(`session network shipit-session-${opts.sessionId} is not internal`);
  }
  const sessionSubnets = extractNetworkSubnets(sessionNetworkInfo);
  const inputs = await buildTierAEgressInputs();
  const discoveredServiceNames = serviceContainers
    .map((entry) => entry.Labels?.["shipit-service-name"])
    .filter((name): name is string => Boolean(name));
  const internalDomains = [
    ...new Set([...opts.serviceNames, ...discoveredServiceNames, opts.orchestratorHost ?? os.hostname()]),
  ];
  const policyHash = createHash("sha256").update(JSON.stringify({
    internalDomains: [...internalDomains].sort(),
    extraHosts: [...opts.config.extraHosts].sort(),
    base: opts.config.base,
    identityRules: opts.config.identityRules,
    dns: opts.dnsEnabled,
    proxy: opts.proxyEnabled,
  })).digest("hex").slice(0, 16);

  const failures: Error[] = [];
  for (const info of serviceContainers) {
    const container = opts.docker.getContainer(info.Id);
    const sidecarLabels = {
      ...labels,
      "shipit-egress-parent": info.Id,
      [COMPOSE_EGRESS_SIDECAR_LABEL]: "true",
      [COMPOSE_EGRESS_POLICY_LABEL]: policyHash,
    };
    let paused = false;
    try {
      const inspected = await container.inspect();
      if (inspected.State?.Paused) {
        // A previous orchestrator died inside the critical section. Preserve
        // the container and anonymous volumes, but leave the workload stopped.
        await container.unpause();
        await container.stop({ t: 0 });
        throw new Error(`service ${info.Labels?.["shipit-service-name"] ?? info.Id} was left paused during egress setup`);
      }
      const serviceStartedAt = Date.parse(inspected.State?.StartedAt ?? "") / 1000;
      const currentSidecars = containers.filter((entry) =>
        entry.State === "running"
          && entry.Labels?.[COMPOSE_EGRESS_SIDECAR_LABEL]
          && entry.Labels?.["shipit-egress-parent"] === info.Id
          && entry.Labels?.[COMPOSE_EGRESS_POLICY_LABEL] === policyHash
          && (entry.Created ?? 0) >= serviceStartedAt
      );
      const hasCurrentResolver = !opts.dnsEnabled
        || currentSidecars.some((entry) => Boolean(entry.Labels?.[EGRESS_RESOLVER_LABEL]));
      const hasCurrentProxy = !opts.proxyEnabled
        || currentSidecars.some((entry) => Boolean(entry.Labels?.[EGRESS_PROXY_LABEL]));
      if (!opts.refresh && opts.dnsEnabled && Number.isFinite(serviceStartedAt) && hasCurrentResolver && hasCurrentProxy) {
        continue;
      }
      await container.pause();
      paused = true;
      // A stopped-and-started container has the same id but a fresh netns.
      // Always replace its old sidecars and reinstall the firewall on `up`.
      for (const sidecar of containers.filter((entry) =>
        entry.Labels?.[COMPOSE_EGRESS_SIDECAR_LABEL]
          && entry.Labels?.["shipit-egress-parent"] === info.Id
      )) {
        try { await opts.docker.getContainer(sidecar.Id).remove({ force: true }); } catch { /* already gone */ }
      }
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
        if (code === 400 && /GwPriority|unknown field/i.test(message)) {
          // Docker Engine <28 / API <1.48 has no GwPriority. The internal
          // session network has no gateway, so this bridge becomes default
          // without the hint too.
          await network.connect({ Container: info.Id });
        } else if (code !== 403 && !/already exists|already connected/i.test(message)) {
          throw error;
        }
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
      try {
        await allowEgressToSubnets(opts.docker, {
          agentContainerId: info.Id,
          sidecarImage: opts.sidecarImage,
          subnets: sessionSubnets,
          labels: sidecarLabels,
        });
      } catch (error) {
        console.warn(`[egress:${opts.sessionId}] could not open the intra-session subnet for ${info.Id}:`, error);
      }
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
      // Preserve the container and anonymous volumes. Its bootstrap network is
      // internal or its firewall is default-deny, so stopping is fail-closed.
      if (paused) {
        try { await container.unpause(); paused = false; } catch { /* remain frozen and closed */ }
      }
      if (!paused) {
        try { await container.stop({ t: 0 }); } catch { /* fail closed */ }
      }
      failures.push(error instanceof Error ? error : new Error(String(error)));
    } finally {
      // Success unpauses above. On failure the container is removed; this is
      // only for a mocked/partial Docker implementation that did not remove it.
      if (paused) {
        try { await container.remove({ force: true }); } catch { /* fail closed */ }
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `egress containment failed for ${failures.length} Compose service(s)`);
  }
}
