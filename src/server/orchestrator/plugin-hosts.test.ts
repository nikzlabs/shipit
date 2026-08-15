/**
 * docs/262 req 24 — what the session's egress configuration says about a
 * plugin's declared hosts.
 *
 * The requirement has two halves and this module must not blur them: a plugin
 * DECLARES the hosts it needs, and the declaration GRANTS NOTHING. So every
 * test here answers from an egress input — the session's resolved config, the
 * allow-once policy, whether the session is contained at all — and never from
 * the manifest.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { EgressAllowlistStore, EGRESS_GLOBAL_SCOPE } from "./egress-allowlist-store.js";
import { allowEgressHost, _resetEgressPolicies, setEgressDurableSource } from "./egress-policy.js";
import {
  composeEgressExtraHosts,
  sandboxLifelineBase,
  type ResolvedEgressConfig,
} from "./egress-allowlist.js";
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
    // Exactly `index.ts`'s injection. Wired here because leaving it null is what
    // let the sandbox case below pass while production still reported a durable
    // host as allowed there (planning#380): the durable store reached the
    // predicate through `isEgressHostAllowed`, which this fixture had disabled.
    setEgressDurableSource((sessionId) => store.effectiveHosts(sessionId));
  });

  afterEach(() => {
    _resetEgressPolicies();
    setEgressDurableSource(null);
    db.close();
  });

  /**
   * The session's config, built exactly as `index.ts`'s `resolveEgressConfig`
   * builds it — the seam `ContainerSessionManager.resolveEgress` hands to this
   * predicate. Built here rather than stubbed so a change to that composition
   * shows up as a failure rather than as a fixture that quietly disagrees.
   */
  const configFor = (sessionId: string): ResolvedEgressConfig => ({
    contained: store.resolveContained(sessionId),
    extraHosts: composeEgressExtraHosts({
      env: {},
      credentialStore: stubCredentialStore,
      durableHosts: store.effectiveHosts(sessionId),
    }),
    base: store.effectiveBase(),
  });

  const allowance = (sessionId = "sess-a") =>
    pluginHostAllowance({ contained: true, config: configFor(sessionId), sessionId });

  it("an Open session denies nothing, so no declared host is a gap", () => {
    // Reporting "not allowed" where nothing is denied would send the user to
    // grant something that was never blocked. `isEgressContained` already folds
    // in whether the deployment enforces containment at all.
    expect(pluginHostAllowance({ contained: false })("anything.example.com")).toBe(true);
  });

  it("a contained session allows what its configured allowlist covers, and nothing else", () => {
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
    expect(allowance("sess-b")("cdn.example.com")).toBe(false);
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

  // The case that made "ask the seam, don't re-derive it" a correctness matter
  // rather than a tidiness one (review finding): a docs/211 Network-off sandbox
  // runs on the lifeline base with an EMPTY extras list, so a store-derived
  // answer would have reported npm, an MCP host and every user-added entry as
  // reachable in a session that can reach none of them.
  it("a Network-off sandbox is judged against its lifeline base, not the default one", () => {
    store.addHost(EGRESS_GLOBAL_SCOPE, "fal.run");
    const isAllowed = pluginHostAllowance({
      contained: true,
      config: { contained: true, extraHosts: [], base: sandboxLifelineBase({ git: false }) },
      sessionId: "sess-a",
    });
    expect(isAllowed("api.anthropic.com")).toBe(true);
    expect(isAllowed("registry.npmjs.org")).toBe(false);
    expect(isAllowed("api.github.com")).toBe(false);
    // The user's own allowlist entry does not reach a session whose extras are
    // emptied — the store would have said otherwise.
    expect(isAllowed("fal.run")).toBe(false);
  });

  // planning#380 — the same sandbox, reached through the OTHER door. The config
  // composition above was already right; the allow-once fallback finished with
  // the durable-reconciled `isEgressHostAllowed` and let the store back in, so
  // the card said "allowed" for a host this session's resolver will never
  // resolve — while the grant-outcome report on the same card said the opposite.
  it("a durably-added host stays a gap in a Network-off sandbox", () => {
    store.addHost(EGRESS_GLOBAL_SCOPE, "fal.run");
    store.addHost("sess-a", "cdn.example.com");
    const sandbox: ResolvedEgressConfig = {
      contained: true,
      extraHosts: [],
      base: sandboxLifelineBase({ git: false }),
    };
    const isAllowed = pluginHostAllowance({ contained: true, config: sandbox, sessionId: "sess-a" });
    expect(isAllowed("fal.run")).toBe(false);
    expect(isAllowed("cdn.example.com")).toBe(false);
    // An ordinary contained session carries the same durable hosts in its own
    // resolved extras, so nothing is lost by refusing to read the store here.
    expect(allowance()("fal.run")).toBe(true);
    expect(allowance()("cdn.example.com")).toBe(true);
  });

  // The allow-once layer is kept for the sandbox, because it is snapshotted into
  // the static allowlist of every plugin container the session launches
  // (`plugin-egress.ts`) — so it IS reachable there, unlike a durable entry.
  it("counts an allow-once decision even in a Network-off sandbox", () => {
    allowEgressHost("sess-a", "fal.run");
    const isAllowed = pluginHostAllowance({
      contained: true,
      config: { contained: true, extraHosts: [], base: sandboxLifelineBase({ git: false }) },
      sessionId: "sess-a",
    });
    expect(isAllowed("fal.run")).toBe(true);
  });

  it("counts a host the user allowed on an inline card this session", () => {
    // That is the proxy's own answer for a host outside the static allowlist,
    // so a row claiming otherwise would offer to grant what is already granted.
    allowEgressHost("sess-a", "fal.run");
    expect(allowance()("fal.run")).toBe(true);
    expect(allowance("sess-b")("fal.run")).toBe(false);
  });

  it("fails closed on a contained session whose config cannot be resolved", () => {
    // The cost of being wrong this way is one redundant, idempotent grant; the
    // other way is a plugin that fails at runtime with the card saying nothing.
    const isAllowed = pluginHostAllowance({ contained: true });
    expect(isAllowed("fal.run")).toBe(false);
    expect(isAllowed("api.github.com")).toBe(false);
  });

  it("an empty host is never allowed", () => {
    expect(allowance()("  ")).toBe(false);
  });
});
