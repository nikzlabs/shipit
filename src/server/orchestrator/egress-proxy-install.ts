/**
 * Egress proxy install — Tier C transparent SNI proxy (docs/172 Gap 1, planning#92).
 *
 * Launches the long-lived SNI-peek proxy sidecar (`docker/egress-sidecar/sni-proxy`)
 * into the agent's netns. The Tier A installer REDIRECTs the agent's outbound :443
 * to it (`EGRESS_PROXY_UID`/`EGRESS_PROXY_PORT` threaded through). The proxy reads
 * the ClientHello SNI — cleartext, no decryption — and splices-or-rejects per the
 * allowlist, closing the CDN co-tenancy gap that an IP-only ipset can't.
 *
 * Sequencing in `createContainer`: agent starts → Tier A installer (now also
 * installs the :443 redirect) → Tier B resolver → THIS proxy → health check.
 *
 * Enabled by default; only `SESSION_EGRESS_PROXY=0` disables it. Still requires
 * Tier B (controlled DNS) and therefore Tier A (enforcement) — C builds on the
 * resolver's resolve-and-pin (the proxy dials the original destination IP, which
 * the resolver already pinned into the ipset for allowlisted hosts). Disabling
 * either lower tier disables the proxy.
 *
 * Unlike the installer, the proxy does NOT get `NET_ADMIN` — it only listens and
 * dials. It runs as `EGRESS_PROXY_UID` so the installer's owner-match can exclude
 * its own upstream dials from the :443 redirect.
 *
 * Unit-tested seams: the flag gate, the allowlist env composition, and the launch
 * config (fake Docker). The actual SNI peek + splice is verified on a live host.
 */

import type Docker from "dockerode";
import { EGRESS_DEFAULT_ALLOWLIST } from "./egress-allowlist.js";
import { egressDnsEnabled } from "./egress-dns-install.js";
import {
  EGRESS_DECISION_TOKEN_ENV,
  mintEgressDecisionToken,
  tokenFromContainerEnv,
  type EgressDecisionTokenRecovery,
} from "./egress-decision-auth.js";

/**
 * Uid the SNI proxy runs as. The Tier A installer REDIRECTs the agent's :443 to
 * the proxy EXCEPT traffic owned by this uid, so the proxy's own upstream dials
 * aren't re-redirected. Keep in sync with the `egressproxy` user in
 * docker/Dockerfile.egress-sidecar. Must differ from the agent + resolver uids.
 */
export const EGRESS_PROXY_UID = 912;

/** Loopback port the proxy listens on; the installer redirects :443 here. */
export const EGRESS_PROXY_PORT = 8443;
export const EGRESS_PROXY_LISTEN = `127.0.0.1:${EGRESS_PROXY_PORT}`;

/**
 * Distinct label on the long-lived proxy sidecar (in ADDITION to
 * `shipit-parent-session`), so the compose pre-start stale-sweep
 * (`killStaleContainers`) spares it — same rationale as the Tier B resolver.
 */
export const EGRESS_PROXY_LABEL = "shipit-egress-proxy";

/**
 * Is Tier C (SNI proxy) enabled? Default ON — only `SESSION_EGRESS_PROXY=0`
 * disables it. Still requires Tier B (controlled DNS), which in turn requires
 * Tier A (enforcement): the tier-stacking invariant C ⊃ B ⊃ A. Disabling any
 * lower tier disables the proxy.
 */
export function egressProxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SESSION_EGRESS_PROXY !== "0" && egressDnsEnabled(env);
}

export interface ProxyAllowedOpts {
  /** Operator extra allowlisted hosts (e.g. from SESSION_EGRESS_ALLOWLIST). */
  extraHosts?: string[];
  /** Override the base list (defaults to {@link EGRESS_DEFAULT_ALLOWLIST}). */
  base?: readonly string[];
}

/**
 * The space-separated allowlist the proxy matches SNI against. MUST mirror the
 * Tier B resolver's domain set (base + the same extras) — a host the resolver
 * resolves and pins must also be allowed by the proxy, or its :443 would be
 * accepted by the ipset but then rejected at the SNI layer.
 */
export function buildProxyAllowed(opts: ProxyAllowedOpts = {}): string {
  const base = opts.base ?? EGRESS_DEFAULT_ALLOWLIST;
  return [...base, ...(opts.extraHosts ?? [])].join(" ");
}

export interface LaunchProxyOpts {
  agentContainerId: string;
  sidecarImage: string;
  /** Space-separated allowlist entries (from {@link buildProxyAllowed}). */
  allowed: string;
  sessionId: string;
  /**
   * Tier C allow-once (C2): orchestrator endpoint the proxy queries for hosts not
   * in the static allowlist. Unset → an unknown SNI is denied-fast (safe default).
   */
  decisionUrl?: string;
  /**
   * docs/172 Phase 2 (planning#92) — SNI-scoped tenant identity rules as the proxy's
   * `EGRESS_PROXY_IDENTITY_RULES` JSON (from `composeEgressIdentityRules`). ""/
   * unset → no identity scoping; the static host allowlist still applies.
   */
  identityRules?: string;
  labels?: Record<string, string>;
}

/**
 * Launch the long-lived SNI proxy in the agent's netns. Returns once started
 * (it runs for the agent's lifetime). Throws on start failure → the caller fails
 * closed (a broken proxy means HTTPS is blackholed, so running the session would
 * just break it). Readiness is implicitly gated by the subsequent health check.
 */
export async function launchEgressProxy(docker: Docker, opts: LaunchProxyOpts): Promise<string> {
  const env = [
    `EGRESS_PROXY_LISTEN=${EGRESS_PROXY_LISTEN}`,
    `EGRESS_PROXY_PORT=${EGRESS_PROXY_PORT}`,
    `EGRESS_PROXY_ALLOWED=${opts.allowed}`,
    `EGRESS_PROXY_SESSION_ID=${opts.sessionId}`,
  ];
  if (opts.decisionUrl) {
    env.push(`EGRESS_PROXY_DECISION_URL=${opts.decisionUrl}`);
    // planning#371 — the decision query's own credential, minted HERE rather than at
    // the three call sites so no launcher can forget it and so a proxy with no
    // decision URL (the plugin namespaces) provably has no token to leak. It is
    // readable only inside this sidecar, which shares nothing but a network
    // namespace with the workload it fronts (`egress-decision-auth.ts`).
    env.push(`${EGRESS_DECISION_TOKEN_ENV}=${mintEgressDecisionToken(opts.sessionId)}`);
  }
  if (opts.identityRules) env.push(`EGRESS_PROXY_IDENTITY_RULES=${opts.identityRules}`);

  const container = await docker.createContainer({
    Image: opts.sidecarImage,
    Entrypoint: ["/usr/local/bin/sni-proxy"],
    // Least privilege: the proxy only listens + dials — no NET_ADMIN. It runs as
    // the dedicated uid the installer's :443 redirect owner-match excludes.
    User: String(EGRESS_PROXY_UID),
    Labels: opts.labels,
    HostConfig: {
      NetworkMode: `container:${opts.agentContainerId}`,
      RestartPolicy: { Name: "on-failure", MaximumRetryCount: 3 },
    },
    Env: env,
  });
  await container.start();
  return container.id;
}

/**
 * planning#371 — rebuild a session's decision-query tokens from its live proxy
 * sidecars, for an orchestrator that did not mint them (a restart; the sidecars
 * outlive the process that launched them).
 *
 * Lives here rather than beside the registry because it is the proxy sidecar's
 * own shape it reads: {@link EGRESS_PROXY_LABEL} identifies them and the token
 * is in the env this module wrote. Keeping it here also keeps
 * `egress-decision-auth.ts` free of any dependency on this module.
 */
export function dockerEgressDecisionTokenRecovery(
  docker: Pick<Docker, "listContainers" | "getContainer">,
): EgressDecisionTokenRecovery {
  return async (sessionId: string): Promise<string[]> => {
    const entries = await docker.listContainers({
      filters: { label: [`${EGRESS_PROXY_LABEL}=${sessionId}`] },
    });
    const tokens: string[] = [];
    for (const entry of entries) {
      let env: string[] | undefined;
      try {
        env = (await docker.getContainer(entry.Id).inspect()).Config?.Env;
      } catch {
        continue; // gone between the list and the inspect
      }
      const token = tokenFromContainerEnv(env);
      if (token) tokens.push(token);
    }
    return tokens;
  };
}
