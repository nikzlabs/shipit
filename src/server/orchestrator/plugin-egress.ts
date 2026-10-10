import type Docker from "dockerode";
import {
  normalizeHost,
  type ResolvedEgressConfig,
} from "./egress-allowlist.js";
import { egressHostReach } from "./egress-host-reach.js";
import {
  buildTierAEgressInputs,
  installEgressFirewall,
  NO_TIER_A_INPUTS,
  type EgressPolicy,
  type TierAEgressInputs,
} from "./egress-firewall-install.js";
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

export const PLUGIN_NETNS_LABEL = "shipit-plugin-netns";
export const PLUGIN_NETNS_PARENT_LABEL = "shipit-plugin-netns-parent";

const HOLDER_MEMORY_BYTES = 64 * 1024 * 1024;
const HOLDER_PIDS_LIMIT = 16;
const DEFAULT_SETUP_TIMEOUT_MS = 90_000;

export interface PluginEgressPolicy {
  contained: boolean;
  config?: ResolvedEgressConfig | undefined;
  // Snapshot for a proxy that cannot call the session's decision endpoint.
  allowOnceHosts?: readonly string[];
  sidecarImage?: string | undefined;
  dnsEnabled: boolean;
  proxyEnabled: boolean;
  /** docs/319: an uncontained plugin still gets the local block. */
  blockLocal?: boolean;
  hostAddresses?: () => Promise<string[]>;
}

export const UNCONTAINED_PLUGIN_EGRESS: PluginEgressPolicy = {
  contained: false,
  dnsEnabled: false,
  proxyEnabled: false,
};

export interface PluginNetns {
  networkMode: string;
  release(): Promise<void>;
}

/** A namespace ShipIt built: its holder, and the sidecars that keep running in it. */
export interface BuiltPluginNetns extends PluginNetns {
  holderId: string;
  sidecars: number;
}

export interface PreparePluginNetnsOptions {
  docker: Docker;
  sessionId: string;
  // Already created and registered as untrusted at ShipIt's API.
  network: string;
  holderImage: string;
  policy: PluginEgressPolicy;
  setupTimeoutMs?: number;
  /** Ownership labels for the holder and its sidecars (planning#584). */
  labels?: Record<string, string>;
}

/**
 * Every policy input a namespace is built from: `buildPluginNetns` takes the plan
 * and no policy. It does not hold what a namespace learns while it lives — the
 * addresses its firewall and resolver find for an allowed name.
 */
export interface PluginNetnsPlan {
  network: string;
  holderImage: string;
  sidecarImage: string;
  routeLocalnet: boolean;
  firewall: {
    policy: EgressPolicy;
    inputs: TierAEgressInputs;
    hostAddresses: string[];
    resolverUid?: number;
    proxyUid?: number;
    proxyPort?: number;
  };
  resolverConfigB64?: string;
  proxy?: { allowed: string; identityRules?: string };
}

/** Null when the session needs no namespace of ShipIt's making. */
export async function resolvePluginNetnsPlan(
  opts: Pick<PreparePluginNetnsOptions, "network" | "holderImage" | "policy" | "setupTimeoutMs">,
): Promise<PluginNetnsPlan | null> {
  const { policy } = opts;
  if (!policy.contained && !policy.blockLocal) return null;
  const contained = policy.contained;
  const sidecarImage = policy.sidecarImage;
  if (!sidecarImage) {
    throw new Error(
      "this session's egress is contained but SESSION_EGRESS_SIDECAR_IMAGE is not set, "
      + "so ShipIt cannot contain a plugin container's network",
    );
  }
  const allowed = allowedHosts(policy);
  const withResolver = contained && policy.dnsEnabled;
  const withProxy = contained && policy.proxyEnabled;
  // Reading the host's addresses runs a helper container, which a stalled daemon never finishes.
  return await withDeadline(opts.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS, async () => ({
    network: opts.network,
    holderImage: opts.holderImage,
    sidecarImage,
    // The proxy's loopback redirect needs this sysctl; installer sidecars cannot set it later.
    routeLocalnet: withProxy,
    firewall: {
      inputs: contained ? await buildTierAEgressInputs() : NO_TIER_A_INPUTS,
      policy: contained ? "contained" : "open",
      hostAddresses: await (policy.hostAddresses?.() ?? Promise.resolve([])),
      ...(withResolver ? { resolverUid: EGRESS_RESOLVER_UID } : {}),
      ...(withProxy ? { proxyUid: EGRESS_PROXY_UID, proxyPort: EGRESS_PROXY_PORT } : {}),
    },
    ...(withResolver
      ? {
        resolverConfigB64: buildResolverConfigB64({
          // Plugins need no orchestrator callback domains.
          extraDomains: allowed.extras,
          ...(allowed.base ? { base: allowed.base } : {}),
        }),
      }
      : {}),
    ...(withProxy
      ? {
        proxy: {
          allowed: buildProxyAllowed({
            extraHosts: [...allowed.extras],
            ...(allowed.base ? { base: allowed.base } : {}),
          }),
          ...(policy.config?.identityRules ? { identityRules: policy.config.identityRules } : {}),
        },
      }
      : {}),
  }));
}

// Contain a separate holder before starting plugin code. Sharing the session netns exposes its broker.
export async function preparePluginNetns(
  opts: PreparePluginNetnsOptions,
): Promise<PluginNetns> {
  const plan = await resolvePluginNetnsPlan(opts);
  if (!plan) return { networkMode: opts.network, release: async () => undefined };
  return await buildPluginNetns(opts, plan);
}

export async function buildPluginNetns(
  opts: Pick<PreparePluginNetnsOptions, "docker" | "sessionId" | "setupTimeoutMs" | "labels">,
  plan: PluginNetnsPlan,
): Promise<BuiltPluginNetns> {
  const { sidecarImage } = plan;

  // Do not add shipit-parent-session: Compose's stale-container sweep would delete this holder.
  const labels = { ...(opts.labels ?? {}), [PLUGIN_NETNS_LABEL]: opts.sessionId };

  const holder = await opts.docker.createContainer({
    Image: plan.holderImage,
    Labels: labels,
    Entrypoint: ["/bin/sh", "-c"],
    Cmd: ["exec sleep infinity"],
    HostConfig: {
      NetworkMode: plan.network,
      ...(plan.routeLocalnet ? { Sysctls: { "net.ipv4.conf.all.route_localnet": "1" } } : {}),
      AutoRemove: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Memory: HOLDER_MEMORY_BYTES,
      PidsLimit: HOLDER_PIDS_LIMIT,
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,nosuid,size=1m" },
    },
  });

  // Setup can still create a sidecar after timeout; retry cleanup before giving up on the holder.
  const release = async (): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      await removeNetnsSidecars(opts.docker, opts.sessionId, holder.id);
      try {
        await holder.remove({ force: true });
        return;
      } catch (err) {
        lastError = err;
      }
    }
    console.warn(
      `[plugins:${opts.sessionId}] could not remove the plugin netns holder ${holder.id} — `
      + "its egress sidecars keep running until the next orchestrator restart:",
      message(lastError),
    );
  };

  try {
    await withDeadline(opts.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS, async () => {
    await holder.start();

    const sidecarLabels = { ...labels, [PLUGIN_NETNS_PARENT_LABEL]: holder.id };

    // Await the firewall's self-test before starting the other tiers. The
    // plugin network is shared between sessions, so nothing on it is accepted.
    await installEgressFirewall(opts.docker, {
      agentContainerId: holder.id,
      sidecarImage,
      ...plan.firewall,
      labels: sidecarLabels,
    });

    if (plan.resolverConfigB64 !== undefined) {
      await launchEgressResolver(opts.docker, {
        agentContainerId: holder.id,
        sidecarImage,
        configB64: plan.resolverConfigB64,
        labels: { ...sidecarLabels, [EGRESS_RESOLVER_LABEL]: opts.sessionId },
      });
    }

    if (plan.proxy) {
      await launchEgressProxy(opts.docker, {
        agentContainerId: holder.id,
        sidecarImage,
        allowed: plan.proxy.allowed,
        sessionId: opts.sessionId,
        // No decisionUrl: the API denies this network. Grants during a call take effect next call.
        ...(plan.proxy.identityRules ? { identityRules: plan.proxy.identityRules } : {}),
        labels: { ...sidecarLabels, [EGRESS_PROXY_LABEL]: opts.sessionId },
      });
    }
    });
    return {
      networkMode: `container:${holder.id}`,
      release,
      holderId: holder.id,
      sidecars: (plan.resolverConfigB64 !== undefined ? 1 : 0) + (plan.proxy ? 1 : 0),
    };
  } catch (err) {
    await release();
    throw err;
  }
}

// Timing out does not cancel work; the caller must release the holder and sidecars.
export async function withDeadline<T>(ms: number, work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`egress containment did not finish within ${Math.round(ms / 1000)}s`)),
          ms,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function unreachableDeclaredHosts(
  policy: PluginEgressPolicy,
  declared: readonly string[],
): string[] {
  if (!policy.contained || declared.length === 0) return [];
  const reach = egressHostReach({
    contained: true,
    dnsControlDeployed: policy.dnsEnabled,
    config: policy.config,
    allowOnceHosts: policy.allowOnceHosts,
  });
  return [...new Set(
    declared.map(normalizeHost).filter((host) => host && reach(host) !== "allowed"),
  )];
}

function allowedHosts(policy: PluginEgressPolicy): {
  base: readonly string[] | undefined;
  extras: string[];
} {
  return {
    base: policy.config?.base,
    extras: [...(policy.config?.extraHosts ?? []), ...(policy.allowOnceHosts ?? [])],
  };
}

async function removeNetnsSidecars(
  docker: Docker,
  sessionId: string,
  holderId: string,
): Promise<void> {
  let entries: Docker.ContainerInfo[];
  try {
    entries = await docker.listContainers({
      all: true,
      filters: { label: [`${PLUGIN_NETNS_LABEL}=${sessionId}`] },
    });
  } catch (err) {
    console.warn(
      `[plugins:${sessionId}] could not list the netns sidecars of holder ${holderId}:`,
      message(err),
    );
    return;
  }
  for (const entry of entries) {
    if (entry.Labels?.[PLUGIN_NETNS_PARENT_LABEL] !== holderId) continue;
    try {
      await docker.getContainer(entry.Id).remove({ force: true });
    } catch (err) {
      console.warn(
        `[plugins:${sessionId}] could not remove netns sidecar ${entry.Id}:`,
        message(err),
      );
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
