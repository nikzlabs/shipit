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
    // Keep the durable source wired to detect accidental bypass of the resolved sandbox policy.
    setEgressDurableSource((sessionId) => store.effectiveHosts(sessionId));
  });

  afterEach(() => {
    _resetEgressPolicies();
    setEgressDurableSource(null);
    db.close();
  });

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
    expect(egressHostReach({ contained: false })("anything.example.com")).toBe("allowed");
  });

  it("a contained session allows what its configured allowlist covers, and nothing else", () => {
    const of = reach();
    expect(of("api.github.com")).toBe("allowed");
    expect(of("mcp.notion.com")).toBe("allowed");
    expect(of("fal.run")).toBe("grantable");
  });

  it("a user-added host — at either scope — closes the gap", () => {
    store.addHost(EGRESS_GLOBAL_SCOPE, "fal.run");
    store.addHost("sess-a", "cdn.example.com");
    const of = reach();
    expect(of("fal.run")).toBe("allowed");
    expect(of("cdn.example.com")).toBe("allowed");
    expect(reach("sess-b")("cdn.example.com")).toBe("grantable");
  });

  it("honours a suffix entry and a suppressed built-in default", () => {
    store.addHost(EGRESS_GLOBAL_SCOPE, ".fal.run");
    store.suppressDefault(".github.com");
    const of = reach();
    expect(of("cdn.fal.run")).toBe("allowed");
    expect(of("fal.run")).toBe("allowed");
    expect(of("api.github.com")).toBe("grantable");
  });

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
    expect(of("fal.run")).not.toBe("allowed");
  });

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
    expect(of("fal.run")).toBe("blocked-by-session");
    expect(of("cdn.example.com")).toBe("blocked-by-session");
    expect(reach()("fal.run")).toBe("allowed");
    expect(reach()("cdn.example.com")).toBe("allowed");
  });

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
    expect(of("api.anthropic.com")).toBe("allowed");
  });

  it("counts a host the user allowed on an inline card this session", () => {
    allowEgressHost("sess-a", "fal.run");
    expect(reach()("fal.run")).toBe("allowed");
    expect(reach("sess-b")("fal.run")).toBe("grantable");
  });

  it("fails closed on a contained session whose config cannot be resolved", () => {
    const of = egressHostReach({ contained: true, dnsControlDeployed: true });
    expect(of("fal.run")).toBe("grantable");
    expect(of("api.github.com")).toBe("grantable");
  });

  it("counts a snapshotted allow-once set, and drops it in a sealed session", () => {
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
      store.addHost(EGRESS_GLOBAL_SCOPE, "fal.run");
      store.addHost("sess-a", "cdn.example.com");
      expect(floorOnly()("fal.run")).toBe("blocked-by-deployment");
      expect(floorOnly()("cdn.example.com")).toBe("blocked-by-deployment");
      expect(reach()("fal.run")).toBe("allowed");
      expect(reach()("cdn.example.com")).toBe("allowed");
    });

    it("ignores an allow-once decision too — there is no proxy to honour it", () => {
      allowEgressHost("sess-a", "fal.run");
      expect(floorOnly()("fal.run")).toBe("blocked-by-deployment");
    });

    it("still reports the installer's own resolve list as reachable, because it is", () => {
      expect(floorOnly()("api.anthropic.com")).toBe("allowed");
      expect(floorOnly()("registry.npmjs.org")).toBe("allowed");
    });

    it("claims nothing about the GitHub CIDR half, which a hostname cannot decide", () => {
      expect(floorOnly()("api.github.com")).toBe("blocked-by-deployment");
      expect(floorOnly()("pipelines.actions.githubusercontent.com")).toBe("blocked-by-deployment");
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
      const of = egressHostReach({
        contained: true,
        dnsControlDeployed: false,
        config: configFor("sess-a"),
        allowOnceHosts: ["once.example"],
      });
      expect(of("once.example")).toBe("blocked-by-deployment");
    });

    it("is assumed present when a caller cannot say", () => {
      expect(egressHostReach({ contained: true, config: configFor("sess-a"), sessionId: "sess-a" })("fal.run")).toBe(
        "grantable",
      );
    });
  });
});
