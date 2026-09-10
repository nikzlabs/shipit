import type Docker from "dockerode";
import {
  EGRESS_TIER_A_RESOLVE_HOSTS,
  EGRESS_GITHUB_CIDRS_FALLBACK,
  parseGitHubMetaCidrs,
  buildIpsetMembers,
  isValidCidr,
} from "./egress-firewall.js";
import type { EgressEnforcementStatus } from "../shared/types.js";

const GITHUB_META_URL = "https://api.github.com/meta";
const META_FETCH_TIMEOUT_MS = 5_000;
const META_CACHE_TTL_MS = 60 * 60 * 1000;

export function egressEnforceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SESSION_EGRESS_ENFORCE !== "0";
}

export function egressEnforcementActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return egressEnforceEnabled(env) && Boolean(env.SESSION_EGRESS_SIDECAR_IMAGE);
}

// Disabled runs open; no-sidecar refuses contained session starts.
export function egressEnforcementStatus(
  env: NodeJS.ProcessEnv = process.env,
): EgressEnforcementStatus {
  if (!egressEnforceEnabled(env)) return "disabled";
  return env.SESSION_EGRESS_SIDECAR_IMAGE ? "active" : "no-sidecar";
}

interface CidrCache {
  at: number;
  cidrs: string[];
}
let cidrCache: CidrCache | null = null;

export function _resetEgressCidrCache(): void {
  cidrCache = null;
}

export interface FetchCidrsOpts {
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
}

export async function fetchGitHubMetaCidrs(opts: FetchCidrsOpts = {}): Promise<string[]> {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? META_CACHE_TTL_MS;
  if (cidrCache && now() - cidrCache.at < ttl) return cidrCache.cidrs;

  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(GITHUB_META_URL, { signal: AbortSignal.timeout(META_FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`meta HTTP ${res.status}`);
    const json: unknown = await res.json();
    const cidrs = buildIpsetMembers({ cidrs: parseGitHubMetaCidrs(json) });
    if (cidrs.length === 0) throw new Error("meta returned no usable CIDRs");
    cidrCache = { at: now(), cidrs };
    return cidrs;
  } catch (err) {
    console.warn(
      `[egress] GitHub meta fetch failed (${err instanceof Error ? err.message : String(err)}); ` +
        `using ${EGRESS_GITHUB_CIDRS_FALLBACK.length} baked-in fallback CIDRs`,
    );
    return [...EGRESS_GITHUB_CIDRS_FALLBACK];
  }
}

export interface TierAEgressInputs {
  hosts: string[];
  cidrs: string[];
}

// Resolve hosts inside the agent's network namespace before installing the deny policy.
export async function buildTierAEgressInputs(opts: FetchCidrsOpts = {}): Promise<TierAEgressInputs> {
  const cidrs = await fetchGitHubMetaCidrs(opts);
  return { hosts: [...EGRESS_TIER_A_RESOLVE_HOSTS], cidrs };
}

export interface InstallEgressFirewallOpts {
  agentContainerId: string;
  sidecarImage: string;
  inputs: TierAEgressInputs;
  /** Restrict upstream DNS to this UID; omitted leaves DNS open. */
  resolverUid?: number;
  /** Redirect HTTPS through the proxy, exempting its own UID. */
  proxyUid?: number;
  proxyPort?: number;
  labels?: Record<string, string>;
}

export async function installEgressFirewall(
  docker: Docker,
  opts: InstallEgressFirewallOpts,
): Promise<void> {
  const container = await docker.createContainer({
    Image: opts.sidecarImage,
    Labels: opts.labels,
    HostConfig: {
      NetworkMode: `container:${opts.agentContainerId}`,
      CapAdd: ["NET_ADMIN"],
      AutoRemove: false, // Read the exit code before removal.
    },
    Env: [
      `EGRESS_ALLOWED_HOSTS=${opts.inputs.hosts.join(" ")}`,
      `EGRESS_ALLOWED_CIDRS=${opts.inputs.cidrs.join(" ")}`,
      ...(opts.resolverUid !== undefined ? [`EGRESS_DNS_RESOLVER_UID=${opts.resolverUid}`] : []),
      ...(opts.proxyUid !== undefined ? [`EGRESS_PROXY_UID=${opts.proxyUid}`] : []),
      ...(opts.proxyUid !== undefined && opts.proxyPort !== undefined ? [`EGRESS_PROXY_PORT=${opts.proxyPort}`] : []),
    ],
  });

  try {
    await container.start();
    const result = (await container.wait()) as { StatusCode?: number };
    const code = result.StatusCode ?? -1;
    if (code !== 0) {
      let logs = "";
      try {
        logs = (await container.logs({ stdout: true, stderr: true, tail: 40 })).toString("utf-8");
      } catch {
        /* logs best-effort */
      }
      throw new Error(`egress firewall installer exited ${code}${logs ? `:\n${logs}` : ""}`);
    }
  } finally {
    try {
      await container.remove({ force: true });
    } catch {
      /* already gone */
    }
  }
}

export interface AllowEgressToSubnetsOpts {
  agentContainerId: string;
  sidecarImage: string;
  subnets: string[];
  labels?: Record<string, string>;
}

// Preview networks attach after the initial firewall. Allow their specific subnets, not all RFC1918.
export async function allowEgressToSubnets(
  docker: Docker,
  opts: AllowEgressToSubnetsOpts,
): Promise<string[]> {
  const subnets = opts.subnets.map((s) => s.trim()).filter((s) => s && isValidCidr(s));
  if (subnets.length === 0) return [];

  const container = await docker.createContainer({
    Image: opts.sidecarImage,
    Labels: opts.labels,
    Entrypoint: ["/usr/local/bin/allow-subnet.sh"],
    HostConfig: {
      NetworkMode: `container:${opts.agentContainerId}`,
      CapAdd: ["NET_ADMIN"],
      AutoRemove: false,
    },
    Env: [`EGRESS_ALLOW_SUBNETS=${subnets.join(" ")}`],
  });

  try {
    await container.start();
    const result = (await container.wait()) as { StatusCode?: number };
    const code = result.StatusCode ?? -1;
    if (code !== 0) {
      let logs = "";
      try {
        logs = (await container.logs({ stdout: true, stderr: true, tail: 40 })).toString("utf-8");
      } catch {
        /* logs best-effort */
      }
      throw new Error(`egress subnet-allow sidecar exited ${code}${logs ? `:\n${logs}` : ""}`);
    }
  } finally {
    try {
      await container.remove({ force: true });
    } catch {
      /* already gone */
    }
  }
  return subnets;
}
