import { describe, it, expect } from "vitest";
import {
  desiredSpawnIdentity,
  envRouteIdFor,
  firstEligibleSelectionForHarness,
  listConfiguredCredentials,
  selectRouteForSelection,
  serviceRoutingForSelection,
  sessionSpawnIdentity,
} from "./service-routing.js";
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
  };
}

describe("listConfiguredCredentials", () => {
  it("reads the store AND the deployment's own environment", () => {
    // A deployment-supplied key has no row in the store — phase 2 is explicit
    // that ShipIt only ever touches a value it put there — so a rule reading the
    // store alone would report that install as having no credential at all and
    // empty its picker.
    const credentials = listConfiguredCredentials(
      store([route({ id: "cred_1", serviceId: "deepseek" })], { cred_1: "sk-ds" }),
      { ANTHROPIC_API_KEY: "sk-ant" } as NodeJS.ProcessEnv,
    );
    expect(credentials).toContainEqual({ serviceId: "deepseek", billingMode: "key", via: "string" });
    expect(credentials).toContainEqual({ serviceId: "anthropic", billingMode: "key", via: "string" });
  });

  it("ignores a string route with no secret behind it", () => {
    // A route that reports configured and delivers nothing is worse than absent:
    // the model is offered and the turn cannot authenticate.
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
    // An account row exists from the moment the login starts and a cancelled one
    // stays `unavailable` forever, while turn routing accepts only `ready` or
    // `authenticating`. Counting the rest offers a subscription whose every turn
    // is refused — eligibility has to ask the same question routing does.
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

/**
 * planning#353 — the default for a session that has never had a model picked.
 *
 * The bug these pin: turn routing asked the harness's OWN vendor, so an install
 * whose only credential is a DeepSeek key sent every selection-less turn to
 * Anthropic and failed `auth_required` while the composer displayed a runnable
 * model.
 */
describe("firstEligibleSelectionForHarness", () => {
  it("picks a credentialed service over the harness's own vendor", () => {
    const selection = firstEligibleSelectionForHarness("claude", {
      credentialStore: store([route({ id: "cred_1", serviceId: "deepseek" })], { cred_1: "sk-ds" }),
      env: {} as NodeJS.ProcessEnv,
    });
    expect(selection).toEqual({
      serviceId: "deepseek",
      billingMode: "key",
      modelId: "deepseek-v4-flash",
    });
  });

  it("still prefers the harness's own vendor when the install has a credential for it", () => {
    // The first-party path must not move: Anthropic leads the catalogue, so a
    // connected account is what a Claude session with no selection still gets.
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
    // Anthropic's `sub` leads the catalogue but holds nothing here, so the
    // answer is its `key` mode rather than the first row in catalogue order.
    // (Named accurately after a cross-agent review pointed out an earlier
    // comment here described an account-only install, which this is not — that
    // case is the `sub` assertion above.)
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
    // Codex speaks only `openai-responses`; DeepSeek's models declare
    // `openai-chat-completions` and `anthropic-messages`. So a Codex session on
    // a DeepSeek-only install genuinely has nothing to run, and `auth_required`
    // is the honest answer rather than a reroute to a model it cannot drive.
    expect(
      firstEligibleSelectionForHarness("codex", {
        credentialStore: store([route({ id: "cred_1", serviceId: "deepseek" })], { cred_1: "sk-ds" }),
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
        providerAccountManager: { selectAccountForTurn: () => anthropicAccount },
      },
    );
    expect(selected).toEqual(anthropicAccount);
  });

  /**
   * planning#342 — the walk is asked about the **selected service**, not about
   * the harness's own vendor.
   *
   * The pair here is deliberately the one where the two answers differ:
   * `(anthropic, sub)` selected while pinned to the **Codex** harness. Asking
   * about the harness would walk OpenAI's accounts for a turn that named
   * Anthropic's subscription — the conflation this feature exists to remove.
   * A same-vendor pair cannot pin this, because there both answers are
   * `"anthropic"` and reverting the axis stays green.
   *
   * The picker does not offer this state (Anthropic's subscription models are
   * `anthropic-messages`, which Codex does not speak), so it is reachable only
   * from a stale session row — but `acceptsAccount` does **not** rule it out:
   * that predicate asks whether the harness can carry an account-delivered
   * credential at all, and Codex can. So the equality this feature relies on is
   * a property of the current catalogue, not of the code, and this is the
   * assertion that says so out loud. A future service with an account-delivered
   * subscription a second harness can carry breaks the equality, not this test.
   */
  it("asks the account walk about the selected service, not the harness's vendor", () => {
    const asked: string[] = [];
    selectRouteForSelection(
      "codex",
      { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" },
      {
        credentialStore: store([]),
        providerAccountManager: {
          selectAccountForTurn: (serviceId: string) => {
            asked.push(serviceId);
            return anthropicAccount;
          },
        },
      },
    );
    expect(asked).toEqual(["anthropic"]);
  });

  /**
   * The no-selection path asks the harness's own vendor. Separate from the case
   * above so putting the two paths on one axis fails one of them.
   *
   * planning#353 — this is no longer the *session* default. A selection-less
   * turn is settled onto `firstEligibleSelectionForHarness` by
   * `prepareSessionAgentEnvironment` before it reaches here, so what this pins
   * is the residual answer for a caller with genuinely no other information.
   */
  it("falls back to the harness's own vendor when there is no selection", () => {
    const asked: string[] = [];
    selectRouteForSelection("codex", undefined, {
      credentialStore: store([]),
      providerAccountManager: {
        selectAccountForTurn: (serviceId: string) => {
          asked.push(serviceId);
          return noAccount;
        },
      },
    });
    expect(asked).toEqual(["openai"]);
  });

  it("never hands an `anthropic:sub` selection the metered key route", () => {
    // This is the leak phase 3 closes. `selectAccountForTurn` ends with a
    // mode-blind reserved fallback, so with no account connected an INCLUDED
    // selection used to land on `claude-api-key` and quietly become a metered
    // turn — the silent shift onto metered billing req 12 refuses, arriving
    // through routing rather than through failover.
    const selected = selectRouteForSelection(
      "claude",
      { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" },
      {
        credentialStore: store([]),
        providerAccountManager: {
          selectAccountForTurn: () => ({ ok: true, route: { kind: "reserved", id: "claude-api-key" } }),
        },
        env: { ANTHROPIC_API_KEY: "sk-ant" } as NodeJS.ProcessEnv,
      },
    );
    expect(selected).toEqual({ ok: false, reason: "auth_required" });
  });

  it("still reaches `anthropic:sub`'s OWN env-delivered token", () => {
    // `claude-env-oauth` is a subscription delivered as an environment token —
    // the counter-example the `via` vs `kind` split exists for — so it belongs
    // to the `sub` mode and is reachable from it.
    const selected = selectRouteForSelection(
      "claude",
      { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" },
      {
        credentialStore: store([]),
        providerAccountManager: { selectAccountForTurn: () => noAccount },
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
        providerAccountManager: { selectAccountForTurn: () => exhausted },
        env: { ANTHROPIC_AUTH_TOKEN: "tok" } as NodeJS.ProcessEnv,
      },
    );
    expect(selected).toEqual(exhausted);
  });

  it("resolves a custom service to its own stored credential, not to an account", () => {
    const selected = selectRouteForSelection(
      "claude",
      { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4-flash" },
      {
        credentialStore: store([route({ id: "cred_ds", serviceId: "deepseek" })], { cred_ds: "sk" }),
        providerAccountManager: { selectAccountForTurn: () => anthropicAccount },
      },
    );
    expect(selected).toEqual({ ok: true, route: { kind: "reserved", id: "cred_ds" } });
  });

  it("keeps the pre-feature question for a session with no selection", () => {
    const selected = selectRouteForSelection("claude", undefined, {
      credentialStore: store([]),
      providerAccountManager: { selectAccountForTurn: () => anthropicAccount },
    });
    expect(selected).toEqual(anthropicAccount);
  });
});

// docs/252 phase 5, req 12 — the gap phase 2 left open: a subscription can hold
// several string credentials and nothing could choose between them, so the
// second was stored and unreachable.
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
    // req 12 — "when no subscription is left to fail over to, ShipIt stops and
    // says so, exactly as it does for a key".
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
    // The env credential carries no row, so ShipIt tracks no quota for it and
    // could neither bench it after it failed nor name it in the transcript.
    // Rolling onto it would replace req 13's reset time with a second failure.
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
    // Balanced spreads SESSIONS, not turns: without the resident preference,
    // least-recently-used ordering would alternate a two-credential install
    // every turn and restart the resident process each time.
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
    // The stickiness only holds while the resident credential is unblocked —
    // a benched one hands the session to the normal walk.
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
    // Nothing benches a `key` route today (`markCredentialRouteExhausted`
    // refuses), but the selection walk must not depend on that: req 12 says a
    // key is used until the user replaces it, and moving off one would be the
    // silent hop onto a second metered credential the requirement refuses.
    const selected = selectRouteForSelection(
      "claude",
      { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4-flash" },
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

/**
 * Which route ids the store holds a row for, for `serviceRoutingForSelection`.
 *
 * docs/252 req 20 — the question moved from the id's SHAPE to the store,
 * because adoption gives a stored row one of the legacy reserved ids on purpose
 * so pinned sessions keep resolving. `cred_ds` is a stored row here; anything
 * else is a credential that exists only as a deployment variable.
 */
const storeHolding = (...ids: string[]) => ({
  getCredentialRoute: (id: string) =>
    (ids.includes(id) ? ({ id } as unknown as CredentialRoute) : undefined),
});

describe("serviceRoutingForSelection", () => {
  it("shapes a string-delivered credential", () => {
    const routing = serviceRoutingForSelection(
      "claude",
      { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4-flash" },
      { kind: "reserved", id: "cred_ds" },
      storeHolding("cred_ds"),
    );
    expect(routing).toMatchObject({
      serviceId: "deepseek",
      serviceName: "DeepSeek",
      billingMode: "key",
      style: "anthropic-messages",
      baseUrl: "https://api.deepseek.com/anthropic",
      // docs/252 phase 5 — a STORED credential is sourced from its own variable,
      // not from the mode's group name. The group name carries the group's first
      // credential, so once failover can move a session onto the second, sourcing
      // from the group would authenticate with the one ShipIt had just benched.
      credentialSourceEnv: "SHIPIT_CREDENTIAL_CRED_DS",
      credentialTarget: { kind: "env", name: "ANTHROPIC_API_KEY" },
    });
  });

  /**
   * docs/252 req 20's sharpest edge, and a regression this branch introduced
   * before it was caught.
   *
   * Adoption gives a stored row one of the LEGACY reserved ids on purpose —
   * `claude-env-oauth`, so sessions pinned to it keep resolving. The old test
   * for "is this a stored route" was `startsWith("cred_")`, a faithful proxy
   * only while every stored row had a minted id. Under it, an adopted
   * credential answered "not stored" and was handed the mode's GROUP variable,
   * which always carries the group's FIRST credential — so once ordering or
   * failover moved a session onto the adopted row, the turn authenticated with
   * a different credential than the one it was attributed to, and possibly with
   * the very one ShipIt had just benched.
   */
  it("sources an ADOPTED credential from its own variable, legacy id and all", () => {
    expect(
      serviceRoutingForSelection(
        "claude",
        { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4-flash" },
        { kind: "reserved", id: "claude-api-key" },
        // The store holds a row for it: that, not the id's shape, is what makes
        // it stored — `collectServiceCredentialEnv` writes a per-route variable
        // for every stored `via: "string"` row whatever its id.
        storeHolding("claude-api-key"),
      ),
    ).toMatchObject({ credentialSourceEnv: "SHIPIT_CREDENTIAL_CLAUDE_API_KEY" });
  });

  it("keeps the mode's group variable for an ENV-delivered credential", () => {
    // It has no row and no id of its own, so the catalogue's `storageEnv` is the
    // only name it has ever had.
    expect(
      serviceRoutingForSelection(
        "claude",
        { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4-flash" },
        { kind: "reserved", id: "env:DEEPSEEK_API_KEY" },
        storeHolding(),
      ),
    ).toMatchObject({ credentialSourceEnv: "DEEPSEEK_API_KEY" });
  });

  it("leaves an account-delivered credential alone", () => {
    // A `scoped-home` credential IS the vendor's login, and its token exchange
    // is bound to that vendor's endpoint — shaping it would break it outright
    // rather than redirect it. This is what keeps today's first-party spawn
    // byte-identical.
    expect(
      serviceRoutingForSelection(
        "claude",
        { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" },
        { kind: "account", id: "acct_1" },
        storeHolding(),
      ),
    ).toBeUndefined();
  });

  it("has nothing to shape for a session with no selection", () => {
    expect(serviceRoutingForSelection("claude", undefined, null, storeHolding())).toBeUndefined();
  });

  it("does not shape an account-capable mode on a guess when no route is resolved", () => {
    // The pinned route is the evidence that the credential is string-delivered,
    // and env prep pins it before the run params are built. An absent one means
    // the router is not wired at all, where the pre-feature spawn is right.
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
    // DeepSeek accepts nothing but a key, so there is no ambiguity to resolve —
    // which is what makes a custom service work on a session that has never
    // pinned a route.
    expect(
      serviceRoutingForSelection(
        "claude",
        { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4-flash" },
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
    // The defect the widening exists to close: under a model-string comparison
    // these two are equal, no kill fires, and the next turn runs on the previous
    // service's endpoint and credential — billing the wrong account (req 11).
    const direct = session({
      model: "deepseek-v4-flash",
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
    // Without the mode, "charge me, keep working" would reuse the spent
    // subscription's process.
    const sub = session({ model: "claude-opus-5", serviceId: "anthropic", billingMode: "sub" });
    const key = session({ model: "claude-opus-5", serviceId: "anthropic", billingMode: "key" });
    expect(sessionSpawnIdentity(sub, "claude")).not.toBe(sessionSpawnIdentity(key, "claude"));
  });

  it("does NOT include the credential route — accounts are decided per turn (docs/260)", () => {
    // The route left this tuple with the pin: the resident process's account
    // is compared separately via `runner.residentRoute`, so two sessions on
    // different accounts with the same shaping share one identity.
    const base = { model: "claude-opus-5", serviceId: "anthropic", billingMode: "sub" as const };
    expect(sessionSpawnIdentity(session(base), "claude")).toBe(
      sessionSpawnIdentity(session(base), "claude"),
    );
  });

  it("is stable across two reads of an unchanged session", () => {
    // Symmetry is what stops a spurious respawn on every turn: the guard's
    // question and the spawn-time stamp are the same function of the same row.
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
