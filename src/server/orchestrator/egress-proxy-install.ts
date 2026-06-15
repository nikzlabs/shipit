/**
 * Egress proxy install — Tier C transparent SNI proxy (docs/172 Gap 1, SHI-90).
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
 * Gated behind `SESSION_EGRESS_PROXY=1`, which also requires Tier B
 * (`SESSION_EGRESS_DNS=1`) and Tier A (`SESSION_EGRESS_ENFORCE=1`) — C builds on
 * the resolver's resolve-and-pin (the proxy dials the original destination IP,
 * which the resolver already pinned into the ipset for allowlisted hosts).
 * Default OFF.
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

/** Is Tier C (SNI proxy) enabled? Requires Tier B (DNS) and Tier A (enforce). */
export function egressProxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.SESSION_EGRESS_PROXY === "1" &&
    env.SESSION_EGRESS_DNS === "1" &&
    env.SESSION_EGRESS_ENFORCE === "1"
  );
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
   * docs/172 Phase 2 (SHI-90) — SNI-scoped tenant identity rules as the proxy's
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
  if (opts.decisionUrl) env.push(`EGRESS_PROXY_DECISION_URL=${opts.decisionUrl}`);
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
