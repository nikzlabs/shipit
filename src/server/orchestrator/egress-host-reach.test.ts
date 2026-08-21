/**
 * The one predicate: can this host be made reachable at all, and by whom?
 *
 * Three defects came out of docs/262 req 24's single demand that enforcement and
 * the Plugins card must not disagree, and each was a surface being optimistic
 * about a different thing — a compose file (planning#377), a session
 * (planning#380), a deployment (planning#383). The first two are covered where
 * they live (`plugin-services.test.ts`, and the sandbox cases below); this file
 * pins the shared question all of them are instances of, and the whole point is
 * that a new case is a new VERDICT here rather than a new special case
 * somewhere else.
 *
 * Every case answers from an egress input — the session's resolved config, the
 * allow-once policy, whether the session is contained, whether the deployment
 * installs a resolver at all — and never from a plugin manifest.
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
import { egressHostReach } from "./egress-host-reach.js";
import type { CredentialStore } from "./credential-store.js";

const stubCredentialStore = {
  getAllMcpServers: () => ({ notion: { type: "http", url: "https://mcp.notion.com/mcp" } }),
  getAllMcpOAuthTokens: () => ({}),
} as unknown as CredentialStore;

describe("egressHostReach", () => {
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

  const reach = (sessionId = "sess-a") =>
    egressHostReach({ contained: true, dnsControlDeployed: true, config: configFor(sessionId), sessionId });

  it("an Open session denies nothing, so no declared host is a gap", () => {
    // Reporting a gap where nothing is denied would send the user to grant
    // something that was never blocked. `isEgressContained` already folds in
    // whether the deployment enforces containment at all.
    expect(egressHostReach({ contained: false })("anything.example.com")).toBe("allowed");
  });

  it("a contained session allows what its configured allowlist covers, and nothing else", () => {
    const of = reach();
    // Built-in default, suffix form.
    expect(of("api.github.com")).toBe("allowed");
    // A live MCP server host — reachable, so a plugin declaring it is not blocked.
    expect(of("mcp.notion.com")).toBe("allowed");
    expect(of("fal.run")).toBe("grantable");
  });

  it("a user-added host — at either scope — closes the gap", () => {
    store.addHost(EGRESS_GLOBAL_SCOPE, "fal.run");
    store.addHost("sess-a", "cdn.example.com");
    const of = reach();
    expect(of("fal.run")).toBe("allowed");
    expect(of("cdn.example.com")).toBe("allowed");
    // Another session's extras are not this session's reach.
    expect(reach("sess-b")("cdn.example.com")).toBe("grantable");
  });

  it("honours a suffix entry and a suppressed built-in default", () => {
    store.addHost(EGRESS_GLOBAL_SCOPE, ".fal.run");
    store.suppressDefault(".github.com");
    const of = reach();
    expect(of("cdn.fal.run")).toBe("allowed");
    expect(of("fal.run")).toBe("allowed");
    // A default the user removed is genuinely not reachable, and the card must
    // say so rather than trusting the built-in list.
    expect(of("api.github.com")).toBe("grantable");
  });

  // The case that made "ask the seam, don't re-derive it" a correctness matter
  // rather than a tidiness one (review finding): a docs/211 Network-off sandbox
  // runs on the lifeline base with an EMPTY extras list, so a store-derived
  // answer would have reported npm, an MCP host and every user-added entry as
  // reachable in a session that can reach none of them.
  it("a Network-off sandbox is judged against its lifeline base, not the default one", () => {
    store.addHost(EGRESS_GLOBAL_SCOPE, "fal.run");
    const of = egressHostReach({
      contained: true,
      dnsControlDeployed: true,
      config: { contained: true, extraHosts: [], base: sandboxLifelineBase({ git: false }) },
      sessionId: "sess-a",
    });
    expect(of("api.anthropic.com")).toBe("allowed");
    expect(of("registry.npmjs.org")).not.toBe("allowed");
    expect(of("api.github.com")).not.toBe("allowed");
    // The user's own allowlist entry does not reach a session whose extras are
    // emptied — the store would have said otherwise.
    expect(of("fal.run")).not.toBe("allowed");
  });

  // planning#380 — the same sandbox, reached through the OTHER door. The config
  // composition above was already right; the allow-once fallback finished with
  // the durable-reconciled `isEgressHostAllowed` and let the store back in, so
  // the card said "allowed" for a host this session's resolver will never
  // resolve — while the grant-outcome report on the same card said the opposite.
  it("a durably-added host stays a gap in a Network-off sandbox — and no grant closes it", () => {
    store.addHost(EGRESS_GLOBAL_SCOPE, "fal.run");
    store.addHost("sess-a", "cdn.example.com");
    const sandbox: ResolvedEgressConfig = {
      contained: true,
      extraHosts: [],
      base: sandboxLifelineBase({ git: false }),
      userHostsExcluded: true,
    };
    const of = egressHostReach({ contained: true, dnsControlDeployed: true, config: sandbox, sessionId: "sess-a" });
    // Not merely "not allowed": the verdict has to say a grant is not the fix,
    // or the card offers two buttons that write inert entries.
    expect(of("fal.run")).toBe("blocked-by-session");
    expect(of("cdn.example.com")).toBe("blocked-by-session");
    // An ordinary contained session carries the same durable hosts in its own
    // resolved extras, so nothing is lost by refusing to read the store here.
    expect(reach()("fal.run")).toBe("allowed");
    expect(reach()("cdn.example.com")).toBe("allowed");
  });

  // The allow-once layer goes with it for such a session, which is docs/211's
  // own words: `network` off "only ever tightens", so a live decision may not
  // widen it either. The card and the container agree because
  // `pluginEgressPolicy` empties `allowOnceHosts` for the same config —
  // otherwise a plugin container would be the one surface that reaches what the
  // sealed session cannot.
  it("does not count an allow-once decision in a Network-off sandbox", () => {
    allowEgressHost("sess-a", "fal.run");
    const of = egressHostReach({
      contained: true,
      dnsControlDeployed: true,
      config: {
        contained: true,
        extraHosts: [],
        base: sandboxLifelineBase({ git: false }),
        userHostsExcluded: true,
      },
      sessionId: "sess-a",
    });
    expect(of("fal.run")).toBe("blocked-by-session");
    // The lifeline itself is untouched — this narrows nothing else.
    expect(of("api.anthropic.com")).toBe("allowed");
  });

  it("counts a host the user allowed on an inline card this session", () => {
    // That is the proxy's own answer for a host outside the static allowlist,
    // so a row claiming otherwise would offer to grant what is already granted.
    allowEgressHost("sess-a", "fal.run");
    expect(reach()("fal.run")).toBe("allowed");
    expect(reach("sess-b")("fal.run")).toBe("grantable");
  });

  it("fails closed on a contained session whose config cannot be resolved", () => {
    // The cost of being wrong this way is one redundant, idempotent grant; the
    // other way is a plugin that fails at runtime with the card saying nothing.
    // It fails to `grantable`, never to a `blocked-*`: an unknown is a gap the
    // user may try to close, not a claim that they cannot.
    const of = egressHostReach({ contained: true, dnsControlDeployed: true });
    expect(of("fal.run")).toBe("grantable");
    expect(of("api.github.com")).toBe("grantable");
  });

  it("counts a snapshotted allow-once set, and drops it in a sealed session", () => {
    // The form `plugin-egress.ts` uses: the set travels with the container
    // because its proxy cannot ask the decision endpoint.
    const ordinary = egressHostReach({
      contained: true,
      dnsControlDeployed: true,
      config: configFor("sess-a"),
      allowOnceHosts: ["once.example"],
    });
    expect(ordinary("once.example")).toBe("allowed");

    const sealed = egressHostReach({
      contained: true,
      dnsControlDeployed: true,
      config: {
        contained: true,
        extraHosts: [],
        base: sandboxLifelineBase({ git: false }),
        userHostsExcluded: true,
      },
      allowOnceHosts: ["once.example"],
    });
    expect(sealed("once.example")).toBe("blocked-by-session");
  });

  it("an empty host is never allowed", () => {
    expect(reach()("  ")).not.toBe("allowed");
  });

  /**
   * planning#383 — the deployment axis. `SESSION_EGRESS_DNS=0` leaves Tier A's
   * fixed IP floor as the WHOLE reach of every contained session: dnsmasq is
   * what pins a newly-resolved IP into the ipset, and with no resolver and no
   * proxy an allowlist entry acts on nothing. The card used to report against
   * the allowlist here and offer both grant buttons, either of which wrote a
   * durable entry that changed nothing at all.
   */
  describe("a deployment with no controlled resolver (SESSION_EGRESS_DNS=0)", () => {
    const floorOnly = (sessionId = "sess-a") =>
      egressHostReach({
        contained: true,
        dnsControlDeployed: false,
        config: configFor(sessionId),
        sessionId,
      });

    it("blocks a custom host by the DEPLOYMENT, not as a gap the user can close", () => {
      expect(floorOnly()("fal.run")).toBe("blocked-by-deployment");
    });

    it("keeps blocking it after the grant the card used to offer", () => {
      // The exact sequence the issue describes: both buttons write a durable
      // entry — one at either scope — and the host stays unreachable.
      store.addHost(EGRESS_GLOBAL_SCOPE, "fal.run");
      store.addHost("sess-a", "cdn.example.com");
      expect(floorOnly()("fal.run")).toBe("blocked-by-deployment");
      expect(floorOnly()("cdn.example.com")).toBe("blocked-by-deployment");
      // And it really is the deployment: the same store, the same session, on a
      // deployment that runs a resolver, reaches both.
      expect(reach()("fal.run")).toBe("allowed");
      expect(reach()("cdn.example.com")).toBe("allowed");
    });

    it("ignores an allow-once decision too — there is no proxy to honour it", () => {
      allowEgressHost("sess-a", "fal.run");
      expect(floorOnly()("fal.run")).toBe("blocked-by-deployment");
    });

    it("still reports the installer's own resolve list as reachable, because it is", () => {
      // The installer names these, resolves them in the netns and pins the
      // answers, so claiming they are blocked would be the same defect pointing
      // the other way — a gap named where there is none.
      expect(floorOnly()("api.anthropic.com")).toBe("allowed");
      expect(floorOnly()("registry.npmjs.org")).toBe("allowed");
    });

    it("claims nothing about the GitHub CIDR half, which a hostname cannot decide", () => {
      // Review finding, and the reason the exception is the resolve list alone:
      // Tier A's other half is IP ranges GitHub itself says are not exhaustive,
      // so a suffix mirror of them is wrong in BOTH directions — `cli.github.io`
      // sits inside `185.199.108.0/22` while
      // `pipelines.actions.githubusercontent.com` resolves outside every
      // published range. `blocked-by-deployment` is the honest verdict for both,
      // because its claim is about the GRANT, which is inert here either way.
      expect(floorOnly()("api.github.com")).toBe("blocked-by-deployment");
      expect(floorOnly()("pipelines.actions.githubusercontent.com")).toBe("blocked-by-deployment");
      // Hosts the Tier C default list carries and neither Tier A half admits.
      expect(floorOnly()("github-cloud.s3.amazonaws.com")).toBe("blocked-by-deployment");
      expect(floorOnly()("dl.google.com")).toBe("blocked-by-deployment");
    });

    it("says nothing about an Open session, which is denied nothing anyway", () => {
      expect(egressHostReach({ contained: false, dnsControlDeployed: false })("fal.run")).toBe("allowed");
    });

    it("outranks the session verdict where both hold — the wider fact is the one to state", () => {
      const of = egressHostReach({
        contained: true,
        dnsControlDeployed: false,
        config: {
          contained: true,
          extraHosts: [],
          base: sandboxLifelineBase({ git: false }),
          userHostsExcluded: true,
        },
        sessionId: "sess-a",
      });
      expect(of("fal.run")).toBe("blocked-by-deployment");
    });

    it("discards a snapshotted allow-once set too", () => {
      // `plugin-egress.ts` hands one in rather than a session id; it must pass
      // through the same gates as the live layer, or a plugin container becomes
      // the one surface claiming to reach what the netns denies.
      const of = egressHostReach({
        contained: true,
        dnsControlDeployed: false,
        config: configFor("sess-a"),
        allowOnceHosts: ["once.example"],
      });
      expect(of("once.example")).toBe("blocked-by-deployment");
    });

    it("is assumed present when a caller cannot say", () => {
      // A pure env read is never unknowable in production, and defaulting the
      // other way would tell every unwired test runtime that its deployment can
      // grant nothing.
      expect(egressHostReach({ contained: true, config: configFor("sess-a"), sessionId: "sess-a" })("fal.run")).toBe(
        "grantable",
      );
    });
  });
});
