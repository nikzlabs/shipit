/**
 * Egress firewall install — Tier A enforcement wiring (docs/172 Gap 1, SHI-90).
 *
 * Launches the short-lived privileged **installer sidecar** that shares the
 * agent container's network namespace and applies the default-deny `iptables`
 * `OUTPUT` policy + `ipset` allow-set (see `docker/egress-sidecar/init-firewall.sh`
 * and `docs/172-agent-containment/egress-control.md`). The agent container keeps
 * `CapDrop: ["ALL"]` / non-root (SHI-31); the capability to install the rules
 * lives only in this sidecar, which exits immediately after — the rules persist
 * in the netns and the agent cannot flush them.
 *
 * Gated behind `SESSION_EGRESS_ENFORCE=1` (default off): merging this is inert
 * until an operator enables it, so it can land without changing prod behavior
 * and be verified on a canary/dogfood session (the SHI-90 checklist).
 *
 * This module is the orchestration seam. The pieces that are pure and
 * unit-testable — the GitHub meta fetch + parse + fallback, the allow-set
 * inputs, the flag gate — are tested in `egress-firewall-install.test.ts`. The
 * actual `docker run --network container:<id> --cap-add NET_ADMIN` + iptables
 * application requires a live Docker host and is verified there, not in unit
 * tests.
 */

import type Docker from "dockerode";
import {
  EGRESS_TIER_A_RESOLVE_HOSTS,
  EGRESS_GITHUB_CIDRS_FALLBACK,
  parseGitHubMetaCidrs,
  buildIpsetMembers,
} from "./egress-firewall.js";

const GITHUB_META_URL = "https://api.github.com/meta";
const META_FETCH_TIMEOUT_MS = 5_000;
const META_CACHE_TTL_MS = 60 * 60 * 1000; // 1h — GitHub ranges change rarely

/** Is Tier A egress enforcement enabled? Default OFF (fail-safe rollout). */
export function egressEnforceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SESSION_EGRESS_ENFORCE === "1";
}

// --- GitHub meta CIDR fetch (cached + fallback) ----------------------------

interface CidrCache {
  at: number;
  cidrs: string[];
}
let cidrCache: CidrCache | null = null;

/** Test-only: clear the module-level GitHub-CIDR cache between cases. */
export function _resetEgressCidrCache(): void {
  cidrCache = null;
}

export interface FetchCidrsOpts {
  /** Inject `fetch` for tests. */
  fetchImpl?: typeof fetch;
  /** Inject the clock for tests. */
  now?: () => number;
  ttlMs?: number;
}

/**
 * Fetch the current GitHub egress CIDR ranges from the public `meta` endpoint,
 * parsed + validated via {@link parseGitHubMetaCidrs}/{@link buildIpsetMembers}.
 * Cached for {@link META_CACHE_TTL_MS}. On ANY failure (network, non-2xx, empty
 * parse) falls back to {@link EGRESS_GITHUB_CIDRS_FALLBACK} so GitHub stays
 * reachable — egress enforcement must not make `git` flaky because `meta` was
 * briefly down. The endpoint is public, so no token is needed.
 */
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

// --- Allow-set inputs ------------------------------------------------------

export interface TierAEgressInputs {
  /** Concrete FQDNs the installer resolves (in the agent netns) and allows. */
  hosts: string[];
  /** CIDR ranges to allow (GitHub meta + fallback). */
  cidrs: string[];
}

/**
 * Build the inputs the installer sidecar needs: the concrete resolve-host list
 * plus the GitHub CIDR ranges. Hostname → IP resolution happens inside the
 * sidecar (in the agent's own DNS view, before the deny policy is set), so the
 * pinned IPs match what the agent will actually resolve.
 */
export async function buildTierAEgressInputs(opts: FetchCidrsOpts = {}): Promise<TierAEgressInputs> {
  const cidrs = await fetchGitHubMetaCidrs(opts);
  return { hosts: [...EGRESS_TIER_A_RESOLVE_HOSTS], cidrs };
}

// --- Installer sidecar launch ----------------------------------------------

export interface InstallEgressFirewallOpts {
  /** Docker id of the running agent container whose netns we install into. */
  agentContainerId: string;
  /** Image that contains `init-firewall.sh` + iptables/ipset/bind-tools. */
  sidecarImage: string;
  inputs: TierAEgressInputs;
  /**
   * docs/172 Tier B — when set, the installer locks DNS to the in-netns resolver:
   * port-53 egress is allowed ONLY for this uid (the resolver's upstream queries),
   * and the agent is blocked from Docker's embedded DNS. Absent → Tier A (DNS open).
   */
  resolverUid?: number;
  /**
   * docs/172 Tier C — when set, the installer REDIRECTs the agent's outbound :443
   * to the in-netns SNI proxy on {@link proxyPort}, excluding this proxy uid (so
   * the proxy's own dials aren't re-redirected). Absent → no SNI redirect.
   */
  proxyUid?: number;
  /** Port the SNI proxy listens on (default 8443). Only used with proxyUid. */
  proxyPort?: number;
  /** Labels to stamp on the sidecar container (for cleanup/discovery). */
  labels?: Record<string, string>;
}

/**
 * Run the installer sidecar in the agent container's network namespace and wait
 * for it to finish. Throws if the installer exits non-zero (including its
 * `example.com`-must-fail self-test) — the caller treats that as **fail-closed**
 * and tears down the agent container rather than run it with unenforced egress.
 */
export async function installEgressFirewall(
  docker: Docker,
  opts: InstallEgressFirewallOpts,
): Promise<void> {
  const container = await docker.createContainer({
    Image: opts.sidecarImage,
    Labels: opts.labels,
    HostConfig: {
      // Share the agent's netns so iptables/ipset apply to ITS stack. The agent
      // itself has no NET_ADMIN; this sidecar does, and only briefly.
      NetworkMode: `container:${opts.agentContainerId}`,
      CapAdd: ["NET_ADMIN"],
      AutoRemove: false, // removed manually below after reading the exit code
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
