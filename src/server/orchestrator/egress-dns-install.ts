import os from "node:os";
import type Docker from "dockerode";
import { EGRESS_DEFAULT_ALLOWLIST } from "./egress-allowlist.js";
import { buildDnsmasqConfig, EGRESS_RESOLVER_UID } from "./egress-dns.js";
import { egressEnforceEnabled } from "./egress-firewall-install.js";
import { orchestratorFallbackHosts } from "../shared/orchestrator-hosts.js";

export const EGRESS_DNS_DEFAULT_UPSTREAMS = ["1.1.1.1", "1.0.0.1"];
// Exempts the resolver from the Compose stale-container sweep.
export const EGRESS_RESOLVER_LABEL = "shipit-egress-resolver";

export function egressDnsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SESSION_EGRESS_DNS !== "0" && egressEnforceEnabled(env);
}

// Must match the worker's SHIPIT_HOST from buildOrchestratorCallbackEnv.
export function orchestratorCallbackHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHIPIT_ORCHESTRATOR_HOST || os.hostname();
}

export function orchestratorInternalNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = [orchestratorCallbackHost(env), ...orchestratorFallbackHosts(env)];
  return names
    .map((n) => (n ?? "").trim())
    .filter((n) => n && !/^\d+\.\d+\.\d+\.\d+$/.test(n));
}

export const OPS_DOCKER_PROXY_DNS_NAME = "docker-socket-proxy";

export function sessionInternalNames(
  opts: { opsSession?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const names = orchestratorInternalNames(env);
  if (opts.opsSession) names.push(OPS_DOCKER_PROXY_DNS_NAME);
  return names;
}

export interface ResolverConfigOpts {
  extraDomains?: string[];
  internalDomains?: string[];
  unqualifiedInternalNames?: boolean;
  upstreams?: string[];
  base?: readonly string[];
}

export function buildResolverConfigB64(opts: ResolverConfigOpts = {}): string {
  const publicDomains = [...(opts.base ?? EGRESS_DEFAULT_ALLOWLIST), ...(opts.extraDomains ?? [])];
  const config = buildDnsmasqConfig({
    publicDomains,
    publicUpstreams: opts.upstreams ?? EGRESS_DNS_DEFAULT_UPSTREAMS,
    internalDomains: opts.internalDomains,
    unqualifiedInternalNames: opts.unqualifiedInternalNames,
  });
  return Buffer.from(config, "utf-8").toString("base64");
}

/**
 * The agent's resolver, at create and at every reload. Single-label names go to
 * Docker DNS so the agent finds its session's Compose services by name, as
 * `environment.md` promises; a Compose service's resolver does the same.
 */
export function buildAgentResolverConfigB64(opts: {
  opsSession?: boolean;
  extraHosts?: string[];
  base?: readonly string[];
}): string {
  return buildResolverConfigB64({
    internalDomains: sessionInternalNames({ opsSession: opts.opsSession }),
    unqualifiedInternalNames: true,
    ...(opts.extraHosts ? { extraDomains: opts.extraHosts } : {}),
    ...(opts.base ? { base: opts.base } : {}),
  });
}

export interface LaunchResolverOpts {
  agentContainerId: string;
  sidecarImage: string;
  configB64: string;
  labels?: Record<string, string>;
}

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
