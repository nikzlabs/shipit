import type { CredentialStore } from "./credential-store.js";
import type { EgressAllowlistEntry, EgressAllowlistSource, SessionInfo } from "../shared/types.js";
import { getMcpOAuthProvider } from "./mcp-oauth-providers.js";

export const EGRESS_DEFAULT_ALLOWLIST: readonly string[] = [
  ".anthropic.com",
  ".claude.ai",
  "platform.claude.com",
  ".openai.com",
  ".chatgpt.com",
  "api.deepseek.com",
  "api.z.ai",
  "openrouter.ai",
  "ai-gateway.vercel.sh",
  "opencode.ai",
  "api.x.ai",
  "auth.x.ai",
  "cli-chat-proxy.grok.com",
  "generativelanguage.googleapis.com",
  // Antigravity's Google sign-in, its token exchange, and the backend its
  // account mode calls. A real account turn (2026-09-14, 1.1.27) sent BOTH
  // `loadCodeAssist` and `streamGenerateContent` to the `daily-` host, and the
  // bare one appeared nowhere; the bare one is kept because it is in the pinned
  // binary's compiled hosts and another account or version may reach it.
  "accounts.google.com",
  "oauth2.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "cloudcode-pa.googleapis.com",
  ".github.com",
  ".githubusercontent.com",
  ".githubassets.com",
  "github-cloud.s3.amazonaws.com", // Git LFS; keep this bucket exact.
  ".npmjs.org",
  ".npmjs.com",
  ".yarnpkg.com",
  ".pypi.org",
  ".pythonhosted.org",
  ".nodejs.org",
  ".gradle.org",
  "dl.google.com",
  "maven.google.com",
  ".maven.apache.org",
  ".maven.org",
  ".sonatype.org",
];

// Network-off sessions still need inference and token refresh.
export const EGRESS_LIFELINE_ALLOWLIST: readonly string[] = [
  ".anthropic.com",
  ".claude.ai",
  "platform.claude.com",
  ".openai.com",
  ".chatgpt.com",
  "api.deepseek.com",
  "api.z.ai",
  "openrouter.ai",
  "ai-gateway.vercel.sh",
  "opencode.ai",
  "api.x.ai",
  "auth.x.ai",
  "cli-chat-proxy.grok.com",
  "generativelanguage.googleapis.com",
  // Antigravity's Google sign-in, its token exchange, and the backend its
  // account mode calls. A real account turn (2026-09-14, 1.1.27) sent BOTH
  // `loadCodeAssist` and `streamGenerateContent` to the `daily-` host, and the
  // bare one appeared nowhere; the bare one is kept because it is in the pinned
  // binary's compiled hosts and another account or version may reach it.
  "accounts.google.com",
  "oauth2.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "cloudcode-pa.googleapis.com",
];

export const EGRESS_GITHUB_LIFELINE_HOSTS: readonly string[] = [
  ".github.com",
  ".githubusercontent.com",
  ".githubassets.com",
  "github-cloud.s3.amazonaws.com",
];

export function sandboxLifelineBase(opts: { git: boolean }): string[] {
  return [
    ...EGRESS_LIFELINE_ALLOWLIST,
    ...(opts.git ? EGRESS_GITHUB_LIFELINE_HOSTS : []),
  ];
}

/**
 * Every trailing dot, not one: readers normalize an already-stored value AGAIN,
 * so a pass that is not idempotent advertises an address the store does not hold
 * (docs/299-agent-settings-access req 1).
 */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** A leading dot matches the domain and its subdomains; other entries match exactly. */
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

export interface EgressAllowlist {
  entries: string[];
  isAllowed(host: string): boolean;
}

export function makeAllowlist(entries: Iterable<string>): EgressAllowlist {
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

export function parseAllowlistEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function hostFromUrl(url: string): string | null {
  try {
    const h = new URL(url).hostname;
    return h ? normalizeHost(h) : null;
  } catch {
    return null;
  }
}

// Include disabled HTTP servers so enabling one mid-session needs no restart.
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

export interface BuildAllowlistOpts {
  base?: readonly string[];
  extraHosts?: Iterable<string>;
  credentialStore?: CredentialStore;
}

// MCP hosts are read per connection; entries contains only the static base and extras.
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

export interface ComposeExtraHostsOpts {
  env?: NodeJS.ProcessEnv;
  credentialStore?: CredentialStore;
  durableHosts?: Iterable<string>;
}

export function composeEgressExtraHosts(opts: ComposeExtraHostsOpts = {}): string[] {
  const env = opts.env ?? process.env;
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string) => {
    const n = normalizeHost(raw);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };
  for (const h of parseAllowlistEnv(env.SESSION_EGRESS_ALLOWLIST)) add(h);
  if (opts.credentialStore) {
    for (const h of mcpHostsFromCredentialStore(opts.credentialStore)) add(h);
  }
  for (const h of opts.durableHosts ?? []) add(h);
  return out;
}

export interface EgressIdentityRule {
  host: string;
  identities: string[];
}

export interface ComposeIdentityRulesOpts {
  env?: NodeJS.ProcessEnv;
  /** Global rules override operator rules for the same host. */
  durableRules?: Iterable<EgressIdentityRule>;
}

function parseIdentityRulesEnv(value: string | undefined): EgressIdentityRule[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    console.warn(
      `[egress] SESSION_EGRESS_IDENTITY_RULES is not valid JSON ` +
        `(${err instanceof Error ? err.message : String(err)}); ignoring`,
    );
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn("[egress] SESSION_EGRESS_IDENTITY_RULES must be a JSON array; ignoring");
    return [];
  }
  const rules: EgressIdentityRule[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.host !== "string") continue;
    const identities = Array.isArray(rec.identities)
      ? rec.identities.filter((x): x is string => typeof x === "string")
      : [];
    rules.push({ host: rec.host, identities });
  }
  return rules;
}

// Invalid rules omit identity scoping; the host allowlist still applies.
export function composeEgressIdentityRules(opts: ComposeIdentityRulesOpts = {}): string {
  const env = opts.env ?? process.env;
  const byHost = new Map<string, EgressIdentityRule>();
  const ingest = (rules: Iterable<EgressIdentityRule>) => {
    for (const r of rules) {
      const host = normalizeHost(r.host ?? "");
      const identities = Array.isArray(r.identities)
        ? [...new Set(r.identities.map((i) => i.trim()).filter(Boolean))]
        : [];
      if (!host || identities.length === 0) continue;
      byHost.set(host, { host, identities });
    }
  };
  ingest(parseIdentityRulesEnv(env.SESSION_EGRESS_IDENTITY_RULES));
  if (opts.durableRules) ingest(opts.durableRules);
  const out = [...byHost.values()];
  return out.length ? JSON.stringify(out) : "";
}

export interface ResolvedEgressConfig {
  contained: boolean;
  extraHosts: string[];
  /**
   * docs/305 — addresses that never produce a DNS query, so the Tier B
   * resolver's `ipset` pinning cannot admit them. They go into the firewall's
   * CIDR input at every container creation, never as a one-off `ipset add`:
   * `init-firewall.sh:68` rebuilds the sets whenever the firewall reinstalls.
   */
  extraCidrs?: string[];
  /** Omitted means the full default base. */
  base?: string[];
  identityRules?: string;
  /** No user grant can widen this policy; distinct from an empty extras list. */
  userHostsExcluded?: boolean;
}

export interface SshEgressTargets {
  /** Hostname destinations, for the resolver and proxy allowlists. */
  names: string[];
  /** IP-literal destinations as /32 CIDRs, for the Tier A ipset. */
  cidrs: string[];
}

/**
 * Split a session's granted destinations by how each one can be admitted
 * (docs/305, req 12). Derived from the durable grant on every read rather than
 * mirrored into the per-session allowlist table, so a revoked grant cannot leave
 * an orphaned row behind and a rebuilt firewall re-applies the same set.
 */
export function sshEgressTargets(
  hosts: Iterable<{ address: string }>,
  classify: { isIpLiteral(address: string): boolean; ipLiteralCidr(address: string): string },
): SshEgressTargets {
  const names: string[] = [];
  const cidrs: string[] = [];
  for (const { address } of hosts) {
    if (classify.isIpLiteral(address)) cidrs.push(classify.ipLiteralCidr(address));
    else names.push(normalizeHost(address));
  }
  return { names: [...new Set(names)], cidrs: [...new Set(cidrs)] };
}

/**
 * A network-off sandbox discards the ordinary per-session host path
 * (`userHostsExcluded`), so SSH grants have to be composed into the effective
 * policy explicitly — names into the lifeline base, IPs into the CIDR input.
 * That is the one deliberate exception, the way `git` adds `github.com`
 * (docs/211); `shipit-docs/ssh.md` says so.
 */
// Internal orchestrator/worker hosts are added by the resolver and proxy.
export function sandboxLifelineEgressConfig(
  session: Pick<SessionInfo, "kind" | "capabilities"> | undefined,
  identityRules: string,
  ssh: SshEgressTargets = { names: [], cidrs: [] },
): ResolvedEgressConfig | null {
  if (session?.kind !== "sandbox" || session.capabilities?.network !== false) return null;
  return {
    contained: true,
    extraHosts: [],
    base: [...sandboxLifelineBase({ git: session.capabilities.git }), ...ssh.names],
    ...(ssh.cidrs.length > 0 ? { extraCidrs: ssh.cidrs } : {}),
    ...(identityRules ? { identityRules } : {}),
    userHostsExcluded: true,
  };
}

export function isBuiltinDefault(host: string): boolean {
  const h = normalizeHost(host);
  return EGRESS_DEFAULT_ALLOWLIST.some((e) => normalizeHost(e) === h);
}

export interface EffectiveAllowlistOpts {
  env?: NodeJS.ProcessEnv;
  base?: readonly string[];
  credentialStore?: CredentialStore;
  globalHosts?: Iterable<string>;
  sessionHosts?: Iterable<string>;
  suppressedDefaults?: Iterable<string>;
}

/**
 * The list as one entry per host, where several sources can supply the same one.
 *
 * A removal reaches only the sources a write owns — the user's rows and a
 * suppressible built-in default — so an entry is removable only when EVERY
 * source supplying it is, and the source named is the one that pins it.
 * First-source-wins on `removable` offered a remove button, and a proposal card,
 * for a host the operator or an MCP server would keep allowed.
 */
export function buildEffectiveAllowlist(opts: EffectiveAllowlistOpts = {}): EgressAllowlistEntry[] {
  const env = opts.env ?? process.env;
  const base = opts.base ?? EGRESS_DEFAULT_ALLOWLIST;
  const suppressed = new Set<string>();
  for (const h of opts.suppressedDefaults ?? []) suppressed.add(normalizeHost(h));
  const byHost = new Map<string, EgressAllowlistEntry>();
  const entries: EgressAllowlistEntry[] = [];
  const push = (raw: string, source: EgressAllowlistSource, removable: boolean) => {
    const host = normalizeHost(raw);
    if (!host) return;
    const already = byHost.get(host);
    if (!already) {
      const entry: EgressAllowlistEntry = { host, source, removable };
      byHost.set(host, entry);
      entries.push(entry);
      return;
    }
    if (removable || !already.removable) return;
    already.source = source;
    already.removable = false;
  };

  for (const h of base) {
    if (suppressed.has(normalizeHost(h))) continue;
    push(h, "builtin", true);
  }
  for (const h of parseAllowlistEnv(env.SESSION_EGRESS_ALLOWLIST)) push(h, "operator", false);
  if (opts.credentialStore) {
    for (const h of mcpHostsFromCredentialStore(opts.credentialStore)) push(h, "mcp", false);
  }
  for (const h of opts.globalHosts ?? []) push(h, "user-global", true);
  for (const h of opts.sessionHosts ?? []) push(h, "user-session", true);
  return entries;
}
