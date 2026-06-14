/**
 * Egress reload — apply a newly-added allowlist host to a RUNNING session
 * without a container restart (docs/172 Gap 1, SHI-90).
 *
 * "Add to allowlist" persists durably (EgressAllowlistStore), but a contained
 * session that is already running was launched with the OLD resolver config +
 * proxy allowlist. For a brand-new host the resolver refuses the name (so the
 * agent never gets an IP) and the proxy would reject its SNI — until the next
 * container start. This reload closes that gap live:
 *
 *   - **DNS opens.** Relaunch the Tier B resolver with a regenerated dnsmasq
 *     config that now lists the new host. dnsmasq's per-domain `ipset=` directive
 *     means that as soon as the agent resolves the host through it, the returned
 *     IP is auto-inserted into the existing Tier A ipset — so "DNS opens" and
 *     "IP permitted" are the same action (no separate ipset poke, no touching the
 *     verified `init-firewall.sh`).
 *   - **SNI permitted.** Relaunch the Tier C SNI proxy with the regenerated
 *     allowlist so its hostname check passes for the new host.
 *
 * Both sidecars listen on fixed loopback ports inside the agent's netns, so the
 * old instance is removed and a fresh one started on the same address — the
 * iptables REDIRECTs installed at session start keep pointing at it. Best-effort
 * and fail-safe: any error is logged, not thrown — the durable add already
 * persisted, so a failed live reload degrades to "takes effect on next restart."
 *
 * This module is the orchestration seam (find-old → remove → relaunch). The pure
 * config composition lives in `egress-allowlist.ts` / `egress-dns-install.ts` /
 * `egress-proxy-install.ts`; it is unit-tested here against a fake Docker. The
 * actual in-netns dnsmasq/proxy swap is verified on a live host.
 */

import type Docker from "dockerode";
import { buildProxyAllowed, launchEgressProxy, EGRESS_PROXY_LABEL } from "./egress-proxy-install.js";
import {
  buildResolverConfigB64,
  launchEgressResolver,
  orchestratorInternalNames,
  orchestratorCallbackHost,
  EGRESS_RESOLVER_LABEL,
} from "./egress-dns-install.js";

export interface ReloadEgressOpts {
  docker: Docker;
  /** Docker id of the running agent container (shared netns target). */
  agentContainerId: string;
  sessionId: string;
  sidecarImage: string;
  /** Composed extra-host allowlist (env + MCP + durable) for this session. */
  extraHosts: string[];
  /** Base labels (parent-session etc.) stamped on the relaunched sidecars. */
  baseLabels: Record<string, string>;
  /** Reload the Tier B resolver (only when DNS enforcement is on). */
  reloadResolver: boolean;
  /** Reload the Tier C proxy (only when proxy enforcement is on). */
  reloadProxy: boolean;
  /** Orchestrator port for the proxy's decision endpoint. */
  orchPort?: string;
}

/** Remove every container carrying `label`. Best-effort, errors swallowed. */
async function removeByLabel(docker: Docker, label: string): Promise<void> {
  let list: { Id: string }[];
  try {
    list = await docker.listContainers({ all: true, filters: { label: [label] } });
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

/**
 * Reload the Tier B resolver and/or Tier C proxy for a running, contained
 * session so a just-added allowlist host takes effect without a restart.
 */
export async function reloadEgressSidecars(opts: ReloadEgressOpts): Promise<void> {
  const { docker, sessionId, agentContainerId, sidecarImage, extraHosts, baseLabels } = opts;
  const labels = { ...baseLabels, "shipit-parent-session": sessionId };

  if (opts.reloadResolver) {
    await removeByLabel(docker, `${EGRESS_RESOLVER_LABEL}=${sessionId}`);
    const configB64 = buildResolverConfigB64({
      internalDomains: orchestratorInternalNames(),
      extraDomains: extraHosts,
    });
    await launchEgressResolver(docker, {
      agentContainerId,
      sidecarImage,
      configB64,
      labels: { ...labels, [EGRESS_RESOLVER_LABEL]: sessionId },
    });
  }

  if (opts.reloadProxy) {
    await removeByLabel(docker, `${EGRESS_PROXY_LABEL}=${sessionId}`);
    const orchPort = opts.orchPort ?? process.env.PORT ?? "3000";
    const decisionUrl = `http://${orchestratorCallbackHost()}:${orchPort}/api/egress/decision`;
    await launchEgressProxy(docker, {
      agentContainerId,
      sidecarImage,
      allowed: buildProxyAllowed({ extraHosts }),
      sessionId,
      decisionUrl,
      labels: { ...labels, [EGRESS_PROXY_LABEL]: sessionId },
    });
  }
}
