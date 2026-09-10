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

export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
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
  /** Omitted means the full default base. */
  base?: string[];
  identityRules?: string;
  /** No user grant can widen this policy; distinct from an empty extras list. */
  userHostsExcluded?: boolean;
}

// Internal orchestrator/worker hosts are added by the resolver and proxy.
export function sandboxLifelineEgressConfig(
  session: Pick<SessionInfo, "kind" | "capabilities"> | undefined,
  identityRules: string,
): ResolvedEgressConfig | null {
  if (session?.kind !== "sandbox" || session.capabilities?.network !== false) return null;
  return {
    contained: true,
    extraHosts: [],
    base: sandboxLifelineBase({ git: session.capabilities.git }),
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

export function buildEffectiveAllowlist(opts: EffectiveAllowlistOpts = {}): EgressAllowlistEntry[] {
  const env = opts.env ?? process.env;
  const base = opts.base ?? EGRESS_DEFAULT_ALLOWLIST;
  const suppressed = new Set<string>();
  for (const h of opts.suppressedDefaults ?? []) suppressed.add(normalizeHost(h));
  const seen = new Set<string>();
  const entries: EgressAllowlistEntry[] = [];
  const push = (raw: string, source: EgressAllowlistSource, removable: boolean) => {
    const host = normalizeHost(raw);
    if (!host || seen.has(host)) return;
    seen.add(host);
    entries.push({ host, source, removable });
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
