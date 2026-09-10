import { describe, it, expect } from "vitest";
import {
  desiredSpawnIdentity,
  envRouteIdFor,
  firstEligibleSelectionForHarness,
  listConfiguredCredentials,
  residentRouteNeedsRelease,
  selectRouteForSelection,
  serviceRoutingForSelection,
  sessionSpawnIdentity,
} from "./service-routing.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "./credential-store.js";
import { ProviderAccountManager } from "./provider-account-manager.js";
import type { CredentialRoute } from "../shared/types/domain-types/credential-route.js";
import type { AccountSelectionMode } from "../shared/types/domain-types/provider.js";
import type { AccountSelection } from "./provider-account-manager.js";
import type { SessionInfo } from "../shared/types.js";

function route(over: Partial<CredentialRoute> & Pick<CredentialRoute, "id" | "serviceId">): CredentialRoute {
  return {
    billingMode: "key",
    via: "string",
    label: over.id,
    isPrimary: false,
    status: "ready",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as CredentialRoute;
}

function store(
  routes: CredentialRoute[],
  secrets: Record<string, string> = {},
  selectionMode: AccountSelectionMode = "strict",
  cutoffs: { session: number; weekly: number } = { session: 90, weekly: 90 },
) {
  return {
    listCredentialRoutes: (serviceId?: string, billingMode?: string) =>
      routes.filter(
        (r) =>
          (serviceId === undefined || r.serviceId === serviceId)
          && (billingMode === undefined || r.billingMode === billingMode),
      ),
    getCredentialSecret: (id: string) => secrets[id],
    getSelectionMode: () => selectionMode,
    getCredentialRoute: (id: string) => routes.find((r) => r.id === id),
    getFailoverCutoffs: () => cutoffs,
  };
}

describe("listConfiguredCredentials", () => {
  it("reads the store AND the deployment's own environment", () => {
    const credentials = listConfiguredCredentials(
      store([route({ id: "cred_1", serviceId: "deepseek" })], { cred_1: "sk-ds" }),
      { ANTHROPIC_API_KEY: "sk-ant" } as NodeJS.ProcessEnv,
    );
    expect(credentials).toContainEqual({ serviceId: "deepseek", billingMode: "key", via: "string" });
    expect(credentials).toContainEqual({ serviceId: "anthropic", billingMode: "key", via: "string" });
  });

  it("ignores a string route with no secret behind it", () => {
    const credentials = listConfiguredCredentials(
      store([route({ id: "cred_1", serviceId: "deepseek" })]),
      {} as NodeJS.ProcessEnv,
    );
    expect(credentials).toEqual([]);
  });

  it("counts an account route without asking for a secret", () => {
    const credentials = listConfiguredCredentials(
      store([route({ id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account" })]),
      {} as NodeJS.ProcessEnv,
    );
    expect(credentials).toEqual([{ serviceId: "anthropic", billingMode: "sub", via: "account" }]);
  });

  it("ignores an account whose login never finished", () => {
    const credentials = listConfiguredCredentials(
      store([
        route({
          id: "acct_1",
          serviceId: "anthropic",
          billingMode: "sub",
          via: "account",
          status: "unavailable",
        }),
      ]),
      {} as NodeJS.ProcessEnv,
    );
    expect(credentials).toEqual([]);
  });
});

describe("firstEligibleSelectionForHarness", () => {
  it("picks a credentialed service over the harness's own vendor", () => {
    const selection = firstEligibleSelectionForHarness("claude", {
      credentialStore: store([route({ id: "cred_1", serviceId: "deepseek" })], { cred_1: "sk-ds" }),
      env: {} as NodeJS.ProcessEnv,
    });
    expect(selection).toEqual({
      serviceId: "deepseek",
      billingMode: "key",
      modelId: "deepseek-flash",
    });
  });

  it("still prefers the harness's own vendor when the install has a credential for it", () => {
    const selection = firstEligibleSelectionForHarness("claude", {
      credentialStore: store([
        route({ id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account" }),
        route({ id: "cred_1", serviceId: "deepseek" }),
      ], { cred_1: "sk-ds" }),
      env: {} as NodeJS.ProcessEnv,
    });
    expect(selection).toEqual({
      serviceId: "anthropic",
      billingMode: "sub",
      modelId: "claude-opus-5",
    });
  });

  it("reads a deployment-supplied key from the environment, like eligibility does", () => {
    const selection = firstEligibleSelectionForHarness("claude", {
      credentialStore: store([]),
      env: { ZAI_CODING_PLAN_KEY: "glm" } as unknown as NodeJS.ProcessEnv,
    });
    expect(selection?.serviceId).toBe("zai");
    expect(selection?.billingMode).toBe("sub");
  });

  it("walks past a mode with no credential to the next one that has one", () => {
    const selection = firstEligibleSelectionForHarness("claude", {
      credentialStore: store([route({ id: "cred_1", serviceId: "anthropic", billingMode: "key" })], {
        cred_1: "sk-ant",
      }),
      env: {} as NodeJS.ProcessEnv,
    });
    expect(selection).toEqual({
      serviceId: "anthropic",
      billingMode: "key",
      modelId: "claude-opus-5",
    });
  });

  it("is undefined when the install has nothing at all", () => {
    expect(
      firstEligibleSelectionForHarness("claude", {
        credentialStore: store([]),
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toBeUndefined();
  });

  it("is undefined when nothing eligible speaks a style this harness has", () => {
    expect(
      firstEligibleSelectionForHarness("codex", {
        credentialStore: store([route({ id: "cred_1", serviceId: "zai" })], { cred_1: "sk-zai" }),
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toBeUndefined();
  });
});

describe("selectRouteForSelection — scoped to the SELECTED billing mode", () => {
  const anthropicAccount: AccountSelection = { ok: true, route: { kind: "account", id: "acct_1" } };
  const noAccount: AccountSelection = { ok: false, reason: "auth_required" };

  it("takes the account walk's answer for an account-delivered subscription", () => {
    const selected = selectRouteForSelection(
      "claude",
      { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" },
      {
        credentialStore: store([]),
        providerAccountManager: { selectAccountForTurn: () => anthropicAccount, subscriptionLimitsFor: () => ({}) },
      },
    );
    expect(selected).toEqual(anthropicAccount);
  });

  it("refuses a stale account selection whose model style the harness cannot carry", () => {
    const asked: string[] = [];
    selectRouteForSelection(
      "codex",
      { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" },
      {
        credentialStore: store([]),
        providerAccountManager: {
          subscriptionLimitsFor: () => ({}),
          selectAccountForTurn: (serviceId: string) => {
            asked.push(serviceId);
            return anthropicAccount;
          },
        },
      },
    );
    expect(asked).toEqual([]);
  });

  it("falls back to the harness's own vendor when there is no selection", () => {
    const asked: string[] = [];
    selectRouteForSelection("codex", undefined, {
      credentialStore: store([]),
      providerAccountManager: {
        subscriptionLimitsFor: () => ({}),
        selectAccountForTurn: (serviceId: string) => {
          asked.push(serviceId);
          return noAccount;
        },
      },
    });
    expect(asked).toEqual(["openai"]);
  });

  it("never hands an `anthropic:sub` selection the metered key route", () => {
    const selected = selectRouteForSelection(
      "claude",
      { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" },
      {
        credentialStore: store([]),
        providerAccountManager: {
          selectAccountForTurn: () => ({ ok: true, route: { kind: "reserved", id: "claude-api-key" } }),
          subscriptionLimitsFor: () => ({}),
        },
        env: { ANTHROPIC_API_KEY: "sk-ant" } as NodeJS.ProcessEnv,
      },
    );
    expect(selected).toEqual({ ok: false, reason: "auth_required" });
  });

  it("still reaches `anthropic:sub`'s OWN env-delivered token", () => {
    const selected = selectRouteForSelection(
      "claude",
      { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" },
      {
        credentialStore: store([]),
        providerAccountManager: { selectAccountForTurn: () => noAccount, subscriptionLimitsFor: () => ({}) },
        env: { ANTHROPIC_AUTH_TOKEN: "tok" } as NodeJS.ProcessEnv,
      },
    );
    expect(selected).toEqual({ ok: true, route: { kind: "reserved", id: "claude-env-oauth" } });
  });

  it("returns `all_exhausted` unchanged rather than falling to the same mode's key", () => {
    const exhausted: AccountSelection = {
      ok: false,
      reason: "all_exhausted",
      earliestResetAt: "2026-01-01T00:00:00.000Z",
    };
    const selected = selectRouteForSelection(
      "claude",
      { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" },
      {
        credentialStore: store([]),
        providerAccountManager: { selectAccountForTurn: () => exhausted, subscriptionLimitsFor: () => ({}) },
        env: { ANTHROPIC_AUTH_TOKEN: "tok" } as NodeJS.ProcessEnv,
      },
    );
    expect(selected).toEqual(exhausted);
  });

  it("resolves a custom service to its own stored credential, not to an account", () => {
    const selected = selectRouteForSelection(
      "claude",
      { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-flash" },
      {
        credentialStore: store([route({ id: "cred_ds", serviceId: "deepseek" })], { cred_ds: "sk" }),
        providerAccountManager: { selectAccountForTurn: () => anthropicAccount, subscriptionLimitsFor: () => ({}) },
      },
    );
    expect(selected).toEqual({ ok: true, route: { kind: "reserved", id: "cred_ds" } });
  });

  it("keeps the pre-feature question for a session with no selection", () => {
    const selected = selectRouteForSelection("claude", undefined, {
      credentialStore: store([]),
      providerAccountManager: { selectAccountForTurn: () => anthropicAccount, subscriptionLimitsFor: () => ({}) },
    });
    expect(selected).toEqual(anthropicAccount);
  });
});

describe("string-delivered subscription failover", () => {
  const NOW = 1_000_000;
  const glm = { serviceId: "zai", billingMode: "sub", modelId: "glm-5.2[1m]" } as const;
  const sub = (id: string, over: Partial<CredentialRoute> = {}): CredentialRoute =>
    route({ id, serviceId: "zai", billingMode: "sub", priority: 0, ...over });

  const pick = (
    routes: CredentialRoute[],
    secrets: Record<string, string>,
    selectionMode: AccountSelectionMode = "strict",
  ) =>
    selectRouteForSelection("claude", glm, {
      credentialStore: store(routes, secrets, selectionMode),
      env: {} as NodeJS.ProcessEnv,
      now: () => NOW,
    });

  describe("quota tiers, the same three the account walk has", () => {
    const anthropic = { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" } as const;
    const tok = (id: string, over: Partial<CredentialRoute> = {}): CredentialRoute =>
      route({ id, serviceId: "anthropic", billingMode: "sub", priority: 0, ...over });
    const window = (usedPct: number) => ({
      usedPct,
      resetAt: new Date(NOW + 3_600_000).toISOString(),
      source: "usage-api" as const,
    });
    const pickAnthropic = (
      routes: CredentialRoute[],
      limits: Record<string, unknown>,
      cutoffs = { session: 90, weekly: 90 },
    ) =>
      selectRouteForSelection("claude", anthropic, {
        credentialStore: store(routes, { tok_a: "k1", tok_b: "k2" }, "strict", cutoffs),
        providerAccountManager: {
          selectAccountForTurn: () => ({ ok: false, reason: "auth_required" }) as never,
          subscriptionLimitsFor: () => limits as never,
        },
        env: {} as NodeJS.ProcessEnv,
        now: () => NOW,
      });

    it("passes over a credential above the user's cutoff", () => {
      const selected = pickAnthropic(
        [tok("tok_a", { priority: 0 }), tok("tok_b", { priority: 1 })],
        { tok_a: { session: window(95), weekly: window(10) } },
      );
      expect(selected).toEqual({ ok: true, route: { kind: "reserved", id: "tok_b" } });
    });

    it("respects the user's own cutoff, not a fixed one", () => {
      const routes = [tok("tok_a", { priority: 0 }), tok("tok_b", { priority: 1 })];
      const limits = { tok_a: { session: window(60), weekly: window(10) } };
      expect(pickAnthropic(routes, limits))
        .toEqual({ ok: true, route: { kind: "reserved", id: "tok_a" } });
      expect(pickAnthropic(routes, limits, { session: 50, weekly: 90 }))
        .toEqual({ ok: true, route: { kind: "reserved", id: "tok_b" } });
    });

    it("still uses a credential over its cutoff when it is the only one left", () => {
      const selected = pickAnthropic(
        [tok("tok_a", { priority: 0 })],
        { tok_a: { session: window(99), weekly: window(99) } },
      );
      expect(selected).toEqual({ ok: true, route: { kind: "reserved", id: "tok_a" } });
    });

    it("orders a spent credential behind one merely over its cutoff", () => {
      const selected = pickAnthropic(
        [tok("tok_a", { priority: 0 }), tok("tok_b", { priority: 1 })],
        {
          tok_a: { session: window(100), weekly: window(10) },
          tok_b: { session: window(95), weekly: window(10) },
        },
      );
      expect(selected).toEqual({ ok: true, route: { kind: "reserved", id: "tok_b" } });
    });

    it("has no opinion when nothing reports a quota — planning#339 untouched", () => {
      const selected = pickAnthropic(
        [tok("tok_a", { priority: 0 }), tok("tok_b", { priority: 1 })],
        {},
      );
      expect(selected).toEqual({ ok: true, route: { kind: "reserved", id: "tok_a" } });
    });
  });

  it("moves to the next credential when the first is benched", () => {
    const selected = pick(
      [
        sub("cred_a", { priority: 0, exhaustedUntil: NOW + 60_000, exhaustedAt: NOW - 1_000 }),
        sub("cred_b", { priority: 1 }),
      ],
      { cred_a: "k1", cred_b: "k2" },
    );
    expect(selected).toEqual({ ok: true, route: { kind: "reserved", id: "cred_b" } });
  });

  it("stops with `all_exhausted` and the earliest reset when every one is benched", () => {
    const selected = pick(
      [
        sub("cred_a", { priority: 0, exhaustedUntil: NOW + 90_000, exhaustedAt: NOW - 1_000 }),
        sub("cred_b", { priority: 1, exhaustedUntil: NOW + 30_000, exhaustedAt: NOW - 1_000 }),
      ],
      { cred_a: "k1", cred_b: "k2" },
    );
    expect(selected).toEqual({
      ok: false,
      reason: "all_exhausted",
      earliestResetAt: new Date(NOW + 30_000).toISOString(),
    });
  });

  it("does not roll onto the deployment's env credential when the stored ones are spent", () => {
    const selected = selectRouteForSelection("claude", glm, {
      credentialStore: store([sub("cred_a", { exhaustedUntil: NOW + 60_000, exhaustedAt: NOW - 1_000 })], { cred_a: "k1" }),
      env: { ZAI_CODING_PLAN_KEY: "from-env" } as NodeJS.ProcessEnv,
      now: () => NOW,
    });
    expect(selected).toMatchObject({ ok: false, reason: "all_exhausted" });
  });

  it("takes the least recently used credential under `balanced`", () => {
    const selected = pick(
      [
        sub("cred_a", { priority: 0, lastUsedAt: 900 }),
        sub("cred_b", { priority: 1, lastUsedAt: 100 }),
      ],
      { cred_a: "k1", cred_b: "k2" },
      "balanced",
    );
    expect(selected).toEqual({ ok: true, route: { kind: "reserved", id: "cred_b" } });
  });

  it("`balanced` keeps a session on its resident string credential (req 8)", () => {
    const routes = [
      sub("cred_a", { priority: 0, lastUsedAt: 900 }),
      sub("cred_b", { priority: 1, lastUsedAt: 100 }),
    ];
    const selected = selectRouteForSelection("claude", glm, {
      credentialStore: store(routes, { cred_a: "k1", cred_b: "k2" }, "balanced"),
      env: {} as NodeJS.ProcessEnv,
      now: () => NOW,
    }, { residentRouteId: "cred_a" });
    expect(selected).toEqual({ ok: true, route: { kind: "reserved", id: "cred_a" } });
  });

  it("`balanced` abandons a refusal-blocked resident string credential", () => {
    const routes = [
      sub("cred_a", { priority: 0, lastUsedAt: 900, exhaustedUntil: NOW + 60_000, exhaustedAt: NOW - 1_000 }),
      sub("cred_b", { priority: 1, lastUsedAt: 100 }),
    ];
    const selected = selectRouteForSelection("claude", glm, {
      credentialStore: store(routes, { cred_a: "k1", cred_b: "k2" }, "balanced"),
      env: {} as NodeJS.ProcessEnv,
      now: () => NOW,
    }, { residentRouteId: "cred_a" });
    expect(selected).toEqual({ ok: true, route: { kind: "reserved", id: "cred_b" } });
  });

  it("`strict` ignores the resident string credential — the strategy is absolute", () => {
    const routes = [
      sub("cred_a", { priority: 0 }),
      sub("cred_b", { priority: 1 }),
    ];
    const selected = selectRouteForSelection("claude", glm, {
      credentialStore: store(routes, { cred_a: "k1", cred_b: "k2" }, "strict"),
      env: {} as NodeJS.ProcessEnv,
      now: () => NOW,
    }, { residentRouteId: "cred_b" });
    expect(selected).toEqual({ ok: true, route: { kind: "reserved", id: "cred_a" } });
  });

  it("ignores a lapsed bench", () => {
    const selected = pick(
      [sub("cred_a", { priority: 0, exhaustedUntil: NOW - 1 }), sub("cred_b", { priority: 1 })],
      { cred_a: "k1", cred_b: "k2" },
    );
    expect(selected).toEqual({ ok: true, route: { kind: "reserved", id: "cred_a" } });
  });

  it("never skips a benched API KEY — a key has no window and does not fail over", () => {
    const selected = selectRouteForSelection(
      "claude",
      { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-flash" },
      {
        credentialStore: store(
          [
            route({ id: "cred_a", serviceId: "deepseek", priority: 0, exhaustedUntil: NOW + 60_000, exhaustedAt: NOW - 1_000 }),
            route({ id: "cred_b", serviceId: "deepseek", priority: 1 }),
          ],
          { cred_a: "k1", cred_b: "k2" },
        ),
        env: {} as NodeJS.ProcessEnv,
        now: () => NOW,
      },
    );
    expect(selected).toEqual({ ok: true, route: { kind: "reserved", id: "cred_a" } });
  });
});

describe("envRouteIdFor", () => {
  it("keeps ShipIt's historical ids so pinned sessions are not orphaned", () => {
    expect(envRouteIdFor("ANTHROPIC_AUTH_TOKEN")).toBe("claude-env-oauth");
    expect(envRouteIdFor("ANTHROPIC_API_KEY")).toBe("claude-api-key");
    expect(envRouteIdFor("OPENAI_API_KEY")).toBe("codex-api-key");
    expect(envRouteIdFor("DEEPSEEK_API_KEY")).toBe("env:DEEPSEEK_API_KEY");
  });
});

const storeHolding = (...ids: string[]) => ({
  getCredentialRoute: (id: string) =>
    (ids.includes(id) ? ({ id } as unknown as CredentialRoute) : undefined),
});

describe("serviceRoutingForSelection", () => {
  it("shapes a string-delivered credential", () => {
    const routing = serviceRoutingForSelection(
      "claude",
      { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-flash" },
      { kind: "reserved", id: "cred_ds" },
      storeHolding("cred_ds"),
    );
    expect(routing).toMatchObject({
      serviceId: "deepseek",
      serviceName: "DeepSeek",
      billingMode: "key",
      style: "anthropic-messages",
      baseUrl: "https://api.deepseek.com/anthropic",
      credentialSourceEnv: "SHIPIT_CREDENTIAL_CRED_DS",
      credentialTarget: { kind: "env", name: "ANTHROPIC_API_KEY" },
    });
  });

  it("sources an ADOPTED credential from its own variable, legacy id and all", () => {
    expect(
      serviceRoutingForSelection(
        "claude",
        { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-flash" },
        { kind: "reserved", id: "claude-api-key" },
        storeHolding("claude-api-key"),
      ),
    ).toMatchObject({ credentialSourceEnv: "SHIPIT_CREDENTIAL_CLAUDE_API_KEY" });
  });

  it("keeps the mode's group variable for an ENV-delivered credential", () => {
    expect(
      serviceRoutingForSelection(
        "claude",
        { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-flash" },
        { kind: "reserved", id: "env:DEEPSEEK_API_KEY" },
        storeHolding(),
      ),
    ).toMatchObject({ credentialSourceEnv: "DEEPSEEK_API_KEY" });
  });

  it("leaves an account-delivered credential alone", () => {
    expect(
      serviceRoutingForSelection(
        "claude",
        { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" },
        { kind: "account", id: "acct_1" },
        storeHolding(),
      ),
    ).toBeUndefined();
  });

  it("delivers an env-supplied subscription token as a bearer token, not an x-api-key (planning#354)", () => {
    expect(
      serviceRoutingForSelection(
        "claude",
        { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" },
        { kind: "reserved", id: "claude-env-oauth" },
        storeHolding(),
      ),
    ).toMatchObject({
      serviceId: "anthropic",
      billingMode: "sub",
      credentialSourceEnv: "ANTHROPIC_AUTH_TOKEN",
      credentialTarget: { kind: "env", name: "ANTHROPIC_AUTH_TOKEN" },
    });
  });

  it("has nothing to shape for a session with no selection", () => {
    expect(serviceRoutingForSelection("claude", undefined, null, storeHolding())).toBeUndefined();
  });

  it("does not shape an account-capable mode on a guess when no route is resolved", () => {
    expect(
      serviceRoutingForSelection(
        "claude",
        { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" },
        undefined,
        storeHolding(),
      ),
    ).toBeUndefined();
  });

  it("still shapes a string-only mode with no route resolved", () => {
    expect(
      serviceRoutingForSelection(
        "claude",
        { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-flash" },
        undefined,
        storeHolding(),
      ),
    ).toMatchObject({ serviceId: "deepseek" });
  });
});

describe("sessionSpawnIdentity — the resident-process boundary", () => {
  function session(over: Partial<SessionInfo>): SessionInfo {
    return {
      id: "s1",
      title: "t",
      createdAt: "",
      lastUsedAt: "",
      ...over,
    } as SessionInfo;
  }

  it("distinguishes the SAME model id offered by two services", () => {
    const direct = session({
      model: "deepseek-flash",
      serviceId: "deepseek",
      billingMode: "key",
    });
    const viaGateway = session({
      model: "deepseek/deepseek-v4-flash",
      serviceId: "openrouter",
      billingMode: "key",
    });
    expect(sessionSpawnIdentity(direct, "claude")).not.toBe(
      sessionSpawnIdentity(viaGateway, "claude"),
    );
  });

  it("distinguishes the two billing modes of one service", () => {
    const sub = session({ model: "claude-opus-5", serviceId: "anthropic", billingMode: "sub" });
    const key = session({ model: "claude-opus-5", serviceId: "anthropic", billingMode: "key" });
    expect(sessionSpawnIdentity(sub, "claude")).not.toBe(sessionSpawnIdentity(key, "claude"));
  });

  it("does NOT include the credential route — accounts are decided per turn (docs/260)", () => {
    const base = { model: "claude-opus-5", serviceId: "anthropic", billingMode: "sub" as const };
    expect(sessionSpawnIdentity(session(base), "claude")).toBe(
      sessionSpawnIdentity(session(base), "claude"),
    );
  });

  it("is stable across two reads of an unchanged session", () => {
    const s = session({
      model: "claude-opus-5",
      serviceId: "anthropic",
      billingMode: "sub",
    });
    expect(sessionSpawnIdentity(s, "claude")).toBe(sessionSpawnIdentity(s, "claude"));
    expect(desiredSpawnIdentity({ get: () => s }, "s1", "claude")).toBe(
      sessionSpawnIdentity(s, "claude"),
    );
  });

  it("has no opinion about a session the manager does not know", () => {
    expect(desiredSpawnIdentity({ get: () => undefined }, "s1", "claude")).toBeUndefined();
  });
});

describe("residentRouteNeedsRelease — moving a live session back (docs/260-turn-level-account-routing req 8)", () => {
  const future = () => new Date(Date.now() + 3_600_000).toISOString();
  const past = () => new Date(Date.now() - 60_000).toISOString();

  function accountsWithLimits(
    limits: (ids: { primary: string; secondary: string }) => Record<string, unknown>,
  ) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-resident-release-"));
    const credentialStore = new CredentialStore(path.join(root, "credentials.json"));
    const seed = new ProviderAccountManager({ credentialsDir: root, credentialStore });
    const primary = seed.create("anthropic", "Primary");
    const secondary = seed.create("anthropic", "Secondary");
    seed.setAccountStatus("anthropic", primary.id, "ready");
    seed.setAccountStatus("anthropic", secondary.id, "ready");
    const ids = { primary: primary.id, secondary: secondary.id };
    const providerAccountManager = new ProviderAccountManager({
      credentialsDir: root,
      credentialStore,
      getSubscriptionLimits: () => ({ "anthropic:sub": limits(ids) as never }),
    });
    return { root, ids, deps: { credentialStore, providerAccountManager } };
  }

  const liveSession = {
    id: "s1",
    title: "t",
    createdAt: "",
    lastUsedAt: "",
    model: "claude-opus-5",
    serviceId: "anthropic",
    billingMode: "sub",
  } as SessionInfo;

  const residentOn = (id: string, backgroundWork: string[] = []) => ({
    residentRoute: { kind: "account" as const, id },
    backgroundWorkDescriptions: backgroundWork,
  });

  it("retires the secondary's process once the primary's window has reset", () => {
    const { ids, deps } = accountsWithLimits(({ primary, secondary }) => ({
      [primary]: { session: { usedPct: 100, resetAt: past() } },
      [secondary]: { session: { usedPct: 20, resetAt: future() } },
    }));

    expect(residentRouteNeedsRelease(liveSession, "claude", residentOn(ids.secondary), deps)).toBe(true);
  });

  it("leaves the process alone while the primary's window is genuinely spent", () => {
    const { ids, deps } = accountsWithLimits(({ primary, secondary }) => ({
      [primary]: { session: { usedPct: 100, resetAt: future() } },
      [secondary]: { session: { usedPct: 20, resetAt: future() } },
    }));

    expect(residentRouteNeedsRelease(liveSession, "claude", residentOn(ids.secondary), deps)).toBe(false);
  });

  it("does not retire a process holding background work, even when the primary is back", () => {
    const { ids, deps } = accountsWithLimits(({ primary, secondary }) => ({
      [primary]: { session: { usedPct: 100, resetAt: past() } },
      [secondary]: { session: { usedPct: 20, resetAt: future() } },
    }));

    expect(
      residentRouteNeedsRelease(liveSession, "claude", residentOn(ids.secondary, ["sub-agent review"]), deps),
    ).toBe(false);
  });
});

it("captures a checked OpenCode account route and refuses a filtered native model", () => {
  const selection = { serviceId: "openai", billingMode: "sub" as const, modelId: "gpt-5.5" };
  expect(serviceRoutingForSelection("opencode", selection, { kind: "account", id: "account-a" }, storeHolding())).toMatchObject({ style: "openai-responses", credentialTarget: { kind: "openai-chatgpt", accountId: "account-a" } });
  expect(serviceRoutingForSelection("opencode", { ...selection, modelId: "gpt-6-astra" }, { kind: "account", id: "account-a" }, storeHolding())).toBeUndefined();
});
