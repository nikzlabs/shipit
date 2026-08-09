import { describe, it, expect } from "vitest";
import {
  desiredSpawnIdentity,
  envRouteIdFor,
  listConfiguredCredentials,
  selectRouteForSelection,
  serviceRoutingForSelection,
  sessionSpawnIdentity,
} from "./service-routing.js";
import type { CredentialRoute } from "../shared/types/domain-types/credential-route.js";
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

function store(routes: CredentialRoute[], secrets: Record<string, string> = {}) {
  return {
    listCredentialRoutes: (serviceId?: string, billingMode?: string) =>
      routes.filter(
        (r) =>
          (serviceId === undefined || r.serviceId === serviceId)
          && (billingMode === undefined || r.billingMode === billingMode),
      ),
    getCredentialSecret: (id: string) => secrets[id],
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

describe("envRouteIdFor", () => {
  it("keeps ShipIt's historical ids so pinned sessions are not orphaned", () => {
    expect(envRouteIdFor("ANTHROPIC_AUTH_TOKEN")).toBe("claude-env-oauth");
    expect(envRouteIdFor("ANTHROPIC_API_KEY")).toBe("claude-api-key");
    expect(envRouteIdFor("OPENAI_API_KEY")).toBe("codex-api-key");
    expect(envRouteIdFor("DEEPSEEK_API_KEY")).toBe("env:DEEPSEEK_API_KEY");
  });
});

describe("serviceRoutingForSelection", () => {
  it("shapes a string-delivered credential", () => {
    const routing = serviceRoutingForSelection(
      "claude",
      { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4-flash" },
      { kind: "reserved", id: "cred_ds" },
    );
    expect(routing).toMatchObject({
      serviceId: "deepseek",
      serviceName: "DeepSeek",
      billingMode: "key",
      style: "anthropic-messages",
      baseUrl: "https://api.deepseek.com/anthropic",
      credentialSourceEnv: "DEEPSEEK_API_KEY",
      credentialTarget: { kind: "env", name: "ANTHROPIC_API_KEY" },
    });
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
      ),
    ).toBeUndefined();
  });

  it("has nothing to shape for a session with no selection", () => {
    expect(serviceRoutingForSelection("claude", undefined, null)).toBeUndefined();
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

  it("distinguishes the credential route", () => {
    const base = { model: "claude-opus-5", serviceId: "anthropic", billingMode: "sub" as const };
    const a = session({ ...base, providerRouteKind: "account", providerRouteId: "acct_1" });
    const b = session({ ...base, providerRouteKind: "account", providerRouteId: "acct_2" });
    expect(sessionSpawnIdentity(a, "claude")).not.toBe(sessionSpawnIdentity(b, "claude"));
  });

  it("is stable across two reads of an unchanged session", () => {
    // Symmetry is what stops a spurious respawn on every turn: the guard's
    // question and the spawn-time stamp are the same function of the same row.
    const s = session({
      model: "claude-opus-5",
      serviceId: "anthropic",
      billingMode: "sub",
      providerRouteKind: "account",
      providerRouteId: "acct_1",
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
