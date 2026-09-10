import type Docker from "dockerode";
import { buildProxyAllowed, launchEgressProxy, EGRESS_PROXY_LABEL } from "./egress-proxy-install.js";
import {
  buildResolverConfigB64,
  launchEgressResolver,
  sessionInternalNames,
  orchestratorCallbackHost,
  EGRESS_RESOLVER_LABEL,
} from "./egress-dns-install.js";

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

async function removeByLabel(docker: Docker, label: string, parentId: string): Promise<void> {
  let list: { Id: string }[];
  try {
    list = await docker.listContainers({
      all: true,
      filters: { label: [label, `shipit-egress-parent=${parentId}`] },
    });
    if (list.length === 0) {
      // Legacy sidecars lack parent labels; remove their listeners before rebinding.
      const legacy = await docker.listContainers({ all: true, filters: { label: [label] } });
      list = [];
      for (const entry of legacy) {
        const inspected = await docker.getContainer(entry.Id).inspect().catch(() => null);
        if (!inspected?.Config?.Labels?.["shipit-egress-parent"]) list.push(entry);
      }
    }
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

export async function reloadEgressSidecars(opts: ReloadEgressOpts): Promise<void> {
  const { docker, sessionId, agentContainerId, sidecarImage, extraHosts, base, baseLabels } = opts;
  const labels = { ...baseLabels, "shipit-parent-session": sessionId };

  if (opts.reloadResolver) {
    await removeByLabel(docker, `${EGRESS_RESOLVER_LABEL}=${sessionId}`, agentContainerId);
    const configB64 = buildResolverConfigB64({
      internalDomains: sessionInternalNames({ opsSession: opts.opsSession }),
      extraDomains: extraHosts,
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
    const orchPort = opts.orchPort ?? process.env.PORT ?? "3000";
    const decisionUrl = `http://${orchestratorCallbackHost()}:${orchPort}/api/egress/decision`;
    await launchEgressProxy(docker, {
      agentContainerId,
      sidecarImage,
      allowed: buildProxyAllowed({ extraHosts, ...(base ? { base } : {}) }),
      sessionId,
      decisionUrl,
      ...(opts.identityRules ? { identityRules: opts.identityRules } : {}),
      labels: { ...labels, [EGRESS_PROXY_LABEL]: sessionId, "shipit-egress-parent": agentContainerId },
    });
  }
}
