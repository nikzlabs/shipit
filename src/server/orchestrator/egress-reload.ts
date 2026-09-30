import type Docker from "dockerode";
import { agentEgressDecisionUrl, buildProxyAllowed, launchEgressProxy, EGRESS_PROXY_LABEL } from "./egress-proxy-install.js";
import {
  buildAgentResolverConfigB64,
  launchEgressResolver,
  EGRESS_RESOLVER_LABEL,
} from "./egress-dns-install.js";
import { DOCKER_EMBEDDED_DNS } from "./egress-dns.js";

export interface ReloadEgressOpts {
  docker: Docker;
  agentContainerId: string;
  sessionId: string;
  sidecarImage: string;
  opsSession?: boolean;
  extraHosts: string[];
  base?: string[];
  baseLabels: Record<string, string>;
  reloadResolver: boolean;
  reloadProxy: boolean;
  identityRules?: string;
  orchPort?: string;
}

async function findByLabel(docker: Docker, label: string, parentId: string): Promise<{ Id: string }[]> {
  const list = await docker.listContainers({
    all: true,
    filters: { label: [label, `shipit-egress-parent=${parentId}`] },
  });
  if (list.length > 0) return list;
  // Legacy sidecars lack parent labels.
  const legacy = await docker.listContainers({ all: true, filters: { label: [label] } });
  const out: { Id: string }[] = [];
  for (const entry of legacy) {
    const inspected = await docker.getContainer(entry.Id).inspect().catch(() => null);
    if (!inspected?.Config?.Labels?.["shipit-egress-parent"]) out.push(entry);
  }
  return out;
}

async function removeByLabel(docker: Docker, label: string, parentId: string): Promise<void> {
  let list: { Id: string }[];
  try {
    list = await findByLabel(docker, label, parentId);
  } catch {
    return;
  }
  for (const c of list) {
    try {
      await docker.getContainer(c.Id).remove({ force: true });
    } catch {
      /* already gone */
    }
  }
}

async function sidecarEnvs(docker: Docker, label: string, parentId: string): Promise<string[][]> {
  const envs: string[][] = [];
  for (const entry of await findByLabel(docker, label, parentId)) {
    envs.push((await docker.getContainer(entry.Id).inspect()).Config?.Env ?? []);
  }
  return envs;
}

function envValue(env: string[], key: string): string | undefined {
  const entry = env.find((e) => e.startsWith(`${key}=`));
  return entry?.slice(key.length + 1);
}

/**
 * Which of an agent's sidecars name ShipIt differently from this process. Each
 * keeps the names it was started with, so after ShipIt is recreated a kept agent
 * could not find it by name (planning#626). A resolver from before agents could
 * look up their Compose services by name is stale too. A missing sidecar is not.
 */
export async function staleEgressSidecars(
  docker: Docker,
  opts: { sessionId: string; agentContainerId: string; internalNames?: string[]; decisionUrl?: string },
): Promise<{ resolver: boolean; proxy: boolean }> {
  let resolver = false;
  if (opts.internalNames) {
    for (const env of await sidecarEnvs(docker, `${EGRESS_RESOLVER_LABEL}=${opts.sessionId}`, opts.agentContainerId)) {
      const config = Buffer.from(envValue(env, "EGRESS_DNSMASQ_CONFIG_B64") ?? "", "base64").toString("utf-8");
      const forwarded = new Set(config.split("\n"));
      if (opts.internalNames.some((name) => !forwarded.has(`server=/${name}/${DOCKER_EMBEDDED_DNS}`))) resolver = true;
      if (!forwarded.has(`server=//${DOCKER_EMBEDDED_DNS}`)) resolver = true;
    }
  }
  let proxy = false;
  if (opts.decisionUrl) {
    for (const env of await sidecarEnvs(docker, `${EGRESS_PROXY_LABEL}=${opts.sessionId}`, opts.agentContainerId)) {
      if (envValue(env, "EGRESS_PROXY_DECISION_URL") !== opts.decisionUrl) proxy = true;
    }
  }
  return { resolver, proxy };
}

export async function reloadEgressSidecars(opts: ReloadEgressOpts): Promise<void> {
  const { docker, sessionId, agentContainerId, sidecarImage, extraHosts, base, baseLabels } = opts;
  const labels = { ...baseLabels, "shipit-parent-session": sessionId };

  if (opts.reloadResolver) {
    await removeByLabel(docker, `${EGRESS_RESOLVER_LABEL}=${sessionId}`, agentContainerId);
    const configB64 = buildAgentResolverConfigB64({
      opsSession: opts.opsSession,
      extraHosts,
      ...(base ? { base } : {}),
    });
    await launchEgressResolver(docker, {
      agentContainerId,
      sidecarImage,
      configB64,
      labels: { ...labels, [EGRESS_RESOLVER_LABEL]: sessionId, "shipit-egress-parent": agentContainerId },
    });
  }

  if (opts.reloadProxy) {
    await removeByLabel(docker, `${EGRESS_PROXY_LABEL}=${sessionId}`, agentContainerId);
    await launchEgressProxy(docker, {
      agentContainerId,
      sidecarImage,
      allowed: buildProxyAllowed({ extraHosts, ...(base ? { base } : {}) }),
      sessionId,
      decisionUrl: agentEgressDecisionUrl(opts.orchPort),
      ...(opts.identityRules ? { identityRules: opts.identityRules } : {}),
      labels: { ...labels, [EGRESS_PROXY_LABEL]: sessionId, "shipit-egress-parent": agentContainerId },
    });
  }
}
