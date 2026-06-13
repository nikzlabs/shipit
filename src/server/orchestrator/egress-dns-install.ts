/**
 * Egress DNS install — Tier B resolver launch (docs/172 Gap 1, SHI-90).
 *
 * Builds the dnsmasq config (via `egress-dns.ts`) and launches the long-lived
 * controlled-resolver sidecar in the agent's netns. Sequencing in
 * `createContainer`: agent starts (with `--dns 127.0.0.1`) → Tier A installer
 * runs (creates the ipset + locks DNS to the resolver uid) → THIS launches the
 * resolver → health check → ready.
 *
 * Gated behind `SESSION_EGRESS_DNS=1` (which also requires `SESSION_EGRESS_ENFORCE=1`).
 * The resolver is labeled `shipit-parent-session=<id>` so the existing
 * `cleanupSessionDockerResources` tears it down with the session — no separate
 * teardown bookkeeping needed.
 *
 * Unit-tested seams: domain derivation, config base64 encoding, the flag gate,
 * and the sidecar launch config (fake Docker). The actual dnsmasq behavior +
 * iptables interaction is verified on a live host (the SHI-90 Tier B checklist).
 */

import type Docker from "dockerode";
import { EGRESS_DEFAULT_ALLOWLIST } from "./egress-allowlist.js";
import { buildDnsmasqConfig, EGRESS_RESOLVER_UID } from "./egress-dns.js";

/** Default public upstream resolvers for allowlisted domains (overridable). */
export const EGRESS_DNS_DEFAULT_UPSTREAMS = ["1.1.1.1", "1.0.0.1"];

/** Is Tier B (controlled DNS) enabled? Requires Tier A enforcement too. */
export function egressDnsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SESSION_EGRESS_DNS === "1" && env.SESSION_EGRESS_ENFORCE === "1";
}

/**
 * Internal names the agent must still resolve under Tier B (forwarded to Docker's
 * embedded DNS, not pinned). Primarily the orchestrator host — the worker reaches
 * it by `SHIPIT_HOST`, which may be a Docker service name rather than an IP. Empty
 * entries (when it's already an IP / unset) are harmless.
 */
export function orchestratorInternalNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = [env.SHIPIT_ORCHESTRATOR_HOST, ...(env.SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS?.split(/[\s,]+/) ?? [])];
  return names
    .map((n) => (n ?? "").trim())
    .filter((n) => n && !/^\d+\.\d+\.\d+\.\d+$/.test(n)); // skip IP literals (no DNS needed)
}

export interface ResolverConfigOpts {
  /** Operator extra allowlisted domains (e.g. SESSION_EGRESS_ALLOWLIST). */
  extraDomains?: string[];
  /** Internal names → Docker embedded DNS. */
  internalDomains?: string[];
  upstreams?: string[];
}

/** Build the resolver's dnsmasq config and base64-encode it for env transport. */
export function buildResolverConfigB64(opts: ResolverConfigOpts = {}): string {
  const publicDomains = [...EGRESS_DEFAULT_ALLOWLIST, ...(opts.extraDomains ?? [])];
  const config = buildDnsmasqConfig({
    publicDomains,
    publicUpstreams: opts.upstreams ?? EGRESS_DNS_DEFAULT_UPSTREAMS,
    internalDomains: opts.internalDomains,
  });
  return Buffer.from(config, "utf-8").toString("base64");
}

export interface LaunchResolverOpts {
  agentContainerId: string;
  sidecarImage: string;
  /** base64-encoded dnsmasq config from {@link buildResolverConfigB64}. */
  configB64: string;
  labels?: Record<string, string>;
}

/**
 * Launch the long-lived resolver sidecar in the agent's netns. Returns once the
 * container is started (NOT waited — it runs for the agent's lifetime). Throws on
 * start failure → the caller fails closed (a broken resolver means the agent
 * can't resolve, so running it would just break the session). Readiness is
 * implicitly gated by the subsequent worker health check.
 */
export async function launchEgressResolver(docker: Docker, opts: LaunchResolverOpts): Promise<string> {
  const container = await docker.createContainer({
    Image: opts.sidecarImage,
    Entrypoint: ["/usr/local/bin/run-resolver.sh"],
    Labels: opts.labels,
    HostConfig: {
      NetworkMode: `container:${opts.agentContainerId}`,
      CapAdd: ["NET_ADMIN"],
      RestartPolicy: { Name: "on-failure", MaximumRetryCount: 3 },
    },
    Env: [`EGRESS_DNSMASQ_CONFIG_B64=${opts.configB64}`, `EGRESS_RESOLVER_UID=${EGRESS_RESOLVER_UID}`],
  });
  await container.start();
  return container.id;
}
