/**
 * Egress firewall — Tier A allow-set construction (docs/172 Gap 1, SHI-90).
 *
 * Tier A is the un-bypassable floor: a default-deny `iptables OUTPUT` policy plus
 * an `ipset` of permitted destination IPs/CIDRs, installed **inside the agent
 * container's network namespace** by a short-lived privileged sidecar
 * (`--network container:<agent> --cap-add NET_ADMIN`) — see
 * `docs/172-agent-containment/egress-control.md`. The agent itself has no
 * `NET_ADMIN` (and, since SHI-31, runs non-root), so it can neither install nor
 * flush these rules.
 *
 * This module owns the **data** half — what goes in the ipset — which is pure,
 * host-independent, and unit-testable. The *application* (running iptables/ipset
 * in the netns) is orchestration that requires a live Docker host and is covered
 * by integration/manual verification, not these unit tests.
 *
 * Two sources feed the ipset, mirroring Anthropic's reference
 * `.devcontainer/init-firewall.sh`:
 *   1. **Concrete FQDNs resolved to IPs** ({@link EGRESS_TIER_A_RESOLVE_HOSTS}).
 *      Tier A is IP-based, so it needs concrete hostnames — the *suffix* allowlist
 *      used by the Tier C proxy (`egress-allowlist.ts`) does not map to IPs.
 *   2. **Published CIDR ranges** — GitHub via `gh api meta` (`.web`/`.api`/`.git`),
 *      which is more robust than resolving `github.com` to a single rotating IP.
 *
 * Ordering note (enforced by the installer, not here): resolution + the
 * `gh api meta` fetch happen **before** the `OUTPUT DROP` policy is set —
 * once default-deny is up, the installer itself could no longer reach
 * `api.github.com`. The GitHub fetch is done orchestrator-side (it holds the
 * brokered token) and the CIDRs passed to the installer.
 */

/**
 * Concrete FQDNs the Tier A ipset resolves to IPs. This is the IP-floor's own
 * list, distinct from (though overlapping with) the Tier C suffix allowlist in
 * `egress-allowlist.ts`: a packet filter matches addresses, so suffix wildcards
 * like `.anthropic.com` can't be expressed here — the concrete endpoints are.
 * GitHub is intentionally absent: it is covered by `gh api meta` CIDR ranges.
 */
export const EGRESS_TIER_A_RESOLVE_HOSTS: readonly string[] = [
  // Agent APIs — Claude / Anthropic
  "api.anthropic.com",
  "console.anthropic.com",
  "statsig.anthropic.com",
  // Agent APIs — Codex / OpenAI
  "api.openai.com",
  "auth.openai.com",
  "chatgpt.com",
  // Package registries
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
];

// ---------------------------------------------------------------------------
// IP / CIDR validation
// ---------------------------------------------------------------------------

function isValidIpv4(s: string): boolean {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255 && String(n) === p; // reject "01", "255" ok
  });
}

function isValidIpv6(s: string): boolean {
  // Permissive but safe: hex groups separated by ':', optional "::" once.
  if (!s.includes(":")) return false;
  if (!/^[0-9a-fA-F:]+$/.test(s)) return false;
  if ((s.match(/::/g) ?? []).length > 1) return false;
  return true;
}

/** True if `s` is a bare IPv4 or IPv6 address. */
export function isValidIp(s: string): boolean {
  return isValidIpv4(s) || isValidIpv6(s);
}

/** True if `s` is an `addr/prefix` CIDR with an in-range prefix length. */
export function isValidCidr(s: string): boolean {
  const slash = s.indexOf("/");
  if (slash === -1) return false;
  const addr = s.slice(0, slash);
  const prefixStr = s.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixStr)) return false;
  const prefix = Number(prefixStr);
  if (isValidIpv4(addr)) return prefix >= 0 && prefix <= 32;
  if (isValidIpv6(addr)) return prefix >= 0 && prefix <= 128;
  return false;
}

// ---------------------------------------------------------------------------
// GitHub meta CIDR parsing
// ---------------------------------------------------------------------------

/**
 * Extract the GitHub egress CIDR ranges from a parsed `gh api meta` response.
 * Pulls the `web`, `api`, and `git` arrays (the surfaces git/clone/release/API
 * traffic uses), keeps only valid CIDRs, and de-duplicates while preserving
 * first-seen order. Tolerant of missing keys and non-array/garbage values so a
 * malformed or partial response degrades to "fewer ranges", never a throw.
 */
export function parseGitHubMetaCidrs(meta: unknown): string[] {
  if (!meta || typeof meta !== "object") return [];
  const obj = meta as Record<string, unknown>;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of ["web", "api", "git"] as const) {
    const arr = obj[key];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (typeof entry !== "string") continue;
      const cidr = entry.trim();
      if (!isValidCidr(cidr) || seen.has(cidr)) continue;
      seen.add(cidr);
      out.push(cidr);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ipset member composition
// ---------------------------------------------------------------------------

/**
 * Compose the deduplicated, validated member set for the Tier A `allowed-egress`
 * ipset (`hash:net`, which accepts both bare IPs and CIDRs) from resolved host
 * IPs and published CIDR ranges. Invalid entries are dropped (defensive — a bad
 * `dig` line or a malformed range must not poison the set). Output is sorted for
 * a deterministic ipset (stable restore files, diffable logs).
 */
export function buildIpsetMembers(opts: { ips?: readonly string[]; cidrs?: readonly string[] }): string[] {
  const members = new Set<string>();
  for (const ip of opts.ips ?? []) {
    const v = ip.trim();
    if (v && isValidIp(v)) members.add(v);
  }
  for (const cidr of opts.cidrs ?? []) {
    const v = cidr.trim();
    if (v && isValidCidr(v)) members.add(v);
  }
  return [...members].sort();
}
