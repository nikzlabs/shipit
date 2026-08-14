/**
 * docs/262 req 24 — what the session's egress configuration says about a
 * plugin's declared hosts.
 *
 * The requirement has two halves and this module must not blur them: a plugin
 * DECLARES the hosts it needs, and the declaration GRANTS NOTHING. So every
 * test here answers from an egress input — the effective allowlist, the
 * allow-once policy, whether the session is contained at all — and never from
 * the manifest.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { EgressAllowlistStore, EGRESS_GLOBAL_SCOPE } from "./egress-allowlist-store.js";
import { allowEgressHost, _resetEgressPolicies } from "./egress-policy.js";
import { pluginHostAllowance, pluginHostDeclarationsFor } from "./plugin-hosts.js";
import {
  parsePluginExports as parseExports,
  parsePluginRepos as parseRepos,
} from "../shared/plugin-repos.js";
import type { CredentialStore } from "./credential-store.js";

const parsePluginRepos = (raw: unknown) => parseRepos(raw, [], []);
const parsePluginExports = (raw: unknown) => parseExports(raw, []);

const stubCredentialStore = {
  getAllMcpServers: () => ({ notion: { type: "http", url: "https://mcp.notion.com/mcp" } }),
  getAllMcpOAuthTokens: () => ({}),
} as unknown as CredentialStore;

describe("pluginHostDeclarationsFor", () => {
  it("reads the LIVE manifest of each declared repository", () => {
    const plugins = parsePluginRepos({
      repos: [{ repo: "self", name: "dev" }],
      use: [{ plugin: "probe", from: "dev" }],
    });
    const selfExports = parsePluginExports({ plugins: { probe: { hosts: ["fal.run"] } } });
    // `repo: self` resolves against the project's own manifest (req 27), so no
    // generation is needed for this half.
    expect(pluginHostDeclarationsFor(plugins, selfExports, () => null)).toEqual([
      { repo: "dev", plugin: "probe", alias: "probe", hosts: ["fal.run"] },
    ]);
  });

  it("never throws — a card must describe a repository whose manifest it cannot read", () => {
    const plugins = parsePluginRepos({
      repos: [{ repo: "a/b", name: "tools", branch: "main" }],
      use: [{ plugin: "probe", from: "tools" }],
    });
    expect(
      pluginHostDeclarationsFor(plugins, [], () => {
        throw new Error("state dir went away mid-request");
      }),
    ).toEqual([]);
  });
});

describe("pluginHostAllowance", () => {
  let db: DatabaseManager;
  let store: EgressAllowlistStore;

  beforeEach(() => {
    db = new DatabaseManager(":memory:");
    store = new EgressAllowlistStore(db);
    _resetEgressPolicies();
  });

  afterEach(() => {
    _resetEgressPolicies();
    db.close();
  });

  const allowance = (over: Partial<Parameters<typeof pluginHostAllowance>[0]> = {}) =>
    pluginHostAllowance({
      store,
      credentialStore: stubCredentialStore,
      sessionId: "sess-a",
      contained: true,
      ...over,
    });

  it("an Open session denies nothing, so no declared host is a gap", () => {
    // Reporting "not allowed" where nothing is denied would send the user to
    // grant something that was never blocked. `isEgressContained` already folds
    // in whether the deployment enforces containment at all.
    expect(allowance({ contained: false })("anything.example.com")).toBe(true);
  });

  it("a contained session allows what its effective allowlist covers, and nothing else", () => {
    const isAllowed = allowance();
    // Built-in default, suffix form.
    expect(isAllowed("api.github.com")).toBe(true);
    // A live MCP server host — reachable, so a plugin declaring it is not blocked.
    expect(isAllowed("mcp.notion.com")).toBe(true);
    expect(isAllowed("fal.run")).toBe(false);
  });

  it("a user-added host — at either scope — closes the gap", () => {
    store.addHost(EGRESS_GLOBAL_SCOPE, "fal.run");
    store.addHost("sess-a", "cdn.example.com");
    const isAllowed = allowance();
    expect(isAllowed("fal.run")).toBe(true);
    expect(isAllowed("cdn.example.com")).toBe(true);
    // Another session's extras are not this session's reach.
    expect(allowance({ sessionId: "sess-b" })("cdn.example.com")).toBe(false);
  });

  it("honours a suffix entry and a suppressed built-in default", () => {
    store.addHost(EGRESS_GLOBAL_SCOPE, ".fal.run");
    store.suppressDefault(".github.com");
    const isAllowed = allowance();
    expect(isAllowed("cdn.fal.run")).toBe(true);
    expect(isAllowed("fal.run")).toBe(true);
    // A default the user removed is genuinely not reachable, and the card must
    // say so rather than trusting the built-in list.
    expect(isAllowed("api.github.com")).toBe(false);
  });

  it("counts a host the user allowed on an inline card this session", () => {
    // That is the proxy's own answer for a host outside the static allowlist,
    // so a row claiming otherwise would offer to grant what is already granted.
    allowEgressHost("sess-a", "fal.run");
    expect(allowance()("fal.run")).toBe(true);
    expect(allowance({ sessionId: "sess-b" })("fal.run")).toBe(false);
  });

  it("fails closed with no store and no session — 'not knowable' shows the gap", () => {
    // The cost of being wrong this way is one redundant, idempotent grant; the
    // other way is a plugin that fails at runtime with the card saying nothing.
    const isAllowed = pluginHostAllowance({ contained: true });
    expect(isAllowed("fal.run")).toBe(false);
    // The built-in base is still knowable without a store.
    expect(isAllowed("api.github.com")).toBe(true);
  });

  it("an empty host is never allowed", () => {
    expect(allowance()("  ")).toBe(false);
  });
});
