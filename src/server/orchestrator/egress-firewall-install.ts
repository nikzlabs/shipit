import type Docker from "dockerode";
import {
  EGRESS_TIER_A_RESOLVE_HOSTS,
  EGRESS_GITHUB_CIDRS_FALLBACK,
  parseGitHubMetaCidrs,
  buildIpsetMembers,
  isValidCidr,
  isValidIp,
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

export interface TierAInputOpts extends FetchCidrsOpts {
  /**
   * docs/305 — per-session CIDRs derived from durable SSH grants. They belong in
   * the firewall's INPUT rather than in a later `ipset add`, because
   * `init-firewall.sh:68` destroys and rebuilds the sets whenever the firewall
   * reinstalls; a grant applied only to the running namespace would vanish.
   */
  extraCidrs?: readonly string[];
}

// Resolve hosts inside the agent's network namespace before installing the deny policy.
export async function buildTierAEgressInputs(opts: TierAInputOpts = {}): Promise<TierAEgressInputs> {
  const cidrs = await fetchGitHubMetaCidrs(opts);
  const extra = (opts.extraCidrs ?? []).filter((c) => isValidCidr(c));
  return {
    hosts: [...EGRESS_TIER_A_RESOLVE_HOSTS],
    cidrs: [...new Set([...cidrs, ...extra])],
  };
}

/** `open` installs only the local block (docs/319-api-reach-through-host req 4). */
export type EgressPolicy = "contained" | "open";

export interface SshEgressTarget {
  address: string;
  port: number;
}

export interface LocalTcpAccept {
  subnet: string;
  port: number;
}

export const NO_TIER_A_INPUTS: TierAEgressInputs = { hosts: [], cidrs: [] };

/** Every firewall sidecar holds NET_ADMIN in a session's namespace; the Docker proxy refuses them. */
export const EGRESS_SIDECAR_MARKER_LABEL = "shipit-egress-sidecar";

export interface InstallEgressFirewallOpts {
  agentContainerId: string;
  sidecarImage: string;
  inputs: TierAEgressInputs;
  /** Omitted means contained, the allowlist. */
  policy?: EgressPolicy;
  /** The Docker host's own addresses (`local-block.ts`). */
  hostAddresses?: readonly string[];
  /** What this container may use on a network other sessions share. */
  localTcp?: readonly LocalTcpAccept[];
  /** The one exception to the local block: each on its own port (req 5). */
  sshTargets?: readonly SshEgressTarget[];
  /** Restrict upstream DNS to this UID; omitted leaves DNS open. */
  resolverUid?: number;
  /** Redirect HTTPS through the proxy, exempting its own UID. */
  proxyUid?: number;
  proxyPort?: number;
  labels?: Record<string, string>;
}

const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

function validPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

/** `host:port`, or `[v6]:port`; anything the script could misread is dropped. */
export function formatSshTargets(targets: readonly SshEgressTarget[]): string[] {
  const out = new Set<string>();
  for (const { address, port } of targets) {
    const addr = address.trim();
    if (!validPort(port)) continue;
    if (isValidIp(addr)) out.add(addr.includes(":") ? `[${addr}]:${port}` : `${addr}:${port}`);
    else if (HOSTNAME_RE.test(addr)) out.add(`${addr}:${port}`);
  }
  return [...out];
}

export function formatLocalTcp(accepts: readonly LocalTcpAccept[]): string[] {
  const out = new Set<string>();
  for (const { subnet, port } of accepts) {
    const cidr = subnet.trim();
    // IPv4 only: the script splits on the last colon.
    if (isValidCidr(cidr) && !cidr.includes(":") && validPort(port)) {
      out.add(`${cidr}:${port}`);
    }
  }
  return [...out];
}

export function buildFirewallEnv(opts: Omit<InstallEgressFirewallOpts, "agentContainerId" | "sidecarImage" | "labels">): string[] {
  const policy = opts.policy ?? "contained";
  const contained = policy === "contained";
  return [
    `EGRESS_POLICY=${policy}`,
    `EGRESS_ALLOWED_HOSTS=${contained ? opts.inputs.hosts.join(" ") : ""}`,
    `EGRESS_ALLOWED_CIDRS=${contained ? opts.inputs.cidrs.join(" ") : ""}`,
    `EGRESS_HOST_ADDRS=${(opts.hostAddresses ?? []).filter((a) => isValidIp(a)).join(" ")}`,
    `EGRESS_LOCAL_TCP=${formatLocalTcp(opts.localTcp ?? []).join(" ")}`,
    `EGRESS_SSH_TARGETS=${formatSshTargets(opts.sshTargets ?? []).join(" ")}`,
    ...(contained && opts.resolverUid !== undefined ? [`EGRESS_DNS_RESOLVER_UID=${opts.resolverUid}`] : []),
    ...(contained && opts.proxyUid !== undefined ? [`EGRESS_PROXY_UID=${opts.proxyUid}`] : []),
    ...(contained && opts.proxyUid !== undefined && opts.proxyPort !== undefined
      ? [`EGRESS_PROXY_PORT=${opts.proxyPort}`]
      : []),
  ];
}

export async function installEgressFirewall(
  docker: Docker,
  opts: InstallEgressFirewallOpts,
): Promise<void> {
  const container = await docker.createContainer({
    Image: opts.sidecarImage,
    Labels: { ...opts.labels, [EGRESS_SIDECAR_MARKER_LABEL]: "true" },
    HostConfig: {
      NetworkMode: `container:${opts.agentContainerId}`,
      CapAdd: ["NET_ADMIN"],
      AutoRemove: false, // Read the exit code before removal.
    },
    Env: buildFirewallEnv(opts),
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

/** The namespace was installed before docs/319 and has no chain to update; reinstall it. */
export class LegacyEgressNamespaceError extends Error {}

export interface AllowEgressToSubnetsOpts {
  agentContainerId: string;
  sidecarImage: string;
  subnets: string[];
  /** The networks' gateways: the host, refused before their subnets open. */
  gateways?: string[];
  /** When set, replaces the namespace's accepts for ShipIt's own address. */
  localTcp?: readonly LocalTcpAccept[];
  labels?: Record<string, string>;
}

// Preview networks attach after the initial firewall. Allow their specific subnets, not all RFC1918.
export async function allowEgressToSubnets(
  docker: Docker,
  opts: AllowEgressToSubnetsOpts,
): Promise<string[]> {
  const subnets = opts.subnets.map((s) => s.trim()).filter((s) => s && isValidCidr(s));
  const localTcp = formatLocalTcp(opts.localTcp ?? []);
  if (subnets.length === 0 && localTcp.length === 0) return [];
  const gateways = (opts.gateways ?? []).map((g) => g.trim()).filter((g) => g && isValidIp(g));

  const container = await docker.createContainer({
    Image: opts.sidecarImage,
    Labels: { ...opts.labels, [EGRESS_SIDECAR_MARKER_LABEL]: "true" },
    Entrypoint: ["/usr/local/bin/allow-subnet.sh"],
    HostConfig: {
      NetworkMode: `container:${opts.agentContainerId}`,
      CapAdd: ["NET_ADMIN"],
      AutoRemove: false,
    },
    Env: [
      `EGRESS_ALLOW_SUBNETS=${subnets.join(" ")}`,
      `EGRESS_BLOCK_ADDRS=${gateways.join(" ")}`,
      ...(localTcp.length > 0 ? [`EGRESS_LOCAL_TCP=${localTcp.join(" ")}`] : []),
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
      if (code === 3) throw new LegacyEgressNamespaceError(`egress namespace predates docs/319${logs ? `:\n${logs}` : ""}`);
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
