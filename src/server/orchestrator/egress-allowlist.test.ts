/**
 * Tests for the egress allowlist (docs/172 Gap 1, SHI-90).
 */

import { describe, it, expect } from "vitest";
import {
  EGRESS_DEFAULT_ALLOWLIST,
  normalizeHost,
  hostMatchesEntry,
  makeAllowlist,
  parseAllowlistEnv,
  hostFromUrl,
  mcpHostsFromCredentialStore,
  buildEgressAllowlist,
  composeEgressExtraHosts,
  composeEgressIdentityRules,
  buildEffectiveAllowlist,
  isBuiltinDefault,
} from "./egress-allowlist.js";
import type { CredentialStore } from "./credential-store.js";
import type { McpServerConfig, OAuthTokens } from "../shared/types/mcp-types.js";

// ---------------------------------------------------------------------------
// normalizeHost / hostMatchesEntry
// ---------------------------------------------------------------------------

describe("normalizeHost", () => {
  it("lowercases and strips a single trailing dot", () => {
    expect(normalizeHost("API.GitHub.COM")).toBe("api.github.com");
    expect(normalizeHost("github.com.")).toBe("github.com");
    expect(normalizeHost("  github.com  ")).toBe("github.com");
  });
});

describe("hostMatchesEntry", () => {
  it("exact entry matches only the exact host", () => {
    expect(hostMatchesEntry("github.com", "github.com")).toBe(true);
    expect(hostMatchesEntry("api.github.com", "github.com")).toBe(false);
    expect(hostMatchesEntry("notgithub.com", "github.com")).toBe(false);
  });

  it("suffix entry (.x) matches the bare domain and subdomains", () => {
    expect(hostMatchesEntry("github.com", ".github.com")).toBe(true);
    expect(hostMatchesEntry("api.github.com", ".github.com")).toBe(true);
    expect(hostMatchesEntry("codeload.github.com", ".github.com")).toBe(true);
  });

  it("suffix entry does NOT match a look-alike that merely ends in the string", () => {
    // The classic allowlist bypass: "evil-github.com" should not match ".github.com".
    expect(hostMatchesEntry("evilgithub.com", ".github.com")).toBe(false);
    expect(hostMatchesEntry("github.com.attacker.com", ".github.com")).toBe(false);
  });

  it("is case-insensitive and FQDN-tolerant", () => {
    expect(hostMatchesEntry("API.GITHUB.COM.", ".github.com")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// makeAllowlist
// ---------------------------------------------------------------------------

describe("makeAllowlist", () => {
  it("de-duplicates normalized entries", () => {
    const al = makeAllowlist(["github.com", "GitHub.com", "github.com."]);
    expect(al.entries).toEqual(["github.com"]);
  });

  it("isAllowed returns false for the empty host", () => {
    const al = makeAllowlist(["github.com"]);
    expect(al.isAllowed("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseAllowlistEnv / hostFromUrl
// ---------------------------------------------------------------------------

describe("parseAllowlistEnv", () => {
  it("splits on commas and whitespace, trims, drops blanks", () => {
    expect(parseAllowlistEnv("a.com, b.com   c.com,,")).toEqual(["a.com", "b.com", "c.com"]);
  });
  it("returns [] for undefined/empty", () => {
    expect(parseAllowlistEnv(undefined)).toEqual([]);
    expect(parseAllowlistEnv("")).toEqual([]);
  });
});

describe("hostFromUrl", () => {
  it("extracts the normalized host", () => {
    expect(hostFromUrl("https://mcp.example.com/mcp")).toBe("mcp.example.com");
    expect(hostFromUrl("https://MCP.Example.com:8443/x")).toBe("mcp.example.com");
  });
  it("returns null for unparseable URLs", () => {
    expect(hostFromUrl("not a url")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mcpHostsFromCredentialStore — minimal stub of the store surface used
// ---------------------------------------------------------------------------

function stubStore(opts: {
  servers?: Record<string, McpServerConfig>;
  oauth?: Record<string, OAuthTokens>;
}): CredentialStore {
  return {
    getAllMcpServers: () => opts.servers ?? {},
    getAllMcpOAuthTokens: () => opts.oauth ?? {},
  } as unknown as CredentialStore;
}

describe("mcpHostsFromCredentialStore", () => {
  it("collects hosts from configured HTTP MCP servers", () => {
    const store = stubStore({
      servers: {
        custom: { name: "custom", type: "http", url: "https://mcp.acme.dev/sse", enabled: true },
        local: { name: "local", type: "stdio", command: "npx", enabled: true },
      },
    });
    expect(mcpHostsFromCredentialStore(store)).toEqual(["mcp.acme.dev"]);
  });

  it("collects hosts from OAuth-connected providers (e.g. Notion)", () => {
    const store = stubStore({ oauth: { notion_oauth: { accessToken: "t" } } });
    expect(mcpHostsFromCredentialStore(store)).toContain("mcp.notion.com");
  });

  it("ignores unknown OAuth sources", () => {
    const store = stubStore({ oauth: { made_up_source: { accessToken: "t" } } });
    expect(mcpHostsFromCredentialStore(store)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildEgressAllowlist — composition + acceptance-style checks
// ---------------------------------------------------------------------------

describe("buildEgressAllowlist", () => {
  it("allows the core agent / git / registry hosts by default", () => {
    const al = buildEgressAllowlist();
    expect(al.isAllowed("api.anthropic.com")).toBe(true);
    expect(al.isAllowed("github.com")).toBe(true);
    expect(al.isAllowed("api.github.com")).toBe(true);
    expect(al.isAllowed("codeload.github.com")).toBe(true);
    expect(al.isAllowed("registry.npmjs.org")).toBe(true);
    expect(al.isAllowed("api.openai.com")).toBe(true);
  });

  it("DENIES an arbitrary attacker host (the core acceptance criterion)", () => {
    const al = buildEgressAllowlist();
    expect(al.isAllowed("attacker.com")).toBe(false);
    expect(al.isAllowed("evil.example.com")).toBe(false);
    // look-alike that ends with an allowlisted suffix but isn't a subdomain
    expect(al.isAllowed("api.anthropic.com.attacker.com")).toBe(false);
  });

  it("honors operator-supplied extra hosts", () => {
    const al = buildEgressAllowlist({ extraHosts: ["internal-registry.corp"] });
    expect(al.isAllowed("internal-registry.corp")).toBe(true);
    expect(al.isAllowed("attacker.com")).toBe(false);
  });

  it("allows configured MCP hosts dynamically from the credential store", () => {
    const store = stubStore({
      servers: { acme: { name: "acme", type: "http", url: "https://mcp.acme.dev/sse", enabled: true } },
    });
    const al = buildEgressAllowlist({ credentialStore: store });
    expect(al.isAllowed("mcp.acme.dev")).toBe(true);
    expect(al.isAllowed("attacker.com")).toBe(false);
  });

  it("re-reads MCP hosts on each call (a server connected mid-session takes effect)", () => {
    const servers: Record<string, McpServerConfig> = {};
    const store = stubStore({ servers });
    const al = buildEgressAllowlist({ credentialStore: store });
    expect(al.isAllowed("mcp.late.dev")).toBe(false);
    servers.late = { name: "late", type: "http", url: "https://mcp.late.dev/sse", enabled: true };
    expect(al.isAllowed("mcp.late.dev")).toBe(true);
  });

  it("base default list is non-empty and all suffix/exact entries normalize", () => {
    expect(EGRESS_DEFAULT_ALLOWLIST.length).toBeGreaterThan(0);
    for (const e of EGRESS_DEFAULT_ALLOWLIST) {
      expect(normalizeHost(e)).toBe(e); // already normalized in source
    }
  });
});

// ---------------------------------------------------------------------------
// composeEgressExtraHosts — the shared resolver/proxy extra-host seam
// ---------------------------------------------------------------------------

describe("composeEgressExtraHosts", () => {
  it("returns [] for an empty env + no sources", () => {
    expect(composeEgressExtraHosts({ env: {} })).toEqual([]);
  });

  it("reads operator extras from SESSION_EGRESS_ALLOWLIST", () => {
    const hosts = composeEgressExtraHosts({ env: { SESSION_EGRESS_ALLOWLIST: "a.corp, .b.corp" } });
    expect(hosts).toEqual(["a.corp", ".b.corp"]);
  });

  it("merges env extras + live MCP hosts + durable hosts, de-duped + normalized", () => {
    const store = stubStore({
      servers: { acme: { name: "acme", type: "http", url: "https://mcp.acme.dev/sse", enabled: true } },
    });
    const hosts = composeEgressExtraHosts({
      env: { SESSION_EGRESS_ALLOWLIST: "ops.corp" },
      credentialStore: store,
      durableHosts: ["Durable.Example.com.", "ops.corp"], // dup + needs-normalize
    });
    expect(hosts).toEqual(["ops.corp", "mcp.acme.dev", "durable.example.com"]);
  });

  it("includes durable hosts even with no env or MCP source", () => {
    expect(composeEgressExtraHosts({ env: {}, durableHosts: [".user.example.com"] })).toEqual([".user.example.com"]);
  });
});

// ---------------------------------------------------------------------------
// buildEffectiveAllowlist — provenance view for the Settings editor
// ---------------------------------------------------------------------------

describe("buildEffectiveAllowlist", () => {
  it("tags built-in defaults AND user hosts as removable (overridable defaults)", () => {
    const entries = buildEffectiveAllowlist({
      env: {},
      globalHosts: ["userg.example.com"],
      sessionHosts: ["users.example.com"],
    });
    const byHost = new Map(entries.map((e) => [e.host, e]));
    expect(byHost.get(".github.com")).toMatchObject({ source: "builtin", removable: true });
    expect(byHost.get("userg.example.com")).toMatchObject({ source: "user-global", removable: true });
    expect(byHost.get("users.example.com")).toMatchObject({ source: "user-session", removable: true });
  });

  it("skips a suppressed (user-removed) built-in default", () => {
    const all = buildEffectiveAllowlist({ env: {} });
    expect(all.some((e) => e.host === ".github.com")).toBe(true);
    const withSuppressed = buildEffectiveAllowlist({ env: {}, suppressedDefaults: [".github.com"] });
    expect(withSuppressed.some((e) => e.host === ".github.com")).toBe(false);
    // other defaults remain
    expect(withSuppressed.some((e) => e.host === ".anthropic.com")).toBe(true);
  });

  it("tags operator extras + MCP hosts read-only", () => {
    const store = stubStore({
      servers: { acme: { name: "acme", type: "http", url: "https://mcp.acme.dev/sse", enabled: true } },
    });
    const entries = buildEffectiveAllowlist({ env: { SESSION_EGRESS_ALLOWLIST: "ops.corp" }, credentialStore: store });
    expect(entries.find((e) => e.host === "ops.corp")).toMatchObject({ source: "operator", removable: false });
    expect(entries.find((e) => e.host === "mcp.acme.dev")).toMatchObject({ source: "mcp", removable: false });
  });

  it("keeps the most-fundamental classification on a collision (builtin wins over a user re-add)", () => {
    const entries = buildEffectiveAllowlist({ env: {}, globalHosts: [".github.com"] });
    const gh = entries.filter((e) => e.host === ".github.com");
    expect(gh).toHaveLength(1);
    expect(gh[0]).toMatchObject({ source: "builtin", removable: true });
  });
});

describe("isBuiltinDefault", () => {
  it("recognizes a built-in default (normalized), rejects others", () => {
    expect(isBuiltinDefault(".github.com")).toBe(true);
    expect(isBuiltinDefault(".GitHub.com.")).toBe(true); // case + trailing dot
    expect(isBuiltinDefault("attacker.com")).toBe(false);
    expect(isBuiltinDefault("api.github.com")).toBe(false); // not the exact default entry
  });
});

// ---------------------------------------------------------------------------
// composeEgressIdentityRules (Phase 2 — SNI-scoped tenant identity)
// ---------------------------------------------------------------------------

describe("composeEgressIdentityRules", () => {
  const env = (v?: string): NodeJS.ProcessEnv => ({ SESSION_EGRESS_IDENTITY_RULES: v } as NodeJS.ProcessEnv);

  it("returns '' when no rules are configured (env unset → proxy omits the var)", () => {
    expect(composeEgressIdentityRules({ env: {} as NodeJS.ProcessEnv })).toBe("");
    expect(composeEgressIdentityRules({ env: env("") })).toBe("");
    expect(composeEgressIdentityRules({ env: env("   ") })).toBe("");
  });

  it("parses the operator env into the proxy's canonical JSON shape", () => {
    const out = composeEgressIdentityRules({
      env: env('[{"host":".s3.amazonaws.com","identities":["my-bucket"]}]'),
    });
    expect(JSON.parse(out)).toEqual([{ host: ".s3.amazonaws.com", identities: ["my-bucket"] }]);
  });

  it("normalizes hosts and de-dupes identities; last rule per host wins", () => {
    const out = composeEgressIdentityRules({
      env: env(
        '[{"host":".S3.Amazonaws.com.","identities":["a","a","b"]},' +
          '{"host":".s3.amazonaws.com","identities":["c"]}]',
      ),
    });
    expect(JSON.parse(out)).toEqual([{ host: ".s3.amazonaws.com", identities: ["c"] }]);
  });

  it("drops entries with no host or no identities (additive hardening, fail-open)", () => {
    const out = composeEgressIdentityRules({
      env: env('[{"host":"","identities":["x"]},{"host":".s3.amazonaws.com","identities":[]}]'),
    });
    expect(out).toBe("");
  });

  it("fails open to '' on invalid JSON or a non-array, without throwing", () => {
    expect(composeEgressIdentityRules({ env: env("not json") })).toBe("");
    expect(composeEgressIdentityRules({ env: env('{"host":".s3.amazonaws.com"}') })).toBe("");
  });

  it("merges per-session durable rules after env rules (durable wins on host clash)", () => {
    const out = composeEgressIdentityRules({
      env: env('[{"host":".s3.amazonaws.com","identities":["env-bucket"]}]'),
      durableRules: [{ host: ".s3.amazonaws.com", identities: ["session-bucket"] }],
    });
    expect(JSON.parse(out)).toEqual([{ host: ".s3.amazonaws.com", identities: ["session-bucket"] }]);
  });
});
