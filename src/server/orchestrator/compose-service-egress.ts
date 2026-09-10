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
const containedServiceState = new Map<string, string>();

function containmentStateKey(sessionId: string, containerId: string): string {
  return `${sessionId}:${containerId}`;
}

/** A stopped container gets a new netns on start even when its id is stable. */
export function invalidateComposeServiceContainment(sessionId: string, containerId: string): void {
  containedServiceState.delete(containmentStateKey(sessionId, containerId));
}

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
  refresh?: boolean;
}

function egressNetworkName(sessionId: string): string {
  return `${COMPOSE_EGRESS_NETWORK_PREFIX}${sessionId}`;
}

function apiVersionAtLeast(actual: string, minimumMajor: number, minimumMinor: number): boolean {
  const [major, minor] = actual.split(".").map(Number);
  return Number.isFinite(major) && Number.isFinite(minor)
    && (major > minimumMajor || (major === minimumMajor && minor >= minimumMinor));
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

async function containerWasSuperseded(
  opts: ContainComposeServicesOptions,
  containerId: string,
): Promise<boolean> {
  try {
    const current = await opts.docker.listContainers({
      all: true,
      filters: { label: [`shipit-parent-session=${opts.sessionId}`] },
    });
    // Only absence proves replacement; a stopped container can restart without its firewall.
    return !current.some((entry) => entry.Id === containerId);
  } catch {
    return false;
  }
}

async function reapServiceSidecars(
  opts: ContainComposeServicesOptions,
  containerId: string,
): Promise<void> {
  let current: Docker.ContainerInfo[];
  try {
    current = await opts.docker.listContainers({
      all: true,
      filters: { label: [`shipit-parent-session=${opts.sessionId}`] },
    });
  } catch {
    return;
  }
  for (const entry of current) {
    if (!entry.Labels?.[COMPOSE_EGRESS_SIDECAR_LABEL]
      || entry.Labels?.["shipit-egress-parent"] !== containerId) continue;
    try { await opts.docker.getContainer(entry.Id).remove({ force: true }); } catch { /* already gone */ }
  }
}

export async function containComposeServices(opts: ContainComposeServicesOptions): Promise<void> {
  if (!opts.config.contained) return;
  const parentLabel = `shipit-parent-session=${opts.sessionId}`;
  const containers = await opts.docker.listContainers({ all: true, filters: { label: [parentLabel] } });
  const allServiceContainers = containers.filter((entry) =>
    (entry.State === "running" || entry.State === "paused") && Boolean(entry.Labels?.["shipit-service-name"])
      && !entry.Labels?.[EGRESS_RESOLVER_LABEL] && !entry.Labels?.[EGRESS_PROXY_LABEL]
  );
  const serviceContainers = allServiceContainers.filter((entry) =>
    entry.Labels?.["shipit-trusted-ops-proxy"] !== "true"
  );
  const liveServiceIds = new Set(serviceContainers.map((entry) => entry.Id));
  const statePrefix = `${opts.sessionId}:`;
  for (const stateKey of containedServiceState.keys()) {
    if (!stateKey.startsWith(statePrefix)) continue;
    const containerId = stateKey.slice(statePrefix.length);
    if (!liveServiceIds.has(containerId)) containedServiceState.delete(stateKey);
  }
  for (const entry of containers) {
    if (!entry.Labels?.[COMPOSE_EGRESS_SIDECAR_LABEL]) continue;
    const parent = entry.Labels?.["shipit-egress-parent"];
    if (!parent || liveServiceIds.has(parent)) continue;
    try { await opts.docker.getContainer(entry.Id).remove({ force: true }); } catch { /* best-effort reap */ }
  }
  if (serviceContainers.length === 0) return;

  const engineVersion = await opts.docker.version();
  if (!apiVersionAtLeast(engineVersion.ApiVersion, 1, 48)) {
    throw new Error(
      `Compose service egress containment requires Docker Engine API 1.48 or newer; found ${engineVersion.ApiVersion}`,
    );
  }

  const labels = { ...(opts.labels ?? {}), "shipit-parent-session": opts.sessionId };
  const sessionNetwork = opts.docker.getNetwork(`shipit-session-${opts.sessionId}`);
  const sessionNetworkInfo = await sessionNetwork.inspect();
  if (!sessionNetworkInfo.Internal) {
    const remediationFailures: Error[] = [];
    for (const info of allServiceContainers) {
      const container = opts.docker.getContainer(info.Id);
      try {
        await container.stop({ t: 0 });
      } catch (stopError) {
        try {
          await sessionNetwork.disconnect({ Container: info.Id, Force: true });
        } catch (disconnectError) {
          try {
            await container.remove({ force: true });
          } catch (removeError) {
            remediationFailures.push(new AggregateError(
              [stopError, disconnectError, removeError],
              `could not stop or isolate Compose service ${info.Id}`,
            ));
          }
        }
      }
    }
    if (remediationFailures.length > 0) {
      throw new AggregateError(remediationFailures, `session network shipit-session-${opts.sessionId} is not internal`);
    }
    throw new Error(`session network shipit-session-${opts.sessionId} is not internal`);
  }
  const network = await ensureEgressNetwork(opts.docker, opts.sessionId, labels);
  const egressNetworkInfo = await network.inspect();
  const allowedLocalSubnets = [
    ...new Set([...extractNetworkSubnets(sessionNetworkInfo), ...extractNetworkSubnets(egressNetworkInfo)]),
  ];
  const inputs = await buildTierAEgressInputs();
  const discoveredServiceNames = serviceContainers
    .map((entry) => entry.Labels?.["shipit-service-name"])
    .filter((name): name is string => Boolean(name));
  const serviceNames = [...new Set([...opts.serviceNames, ...discoveredServiceNames])];
  const trustedInternalDomains = [opts.orchestratorHost ?? os.hostname()];
  const policyHash = createHash("sha256").update(JSON.stringify({
    serviceNames: [...serviceNames].sort(),
    trustedInternalDomains: [...trustedInternalDomains].sort(),
    extraHosts: [...opts.config.extraHosts].sort(),
    base: opts.config.base,
    identityRules: opts.config.identityRules,
    dns: opts.dnsEnabled,
    proxy: opts.proxyEnabled,
  })).digest("hex").slice(0, 16);

  const failures: Error[] = [];
  for (const info of serviceContainers) {
    const container = opts.docker.getContainer(info.Id);
    const stateKey = containmentStateKey(opts.sessionId, info.Id);
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
        // Recover an interrupted setup without deleting anonymous volumes.
        await container.unpause();
        await container.stop({ t: 0 });
        throw new Error(`service ${info.Labels?.["shipit-service-name"] ?? info.Id} was left paused during egress setup`);
      }
      const startedAt = inspected.State?.StartedAt ?? "";
      const serviceStartedAt = Math.floor(Date.parse(startedAt) / 1000);
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
      const hasCurrentFirewall = containedServiceState.get(stateKey) === `${startedAt}:${policyHash}`;
      if (!opts.refresh && Number.isFinite(serviceStartedAt) && hasCurrentFirewall
        && hasCurrentResolver && hasCurrentProxy) {
        continue;
      }
      await container.pause();
      paused = true;
      for (const sidecar of containers.filter((entry) =>
        entry.Labels?.[COMPOSE_EGRESS_SIDECAR_LABEL]
          && entry.Labels?.["shipit-egress-parent"] === info.Id
      )) {
        try { await opts.docker.getContainer(sidecar.Id).remove({ force: true }); } catch { /* already gone */ }
      }
      try {
        await network.connect({
          Container: info.Id,
          EndpointConfig: { GwPriority: 1 },
        } as Docker.NetworkConnectOptions);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already exists|already connected/i.test(message)) {
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
      // The firewall installer allows only the egress bridge; restore session-local routes.
      await allowEgressToSubnets(opts.docker, {
        agentContainerId: info.Id,
        sidecarImage: opts.sidecarImage,
        subnets: allowedLocalSubnets,
        labels: sidecarLabels,
      });
      if (opts.dnsEnabled) {
        await launchEgressResolver(opts.docker, {
          agentContainerId: info.Id,
          sidecarImage: opts.sidecarImage,
          configB64: buildResolverConfigB64({
            internalDomains: trustedInternalDomains,
            unqualifiedInternalNames: serviceNames.length > 0,
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
      containedServiceState.set(stateKey, `${startedAt}:${policyHash}`);
    } catch (error) {
      // A concurrent replacement has its own containment pass; clean up only this old container.
      if (await containerWasSuperseded(opts, info.Id)) {
        containedServiceState.delete(stateKey);
        await reapServiceSidecars(opts, info.Id);
        continue;
      }
      // Detach the internet route before unpausing to stop the failed workload.
      let routeDetached: boolean;
      try {
        await network.disconnect({ Container: info.Id, Force: true });
        routeDetached = true;
      } catch (disconnectError) {
        const code = disconnectError && typeof disconnectError === "object" && "statusCode" in disconnectError
          ? Number(disconnectError.statusCode)
          : 0;
        const message = disconnectError instanceof Error ? disconnectError.message : String(disconnectError);
        routeDetached = code === 404 || /not connected|no such network|not found/i.test(message);
      }
      if (!routeDetached) {
        try {
          await container.remove({ force: true });
          paused = false;
        } catch { /* leave the workload paused when Docker rejects both actions */ }
      } else if (paused) {
        try { await container.unpause(); paused = false; } catch { /* remain frozen and closed */ }
        if (!paused) {
          try { await container.stop({ t: 0 }); } catch {
            try { await container.remove({ force: true }); } catch { /* route is detached and closed */ }
          }
        }
      }
      containedServiceState.delete(stateKey);
      failures.push(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (paused) {
        try { await container.remove({ force: true }); } catch { /* fail closed */ }
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `egress containment failed for ${failures.length} Compose service(s)`);
  }
}
