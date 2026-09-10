import { describe, it, expect, vi } from "vitest";
import type { AgentRole, CredentialRoute, ReviewerPin, ReviewerSlot } from "../../shared/types.js";

// Keep host credentials out of the fixtures.
const EMPTY_ENV: NodeJS.ProcessEnv = {};

function route(
  over: Pick<CredentialRoute, "serviceId" | "billingMode">
    & Partial<Pick<CredentialRoute, "via" | "status" | "exhaustedUntil" | "id">>,
): CredentialRoute {
  return {
    serviceId: over.serviceId,
    billingMode: over.billingMode,
    id: over.id ?? `${over.serviceId}-${over.billingMode}`,
    via: over.via ?? "string",
    status: over.status ?? "ready",
    priority: 0,
    isPrimary: true,
    label: "test",
    createdAt: 0,
    updatedAt: 0,
    ...(over.exhaustedUntil !== undefined ? { exhaustedUntil: over.exhaustedUntil } : {}),
  };
}

const DEEPSEEK_KEY = route({ serviceId: "deepseek", billingMode: "key" });
const ANTHROPIC_KEY = route({ serviceId: "anthropic", billingMode: "key" });
const ANTHROPIC_ACCOUNT = route({ serviceId: "anthropic", billingMode: "sub", via: "account" });

interface FakeStoreOpts {
  routes?: CredentialRoute[];
  roles?: AgentRole[];
  pins?: Partial<Record<ReviewerSlot, ReviewerPin>>;
  secretless?: string[];
}

function storeWith(opts: FakeStoreOpts = {}) {
  const routes = opts.routes ?? [];
  const roles = opts.roles ?? [];
  const secretless = new Set(opts.secretless ?? []);
  const getReviewerPin = vi.fn((slot: ReviewerSlot) => opts.pins?.[slot]);
  return {
    getReviewerPin,
    getRoles: () => roles,
    getRole: (name: string) => roles.find((r) => r.name === name),
    listCredentialRoutes: (serviceId?: string, billingMode?: string) =>
      routes.filter(
        (r) =>
          (serviceId === undefined || r.serviceId === serviceId)
          && (billingMode === undefined || r.billingMode === billingMode),
      ),
    getCredentialSecret: (id: string) =>
      routes.some((r) => r.id === id && r.via === "string") && !secretless.has(id)
        ? "sk-test"
        : undefined,
    getSelectionMode: () => "strict" as const,
    getCredentialRoute: (id: string) => routes.find((r) => r.id === id),
    getFailoverCutoffs: () => ({ session: 90, weekly: 90 }),
  };
}

const ALL_INSTALLED = () => true;

const REVIEWER: AgentRole = { name: "reviewer", params: { kind: "auto" } };

function pinnedRole(
  name: string,
  params: Omit<Extract<AgentRole["params"], { kind: "pinned" }>, "kind">,
  extra: Partial<AgentRole> = {},
): AgentRole {
  return { name, ...extra, params: { kind: "pinned", ...params } };
}

const DEEPSEEK_ON_CLAUDE = {
  harnessId: "claude" as const,
  serviceId: "deepseek",
  billingMode: "key" as const,
  modelId: "deepseek-flash",
  reasoningEffort: "high",
};

describe("checkRolePinnedParams — the level follows the harness the ROLE names (req 6)", () => {
  it("refuses a Codex-only level on a role that names Claude, for a model both carry", async () => {
    const { checkRolePinnedParams } = await import("./roles.js");
    const result = checkRolePinnedParams(
      { kind: "pinned", ...DEEPSEEK_ON_CLAUDE, reasoningEffort: "minimal" },
      { credentialStore: storeWith({ routes: [DEEPSEEK_KEY] }), env: EMPTY_ENV, isInstalled: ALL_INSTALLED },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("reasoningEffort");
    expect(result.message).toContain("minimal");
  });

  it("accepts the same Codex-only level when the role names Codex", async () => {
    const { checkRolePinnedParams } = await import("./roles.js");
    const result = checkRolePinnedParams(
      { kind: "pinned", ...DEEPSEEK_ON_CLAUDE, harnessId: "codex", reasoningEffort: "minimal" },
      { credentialStore: storeWith({ routes: [DEEPSEEK_KEY] }), env: EMPTY_ENV, isInstalled: ALL_INSTALLED },
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a Codex-only level on Codex, and refuses it on Claude Code — both directions", async () => {
    const { checkRolePinnedParams } = await import("./roles.js");
    const deps = {
      credentialStore: storeWith({ routes: [DEEPSEEK_KEY] }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    };
    expect(
      checkRolePinnedParams(
        { kind: "pinned", ...DEEPSEEK_ON_CLAUDE, harnessId: "codex", reasoningEffort: "none" },
        deps,
      ).ok,
    ).toBe(true);
    const onClaude = checkRolePinnedParams(
      { kind: "pinned", ...DEEPSEEK_ON_CLAUDE, reasoningEffort: "none" },
      deps,
    );
    expect(onClaude.ok).toBe(false);
    if (!onClaude.ok) expect(onClaude.field).toBe("reasoningEffort");
  });

  it("accepts an absent level on EITHER harness — Default needs no declaration", async () => {
    const { checkRolePinnedParams } = await import("./roles.js");
    const deps = {
      credentialStore: storeWith({ routes: [DEEPSEEK_KEY] }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    };
    const { reasoningEffort: _dropped, ...atDefault } = DEEPSEEK_ON_CLAUDE;
    expect(checkRolePinnedParams({ kind: "pinned", ...atDefault }, deps).ok).toBe(true);
    expect(
      checkRolePinnedParams({ kind: "pinned", ...atDefault, harnessId: "codex" }, deps).ok,
    ).toBe(true);
  });

  it("keeps the level ABSENT through the check, rather than filling one in (req 7)", async () => {
    const { checkRolePinnedParams } = await import("./roles.js");
    const { reasoningEffort: _dropped, ...atDefault } = DEEPSEEK_ON_CLAUDE;
    const result = checkRolePinnedParams(
      { kind: "pinned", ...atDefault },
      { credentialStore: storeWith({ routes: [DEEPSEEK_KEY] }), env: EMPTY_ENV, isInstalled: ALL_INSTALLED },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect("reasoningEffort" in result.params).toBe(false);
  });

  it("still refuses a level the named harness does not declare, and says Default is available", async () => {
    const { checkRolePinnedParams } = await import("./roles.js");
    const result = checkRolePinnedParams(
      { kind: "pinned", ...DEEPSEEK_ON_CLAUDE, reasoningEffort: "minimal" },
      { credentialStore: storeWith({ routes: [DEEPSEEK_KEY] }), env: EMPTY_ENV, isInstalled: ALL_INSTALLED },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Default");
  });

  it("differs from resolveReviewerPinPatch, which derives the harness and validates against that", async () => {
    const { checkRolePinnedParams } = await import("./roles.js");
    const { resolveReviewerPinPatch } = await import("./reviewer-settings.js");
    const store = storeWith({ routes: [DEEPSEEK_KEY] });
    const triple = {
      serviceId: "deepseek",
      billingMode: "key" as const,
      modelId: "deepseek-flash",
      reasoningEffort: "minimal",
    };

    expect(resolveReviewerPinPatch(triple, store, EMPTY_ENV).reasoningEffort).not.toBe("minimal");

    const asRole = checkRolePinnedParams(
      { kind: "pinned", harnessId: "codex", ...triple },
      { credentialStore: store, env: EMPTY_ENV, isInstalled: ALL_INSTALLED },
    );
    expect(asRole.ok).toBe(true);
  });
});

describe("checkRolePinnedParams — the other three refusals, each naming its parameter (req 7)", () => {
  const deps = () => ({
    credentialStore: storeWith({ routes: [DEEPSEEK_KEY, ANTHROPIC_KEY] }),
    env: EMPTY_ENV,
    isInstalled: ALL_INSTALLED,
  });

  it("refuses a harness this deployment does not have, naming the harness", async () => {
    const { checkRolePinnedParams } = await import("./roles.js");
    const result = checkRolePinnedParams(
      { kind: "pinned", ...DEEPSEEK_ON_CLAUDE },
      { ...deps(), isInstalled: (id) => id !== "claude" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("harnessId");
  });

  it("refuses a triple the catalogue does not carry, naming the model", async () => {
    const { checkRolePinnedParams } = await import("./roles.js");
    const result = checkRolePinnedParams(
      { kind: "pinned", ...DEEPSEEK_ON_CLAUDE, modelId: "no-such-model" },
      deps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("model");
  });

  it("refuses a harness that cannot carry the model, naming the harness", async () => {
    const { checkRolePinnedParams } = await import("./roles.js");
    const result = checkRolePinnedParams(
      {
        kind: "pinned",
        harnessId: "codex",
        serviceId: "anthropic",
        billingMode: "key",
        modelId: "claude-opus-5",
        reasoningEffort: "high",
      },
      deps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("harnessId");
  });

  it("does NOT re-point a retired model through its successor (req 7)", async () => {
    const { checkRolePinnedParams } = await import("./roles.js");
    const result = checkRolePinnedParams(
      {
        kind: "pinned",
        harnessId: "codex",
        serviceId: "openai",
        billingMode: "key",
        modelId: "gpt-5.6",
        reasoningEffort: "high",
      },
      { credentialStore: storeWith({ routes: [route({ serviceId: "openai", billingMode: "key" })] }), env: EMPTY_ENV, isInstalled: ALL_INSTALLED },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("model");
  });
});

describe("checkRolePinnedParams — compatibility only, never live availability", () => {
  it("keeps a role valid while its only credential is quota-exhausted", async () => {
    const { checkRolePinnedParams, resolveRoleView } = await import("./roles.js");
    const spent = route({
      serviceId: "anthropic",
      billingMode: "sub",
      via: "account",
      exhaustedUntil: Date.now() + 3_600_000,
    });
    const role = pinnedRole("deep-dive", {
      harnessId: "claude",
      serviceId: "anthropic",
      billingMode: "sub",
      modelId: "claude-opus-5",
      reasoningEffort: "high",
    });
    const deps = {
      credentialStore: storeWith({ routes: [spent], roles: [role] }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
      providerAccountManager: {
        selectAccountForTurn: () => ({
          ok: false as const,
          reason: "all_exhausted" as const,
          earliestResetAt: "2026-08-15T18:00:00.000Z",
        }),
        subscriptionLimitsFor: () => ({}),
      },
    };
    expect(checkRolePinnedParams(role.params as never, deps).ok).toBe(true);
    const view = resolveRoleView(role, deps);
    expect(view.unavailableReason).toBe("quota_exhausted");
    expect(view.earliestResetAt).toBe("2026-08-15T18:00:00.000Z");
  });

  it("passes a credential-less tuple for a save and refuses it for a run", async () => {
    const { checkRolePinnedParams } = await import("./roles.js");
    const deps = {
      credentialStore: storeWith({ routes: [] }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    };
    const params = pinnedRole("deep-dive", DEEPSEEK_ON_CLAUDE).params as never;
    expect(checkRolePinnedParams(params, deps, "save").ok).toBe(true);
    const forRun = checkRolePinnedParams(params, deps, "run");
    expect(forRun.ok).toBe(false);
    if (!forRun.ok) expect(forRun.kind).toBe("credential");
  });

  it("keeps refusing a tuple fault on a save — only the credential step is skipped", async () => {
    const { checkRolePinnedParams } = await import("./roles.js");
    const deps = {
      credentialStore: storeWith({ routes: [] }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    };
    const broken = pinnedRole("deep-dive", {
      ...DEEPSEEK_ON_CLAUDE,
      reasoningEffort: "minimal",
    }).params as never;
    const checked = checkRolePinnedParams(broken, deps, "save");
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.kind).toBe("catalogue");
      expect(checked.field).toBe("reasoningEffort");
    }
  });
});

const CLAUDE_IMPLEMENTER = {
  harnessId: "claude" as const,
  selection: { serviceId: "anthropic", billingMode: "key" as const, modelId: "claude-opus-5" },
};

describe("resolveRoleByName — an unknown name (req 13)", () => {
  it("refuses, listing the roles that do exist", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const deps = {
      credentialStore: storeWith({
        routes: [DEEPSEEK_KEY],
        roles: [REVIEWER, pinnedRole("deep dive", DEEPSEEK_ON_CLAUDE)],
      }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    };
    expect(() => resolveRoleByName("nope", {}, CLAUDE_IMPLEMENTER, deps)).toThrow(
      /Unknown role "nope"\. Roles on this install: reviewer, deep dive\./,
    );
  });
});

describe("resolveRoleByName — a pinned role (reqs 6, 7, 10)", () => {
  const deps = (roles: AgentRole[]) => ({
    credentialStore: storeWith({ routes: [DEEPSEEK_KEY, ANTHROPIC_KEY], roles }),
    env: EMPTY_ENV,
    isInstalled: ALL_INSTALLED,
  });

  it("runs on the harness it names, with no override", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const role = pinnedRole("deep-dive", { ...DEEPSEEK_ON_CLAUDE, harnessId: "codex", reasoningEffort: "none" }, { prompt: "Check requirements." });
    const target = resolveRoleByName("deep-dive", {}, CLAUDE_IMPLEMENTER, deps([role]));
    expect(target.harnessId).toBe("codex");
    expect(target.reasoningEffort).toBe("none");
    expect(target.selection).toEqual({
      serviceId: "deepseek",
      billingMode: "key",
      modelId: "deepseek-flash",
    });
    expect(target.prompt).toBe("Check requirements.");
    expect(target.roleName).toBe("deep-dive");
    expect(target.overridden).toBe(false);
  });

  it("resolves a role at Default to a target with NO level — pass no flag (req 1)", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const { reasoningEffort: _dropped, ...atDefault } = DEEPSEEK_ON_CLAUDE;
    const role = pinnedRole("deep-dive", atDefault);
    const target = resolveRoleByName("deep-dive", {}, CLAUDE_IMPLEMENTER, deps([role]));
    expect(target.harnessId).toBe("claude");
    expect("reasoningEffort" in target).toBe(false);
  });

  it("lets a caller override a Default role onto a real level (req 10)", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const { reasoningEffort: _dropped, ...atDefault } = DEEPSEEK_ON_CLAUDE;
    const role = pinnedRole("deep-dive", atDefault);
    const target = resolveRoleByName(
      "deep-dive",
      { reasoningEffort: "max" },
      CLAUDE_IMPLEMENTER,
      deps([role]),
    );
    expect(target.reasoningEffort).toBe("max");
    expect(target.overridden).toBe(true);
  });

  it("freezes the target and its selection", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const target = resolveRoleByName(
      "deep-dive",
      {},
      CLAUDE_IMPLEMENTER,
      deps([pinnedRole("deep-dive", DEEPSEEK_ON_CLAUDE)]),
    );
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen(target.selection)).toBe(true);
  });

  it("substitutes an overridden level and leaves the triple untouched", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const target = resolveRoleByName(
      "deep-dive",
      { reasoningEffort: "max" },
      CLAUDE_IMPLEMENTER,
      deps([pinnedRole("deep-dive", DEEPSEEK_ON_CLAUDE)]),
    );
    expect(target.reasoningEffort).toBe("max");
    expect(target.selection.serviceId).toBe("deepseek");
    expect(target.overridden).toBe(true);
  });

  it("refuses a model the role's service does not offer, rather than relocating the service", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    expect(() =>
      resolveRoleByName(
        "deep-dive",
        { modelId: "claude-opus-5" },
        CLAUDE_IMPLEMENTER,
        deps([pinnedRole("deep-dive", DEEPSEEK_ON_CLAUDE)]),
      ),
    ).toThrow(/does not offer "claude-opus-5"/);
    expect(() =>
      resolveRoleByName(
        "deep-dive",
        { modelId: "claude-opus-5" },
        CLAUDE_IMPLEMENTER,
        deps([pinnedRole("deep-dive", DEEPSEEK_ON_CLAUDE)]),
      ),
    ).toThrow(/Name --service as well; .* offered on anthropic\/sub, anthropic\/key/s);
  });

  it("resolves once the caller adds the --service the refusal asked for", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const target = resolveRoleByName(
      "deep-dive",
      { serviceId: "anthropic", modelId: "claude-opus-5" },
      CLAUDE_IMPLEMENTER,
      deps([pinnedRole("deep-dive", DEEPSEEK_ON_CLAUDE)]),
    );
    expect(target.selection).toEqual({
      serviceId: "anthropic",
      billingMode: "key",
      modelId: "claude-opus-5",
    });
  });

  it("leaves a fully-named but incoherent location to the shared validator", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const attempt = () =>
      resolveRoleByName(
        "deep-dive",
        { serviceId: "anthropic", billingMode: "sub", modelId: "deepseek-flash" },
        CLAUDE_IMPLEMENTER,
        deps([pinnedRole("deep-dive", DEEPSEEK_ON_CLAUDE)]),
      );
    expect(attempt).toThrow(
      /cannot run: No model "deepseek-flash" is offered by anthropic on the "sub" billing mode\./,
    );
    expect(attempt).not.toThrow(/Name --/);
  });

  it("names only the billing mode when the role's service does offer the model", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const role = pinnedRole("zai-role", {
      harnessId: "claude",
      serviceId: "zai",
      billingMode: "key",
      modelId: "glm-5.2",
      reasoningEffort: "high",
    });
    expect(() =>
      resolveRoleByName("zai-role", { modelId: "glm-5.2[1m]" }, CLAUDE_IMPLEMENTER, deps([role])),
    ).toThrow(/Name --billing-mode as well/);
  });

  it("honours a model override that names the service alongside it", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const target = resolveRoleByName(
      "deep-dive",
      { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" },
      CLAUDE_IMPLEMENTER,
      deps([pinnedRole("deep-dive", DEEPSEEK_ON_CLAUDE)]),
    );
    expect(target.selection).toEqual({
      serviceId: "anthropic",
      billingMode: "key",
      modelId: "claude-opus-5",
    });
    expect(target.harnessId).toBe("claude");
  });

  it("keeps the role's service when the overridden model lives on it too", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const target = resolveRoleByName(
      "deep-dive",
      { modelId: "deepseek-v4-pro" },
      CLAUDE_IMPLEMENTER,
      deps([pinnedRole("deep-dive", DEEPSEEK_ON_CLAUDE)]),
    );
    expect(target.selection).toEqual({
      serviceId: "deepseek",
      billingMode: "key",
      modelId: "deepseek-v4-pro",
    });
  });

  it("refuses an incoherent override, naming the parameter, rather than dropping it", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const role = pinnedRole("deep-dive", DEEPSEEK_ON_CLAUDE);
    expect(() =>
      resolveRoleByName(
        "deep-dive",
        { reasoningEffort: "minimal" },
        CLAUDE_IMPLEMENTER,
        deps([role]),
      ),
    ).toThrow(/minimal.*not a reasoning level Claude Code offers|Claude Code/);
    expect(() =>
      resolveRoleByName("deep-dive", { reasoningEffort: "minimal" }, CLAUDE_IMPLEMENTER, deps([role])),
    ).toThrow(/cannot run/);
  });

  it("refuses an override naming a model no service offers, without suggesting a flag", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const attempt = () =>
      resolveRoleByName(
        "deep-dive",
        { modelId: "no-such-model" },
        CLAUDE_IMPLEMENTER,
        deps([pinnedRole("deep-dive", DEEPSEEK_ON_CLAUDE)]),
      );
    expect(attempt).toThrow(
      /cannot run: No model "no-such-model" is offered by deepseek on the "key" billing mode\./,
    );
    expect(attempt).not.toThrow(/Name --/);
  });

  it("produces only tuples the save-time validator accepts", async () => {
    const { resolveRoleByName, checkRolePinnedParams } = await import("./roles.js");
    const d = deps([pinnedRole("deep-dive", DEEPSEEK_ON_CLAUDE)]);
    for (const overrides of [
      {},
      { reasoningEffort: "max" },
      { harnessId: "codex" as const, reasoningEffort: "none" },
      { modelId: "deepseek-v4-pro" },
      { serviceId: "anthropic", billingMode: "key" as const, modelId: "claude-opus-5" },
      { serviceId: "deepseek", billingMode: "key" as const, modelId: "deepseek-v4-pro" },
    ]) {
      const target = resolveRoleByName("deep-dive", overrides, CLAUDE_IMPLEMENTER, d);
      const asStored = checkRolePinnedParams(
        {
          kind: "pinned",
          harnessId: target.harnessId,
          serviceId: target.selection.serviceId,
          billingMode: target.selection.billingMode,
          modelId: target.selection.modelId,
          reasoningEffort: target.reasoningEffort,
        },
        d,
      );
      expect(asStored.ok).toBe(true);
    }
  });
});

describe("resolveRoleByName — the reviewer, un-overridden (req 2 intact)", () => {
  it("delegates to selectReviewer and still avoids the implementer's model", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const store = storeWith({
      routes: [ANTHROPIC_KEY, DEEPSEEK_KEY],
      roles: [REVIEWER],
    });
    const target = resolveRoleByName("reviewer", {}, CLAUDE_IMPLEMENTER, {
      credentialStore: store,
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    });
    expect(target.selection.modelId).not.toBe("claude-opus-5");
    expect(target.overridden).toBe(false);
    expect(target.route).toBeDefined();
    expect(target.reviewer?.slot).toBeDefined();
    expect(store.getReviewerPin).toHaveBeenCalled();
  });

  it("carries selectReviewer's harness, selection, effort, route, shaping and ranking unchanged", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const { selectReviewer } = await import("../reviewer-model.js");
    const deps = () => ({
      credentialStore: storeWith({ routes: [ANTHROPIC_KEY, DEEPSEEK_KEY], roles: [REVIEWER] }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    });
    const direct = selectReviewer(CLAUDE_IMPLEMENTER, deps());
    const viaRole = resolveRoleByName("reviewer", {}, CLAUDE_IMPLEMENTER, deps());
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    expect(viaRole.harnessId).toBe(direct.target.harnessId);
    expect(viaRole.selection).toEqual(direct.target.selection);
    expect(viaRole.reasoningEffort).toBe(direct.target.reasoningEffort);
    expect(viaRole.route).toEqual(direct.target.route);
    expect(viaRole.serviceRouting).toEqual(direct.target.serviceRouting);
    expect(viaRole.credentialSecret).toEqual(direct.target.credentialSecret);
    expect(viaRole.reviewer).toEqual({
      slot: direct.target.slot,
      source: direct.target.source,
      tier: direct.tier,
      tierBasis: direct.tierBasis,
    });
  });

  it("keeps a user-pinned slot's own level rather than deriving one", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const store = storeWith({
      routes: [DEEPSEEK_KEY],
      roles: [REVIEWER],
      pins: {
        first: {
          serviceId: "deepseek",
          billingMode: "key",
          modelId: "deepseek-v4-pro",
          reasoningEffort: "low",
        },
      },
    });
    const target = resolveRoleByName("reviewer", {}, CLAUDE_IMPLEMENTER, {
      credentialStore: store,
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    });
    expect(target.selection.modelId).toBe("deepseek-v4-pro");
    expect(target.reasoningEffort).toBe("low");
  });
});

function bothSlotsUnroutable() {
  const unroutable: ReviewerPin = {
    serviceId: "anthropic",
    billingMode: "key",
    modelId: "claude-opus-5",
    reasoningEffort: "high",
  };
  return storeWith({
    routes: [DEEPSEEK_KEY],
    roles: [REVIEWER],
    pins: { first: unroutable, second: unroutable },
  });
}

describe("resolveRoleByName — the reviewer, overridden (reqs 10, 16)", () => {
  it("resolves a COMPLETE override without consulting the ranking at all", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const store = bothSlotsUnroutable();
    const target = resolveRoleByName(
      "reviewer",
      {
        harnessId: "claude",
        serviceId: "deepseek",
        billingMode: "key",
        modelId: "deepseek-flash",
        reasoningEffort: "max",
      },
      CLAUDE_IMPLEMENTER,
      { credentialStore: store, env: EMPTY_ENV, isInstalled: ALL_INSTALLED },
    );
    expect(target.harnessId).toBe("claude");
    expect(target.reasoningEffort).toBe("max");
    expect(target.overridden).toBe(true);
    expect(store.getReviewerPin).not.toHaveBeenCalled();
    expect(target.route).toBeUndefined();
    expect(target.reviewer).toBeUndefined();
  });

  it("fails a PARTIAL override with the ranking's own reason when the ranking fails", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const store = bothSlotsUnroutable();
    expect(() =>
      resolveRoleByName("reviewer", { reasoningEffort: "max" }, CLAUDE_IMPLEMENTER, {
        credentialStore: store,
        env: EMPTY_ENV,
        isInstalled: ALL_INSTALLED,
      }),
    ).toThrow(/neither configured reviewer has a credential that can run right now/);
    expect(store.getReviewerPin).toHaveBeenCalled();
  });

  it("completes a PARTIAL override from the ranked winner", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const store = storeWith({ routes: [ANTHROPIC_KEY, DEEPSEEK_KEY], roles: [REVIEWER] });
    const ranked = resolveRoleByName("reviewer", {}, CLAUDE_IMPLEMENTER, {
      credentialStore: store,
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    });
    const overridden = resolveRoleByName("reviewer", { reasoningEffort: "low" }, CLAUDE_IMPLEMENTER, {
      credentialStore: storeWith({ routes: [ANTHROPIC_KEY, DEEPSEEK_KEY], roles: [REVIEWER] }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    });
    expect(overridden.reasoningEffort).toBe("low");
    expect(overridden.selection).toEqual(ranked.selection);
    expect(overridden.harnessId).toBe(ranked.harnessId);
    expect(overridden.overridden).toBe(true);
  });

  it("keeps the ranked route when only the level moved, and drops it when the tuple did", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const deps = () => ({
      credentialStore: storeWith({ routes: [ANTHROPIC_KEY, DEEPSEEK_KEY], roles: [REVIEWER] }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    });
    expect(
      resolveRoleByName("reviewer", { reasoningEffort: "low" }, CLAUDE_IMPLEMENTER, deps()).route,
    ).toBeDefined();
    const moved = resolveRoleByName(
      "reviewer",
      { modelId: "deepseek-v4-pro" },
      CLAUDE_IMPLEMENTER,
      deps(),
    );
    expect(moved.selection.modelId).toBe("deepseek-v4-pro");
    expect(moved.route).toBeUndefined();
  });

  it("still re-resolves the service on a model override — plan rule (c), the `auto` branch", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const deps = () => ({
      credentialStore: storeWith({ routes: [ANTHROPIC_KEY, DEEPSEEK_KEY], roles: [REVIEWER] }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    });
    const ranked = resolveRoleByName("reviewer", {}, CLAUDE_IMPLEMENTER, deps());
    expect(ranked.selection.serviceId).toBe("deepseek");
    const moved = resolveRoleByName(
      "reviewer",
      { harnessId: "claude", modelId: "claude-opus-5" },
      CLAUDE_IMPLEMENTER,
      deps(),
    );
    expect(moved.selection).toEqual({
      serviceId: "anthropic",
      billingMode: "key",
      modelId: "claude-opus-5",
    });
  });

  it("lets an overridden run land on the implementer's own model", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const target = resolveRoleByName(
      "reviewer",
      {
        harnessId: "claude",
        serviceId: "anthropic",
        billingMode: "key",
        modelId: "claude-opus-5",
        reasoningEffort: "high",
      },
      CLAUDE_IMPLEMENTER,
      {
        credentialStore: storeWith({ routes: [ANTHROPIC_KEY, DEEPSEEK_KEY], roles: [REVIEWER] }),
        env: EMPTY_ENV,
        isInstalled: ALL_INSTALLED,
      },
    );
    expect(target.selection.modelId).toBe("claude-opus-5");
    expect(target.harnessId).toBe(CLAUDE_IMPLEMENTER.harnessId);
    expect(target.overridden).toBe(true);
  });

  it("refuses an incoherent override on the reviewer exactly as on a pinned role", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const pinned = pinnedRole("deep-dive", DEEPSEEK_ON_CLAUDE);
    const deps = () => ({
      credentialStore: storeWith({ routes: [DEEPSEEK_KEY], roles: [REVIEWER, pinned] }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    });
    const override = {
      harnessId: "claude" as const,
      serviceId: "deepseek",
      billingMode: "key" as const,
      modelId: "deepseek-flash",
      reasoningEffort: "minimal",
    };
    const messages = ["reviewer", "deep-dive"].map((name) => {
      try {
        resolveRoleByName(name, override, CLAUDE_IMPLEMENTER, deps());
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    });
    expect(messages.every((m) => typeof m === "string")).toBe(true);
    for (const message of messages) {
      expect(message).toContain("minimal");
      expect(message).toContain("Claude Code");
    }
    expect(messages[0]?.replace("reviewer", "ROLE")).toBe(
      messages[1]?.replace("deep-dive", "ROLE"),
    );
  });
});

describe("buildRoleSettings — the server sends the resolution", () => {
  it("carries the reviewer with no `resolved`, since its params are two ranked slots", async () => {
    const { buildRoleSettings } = await import("./roles.js");
    const views = buildRoleSettings({
      credentialStore: storeWith({ routes: [DEEPSEEK_KEY], roles: [REVIEWER] }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    });
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ name: "reviewer", reserved: true });
    expect(views[0].resolved).toBeUndefined();
    expect(views[0].unavailableReason).toBeUndefined();
  });

  it("resolves a pinned role to its harness, model and level", async () => {
    const { buildRoleSettings } = await import("./roles.js");
    const views = buildRoleSettings({
      credentialStore: storeWith({
        routes: [DEEPSEEK_KEY],
        roles: [pinnedRole("deep-dive", DEEPSEEK_ON_CLAUDE, { description: "The thorough one" })],
      }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    });
    expect(views[0]).toMatchObject({
      name: "deep-dive",
      description: "The thorough one",
      reserved: false,
      resolved: {
        harnessId: "claude",
        harnessName: "Claude Code",
        serviceName: "DeepSeek",
        label: "V4.1 Flash",
        reasoningEffort: "high",
      },
    });
  });
});

describe("resolveRoleView — the three ways a role cannot run", () => {
  const ROLE_ON_ANTHROPIC_SUB = pinnedRole("deep-dive", {
    harnessId: "claude",
    serviceId: "anthropic",
    billingMode: "sub",
    modelId: "claude-opus-5",
    reasoningEffort: "high",
  });

  it("stranded — the model is gone, so it needs a Settings edit and names the field", async () => {
    const { resolveRoleView } = await import("./roles.js");
    const role = pinnedRole("deep-dive", { ...DEEPSEEK_ON_CLAUDE, modelId: "gone" });
    const view = resolveRoleView(role, {
      credentialStore: storeWith({ routes: [DEEPSEEK_KEY], roles: [role] }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    });
    expect(view.unavailableReason).toBe("stranded");
    expect(view.invalidField).toBe("model");
    expect(view.resolved).toBeUndefined();
  });

  it("disconnected — the tuple is valid and the service lost its credential", async () => {
    const { resolveRoleView } = await import("./roles.js");
    const view = resolveRoleView(ROLE_ON_ANTHROPIC_SUB, {
      credentialStore: storeWith({ routes: [], roles: [ROLE_ON_ANTHROPIC_SUB] }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    });
    expect(view.unavailableReason).toBe("disconnected");
    expect(view.invalidField).toBeUndefined();
  });

  it("separates a gone credential from a harness that could never carry the model", async () => {
    const { resolveRoleView } = await import("./roles.js");
    const impossible = pinnedRole("deep-dive", {
      harnessId: "codex",
      serviceId: "anthropic",
      billingMode: "sub",
      modelId: "claude-opus-5",
      reasoningEffort: "high",
    });
    const view = resolveRoleView(impossible, {
      credentialStore: storeWith({ routes: [], roles: [impossible] }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    });
    expect(view.unavailableReason).toBe("stranded");
    expect(view.invalidField).toBe("harnessId");
  });

  it("names the BILLING MODE when the service no longer offers it", async () => {
    const { resolveRoleView } = await import("./roles.js");
    const gone = pinnedRole("deep-dive", { ...DEEPSEEK_ON_CLAUDE, billingMode: "sub" });
    const view = resolveRoleView(gone, {
      credentialStore: storeWith({ routes: [DEEPSEEK_KEY], roles: [gone] }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    });
    expect(view.unavailableReason).toBe("stranded");
    expect(view.invalidField).toBe("billingMode");
  });

  it("reports the editable fault, not the credential one, when a role has both", async () => {
    const { resolveRoleView } = await import("./roles.js");
    const broken = pinnedRole("deep-dive", { ...DEEPSEEK_ON_CLAUDE, reasoningEffort: "none" });
    const view = resolveRoleView(broken, {
      credentialStore: storeWith({ routes: [], roles: [broken] }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    });
    expect(view.unavailableReason).toBe("stranded");
    expect(view.invalidField).toBe("reasoningEffort");
  });

  it("names the SERVICE, not the model, when a service leaves the catalogue", async () => {
    const { resolveRoleView } = await import("./roles.js");
    const gone = pinnedRole("deep-dive", { ...DEEPSEEK_ON_CLAUDE, serviceId: "no-such-service" });
    const view = resolveRoleView(gone, {
      credentialStore: storeWith({ routes: [DEEPSEEK_KEY], roles: [gone] }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    });
    expect(view.unavailableReason).toBe("stranded");
    expect(view.invalidField).toBe("service");
  });

  it("quota_exhausted — the subscription is spent, and it says when to retry", async () => {
    const { resolveRoleView } = await import("./roles.js");
    const view = resolveRoleView(ROLE_ON_ANTHROPIC_SUB, {
      credentialStore: storeWith({ routes: [ANTHROPIC_ACCOUNT], roles: [ROLE_ON_ANTHROPIC_SUB] }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
      providerAccountManager: {
        selectAccountForTurn: () => ({
          ok: false as const,
          reason: "all_exhausted" as const,
          earliestResetAt: "2026-08-15T18:00:00.000Z",
        }),
        subscriptionLimitsFor: () => ({}),
      },
    });
    expect(view.unavailableReason).toBe("quota_exhausted");
    expect(view.earliestResetAt).toBe("2026-08-15T18:00:00.000Z");
    expect(view.invalidField).toBeUndefined();
  });
});

describe("joinRolePrompt (req 8)", () => {
  it("labels both halves so the callee can tell a standing brief from the task", async () => {
    const { joinRolePrompt } = await import("./roles.js");
    const joined = joinRolePrompt(
      "Review PR 12.",
      { roleName: "deep dive", rolePrompt: "Check against requirements.md." },
      200_000,
    );
    expect(joined).toContain("deep dive");
    expect(joined).toContain("Check against requirements.md.");
    expect(joined).toContain("Your task");
    expect(joined).toContain("Review PR 12.");
    expect(joined.indexOf("Check against")).toBeLessThan(joined.indexOf("Review PR 12."));
  });

  it("returns the task unchanged — byte for byte — when the role carries nothing", async () => {
    const { joinRolePrompt } = await import("./roles.js");
    const task = "Review PR 12.\n\n## Not a heading of ours\n";
    expect(joinRolePrompt(task, { roleName: "plain" }, 200_000)).toBe(task);
    expect(joinRolePrompt(task, {}, 200_000)).toBe(task);
    expect(joinRolePrompt(task, { roleName: "plain", rolePrompt: "   \n" }, 200_000)).toBe(task);
  });

  it("checks the COMBINED length and names the role in the refusal", async () => {
    const { joinRolePrompt } = await import("./roles.js");
    const task = "x".repeat(60);
    expect(() => joinRolePrompt(task, {}, 100)).not.toThrow();
    expect(() =>
      joinRolePrompt(task, { roleName: "deep dive", rolePrompt: "y".repeat(60) }, 100),
    ).toThrow(/deep dive/);
  });

  it("still refuses an over-long task when no role is involved", async () => {
    const { joinRolePrompt } = await import("./roles.js");
    expect(() => joinRolePrompt("x".repeat(200), {}, 100)).toThrow(/exceeds/);
  });
});
