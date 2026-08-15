import { describe, it, expect, vi } from "vitest";
import type { AgentRole, CredentialRoute, ReviewerPin, ReviewerSlot } from "../../shared/types.js";

/**
 * docs/264 phase 1 (reqs 1, 2, 6, 7, 9, 10, 13) — the harness-explicit validator
 * and `resolveRoleByName`.
 *
 * **Driven against the real catalogue**, like `reviewer-model.test.ts` and
 * `non-turn-model.test.ts`: the rules here are statements about which models
 * reach which harness and which levels each harness declares, so a fabricated
 * catalogue would let them pass and disagree with what ShipIt does.
 *
 * The dual-harness case that used to need fabricating is **real**:
 * `deepseek-v4-flash` and `deepseek-v4-pro` declare `[openai-chat-completions,
 * openai-responses, anthropic-messages]`, and `resolveStyle` needs one style in
 * common — so both harnesses carry them. Their level sets differ (`max` is
 * Claude Code's and not Codex's; `none` and `minimal` are Codex's and not
 * Claude Code's), which is exactly the pair the validator has to tell apart.
 * docs/261's plan said no shipped model was dual-harness; that stopped being
 * true and the row is now the fixture.
 *
 * Every test passes `env: {}`. Reading the real `process.env` would let a
 * deployment-supplied `ANTHROPIC_API_KEY` on the test host add a credential the
 * fixture never configured.
 */

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
  /** A `via: "string"` route whose secret is missing reads as unconfigured, so this is explicit. */
  secretless?: string[];
}

function storeWith(opts: FakeStoreOpts = {}) {
  const routes = opts.routes ?? [];
  const roles = opts.roles ?? [];
  const secretless = new Set(opts.secretless ?? []);
  const getReviewerPin = vi.fn((slot: ReviewerSlot) => opts.pins?.[slot]);
  return {
    getReviewerPin,
    // docs/264 — the reviewer is synthesized by the real store; these fakes
    // model the result rather than the synthesis, which `credential-store.test.ts`
    // owns.
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

/** Every harness installed — the default `isHarnessInstalled` answer with no install report. */
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
  modelId: "deepseek-v4-flash",
  reasoningEffort: "high",
};

// ---- The harness-explicit validator (reqs 6, 7) -----------------------------

describe("checkRolePinnedParams — the level follows the harness the ROLE names (req 6)", () => {
  it("refuses a Claude-only level on a role that names Codex, for a model both carry", async () => {
    const { checkRolePinnedParams } = await import("./roles.js");
    const result = checkRolePinnedParams(
      { kind: "pinned", ...DEEPSEEK_ON_CLAUDE, harnessId: "codex", reasoningEffort: "max" },
      { credentialStore: storeWith({ routes: [DEEPSEEK_KEY] }), env: EMPTY_ENV, isInstalled: ALL_INSTALLED },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("reasoningEffort");
    expect(result.message).toContain("max");
  });

  it("accepts the same Claude-only level when the role names Claude Code", async () => {
    const { checkRolePinnedParams } = await import("./roles.js");
    const result = checkRolePinnedParams(
      { kind: "pinned", ...DEEPSEEK_ON_CLAUDE, reasoningEffort: "max" },
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

  /**
   * The bullet this file exists for: the validator must NOT be
   * `resolveReviewerPinPatch`.
   *
   * That function derives a harness (`harnessesForSelection(patch, …)[0]`,
   * catalogue order ⇒ Claude Code) and validates the level against whichever it
   * picked — so the *same* tuple it accepts here is one the role validator
   * refuses for Codex. Asserting both halves in one test is what makes the
   * difference impossible to lose: delete the harness input from the role
   * validator and this test goes red on the first expectation, not on a
   * hypothetical future catalogue.
   */
  it("differs from resolveReviewerPinPatch, which derives the harness and validates against that", async () => {
    const { checkRolePinnedParams } = await import("./roles.js");
    const { resolveReviewerPinPatch } = await import("./reviewer-settings.js");
    const store = storeWith({ routes: [DEEPSEEK_KEY] });
    const triple = {
      serviceId: "deepseek",
      billingMode: "key" as const,
      modelId: "deepseek-v4-flash",
      reasoningEffort: "max",
    };

    // The reviewer path accepts it: it derives Claude Code, which declares `max`.
    expect(resolveReviewerPinPatch(triple, store, EMPTY_ENV).reasoningEffort).toBe("max");

    // The role path, told the harness is Codex, refuses the very same tuple.
    const asRole = checkRolePinnedParams(
      { kind: "pinned", harnessId: "codex", ...triple },
      { credentialStore: store, env: EMPTY_ENV, isInstalled: ALL_INSTALLED },
    );
    expect(asRole.ok).toBe(false);
    if (!asRole.ok) expect(asRole.field).toBe("reasoningEffort");
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
    // Anthropic's models declare only `anthropic-messages`; Codex speaks only
    // `openai-responses`.
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
    // `gpt-5.6` is retired in favour of `gpt-5.6-sol`. A reviewer pin follows
    // that successor; a role reports that it cannot run and needs an edit.
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

/**
 * The validator checks **compatibility**, never live route availability.
 *
 * Named for what it exercises: `checkRolePinnedParams`, not `setRole`. The store
 * deliberately does not validate (it has no credentials to validate against) and
 * wiring this validator into the settings mutation surface is phase 2's own
 * checklist bullet — so a title mentioning "saving" would claim a path this
 * phase does not build. Cross-agent review caught the earlier title doing that.
 */
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
    // Compatibility holds — the tuple is still a real, carryable, credentialed row…
    expect(checkRolePinnedParams(role.params as never, deps).ok).toBe(true);
    // …while the *run* is reported as a clock problem, not a role problem.
    const view = resolveRoleView(role, deps);
    expect(view.unavailableReason).toBe("quota_exhausted");
    expect(view.earliestResetAt).toBe("2026-08-15T18:00:00.000Z");
  });

  /**
   * The purpose split, in both directions and on one tuple: a **save** must not
   * refuse a role for a credential this install does not hold (that is the
   * service's state, reported as `disconnected` with "reconnect the service" as
   * the remedy — so refusing the write made a disconnected role uneditable),
   * while a **run** must, because there is nothing to authenticate it with.
   */
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
    // `max` is Claude Code's level and not Codex's. Both faults at once, and the
    // editable one is still what a save reports — the ordering is untouched.
    const broken = pinnedRole("deep-dive", {
      ...DEEPSEEK_ON_CLAUDE,
      harnessId: "codex",
      reasoningEffort: "max",
    }).params as never;
    const checked = checkRolePinnedParams(broken, deps, "save");
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.kind).toBe("catalogue");
      expect(checked.field).toBe("reasoningEffort");
    }
  });
});

// ---- resolveRoleByName (reqs 10, 13) ---------------------------------------

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
      modelId: "deepseek-v4-flash",
    });
    expect(target.prompt).toBe("Check requirements.");
    expect(target.roleName).toBe("deep-dive");
    expect(target.overridden).toBe(false);
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

  /**
   * **Reverses a behaviour this suite previously pinned** (planning#388,
   * finding 1). The old test asserted that a role pinned to DeepSeek, invoked
   * with only `--model claude-opus-5`, relocated to `anthropic/key`. That is
   * two parameters the caller never named, changed invisibly — the substitution
   * req 7 forbids, and "the role supplies everything not overridden" (req 10)
   * read literally forbids it too.
   *
   * The relocation rule it came from (`plan.md` rule (c)) is sound *where it was
   * written*: the `auto` branch, where the base is a reviewer **slot pin** —
   * ShipIt's own working state for a ranking it performs. It was generalised to
   * pinned roles, where the base is five choices the user made and can see. The
   * test below this one holds rule (c) in place for the reviewer.
   */
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
    // Actionable, not just correct: the refusal names the flag that fixes it and
    // where the model actually lives (req 12's inventory, in the message).
    expect(() =>
      resolveRoleByName(
        "deep-dive",
        { modelId: "claude-opus-5" },
        CLAUDE_IMPLEMENTER,
        deps([pinnedRole("deep-dive", DEEPSEEK_ON_CLAUDE)]),
      ),
    ).toThrow(/Name --service as well; .* offered on anthropic\/sub, anthropic\/key/s);
  });

  /**
   * **Closes the loop the refusal opens**: doing exactly what the message says —
   * adding the one flag it named, and nothing else — has to work. Asserted
   * separately from the "names the service alongside it" test below, which
   * supplies *both* halves of the location and so cannot show that the suggested
   * `--service` alone is sufficient.
   *
   * The billing mode still comes from the role, which is the point: `key` was
   * never overridden and is not moved.
   */
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

  /**
   * The refusal names a flag only where naming it would help. A caller that has
   * already said the whole location has nothing left to add, so the message is
   * the **shared validator's** — the one a Settings save reports too — rather
   * than advice to restate a flag they set.
   */
  it("leaves a fully-named but incoherent location to the shared validator", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const attempt = () =>
      resolveRoleByName(
        "deep-dive",
        { serviceId: "anthropic", billingMode: "sub", modelId: "deepseek-v4-flash" },
        CLAUDE_IMPLEMENTER,
        deps([pinnedRole("deep-dive", DEEPSEEK_ON_CLAUDE)]),
      );
    expect(attempt).toThrow(
      /cannot run: No model "deepseek-v4-flash" is offered by anthropic on the "sub" billing mode\./,
    );
    expect(attempt).not.toThrow(/Name --/);
  });

  /**
   * The refusal asks for the **smallest** set of flags that actually reaches the
   * model, which is what keeps it advice rather than boilerplate. `zai` offers
   * `glm-5.2` on `key` only and `glm-5.2[1m]` on `sub` only — the same service
   * both times — so the service is already right and only the billing mode has
   * to move.
   */
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
    // `max` is Claude Code's; the override moves the role onto Codex.
    expect(() =>
      resolveRoleByName(
        "deep-dive",
        { harnessId: "codex", reasoningEffort: "max" },
        CLAUDE_IMPLEMENTER,
        deps([role]),
      ),
    ).toThrow(/max.*not a reasoning level Codex offers|Codex/);
    // And it is refused rather than silently run at the role's own level.
    expect(() =>
      resolveRoleByName("deep-dive", { harnessId: "codex", reasoningEffort: "max" }, CLAUDE_IMPLEMENTER, deps([role])),
    ).toThrow(/cannot run/);
  });

  /**
   * The other fall-through: no service offers the model **at all**, so naming
   * `--service` would not help and pointing at one would be false.
   *
   * Asserted against the shared validator's exact message rather than a loose
   * `/No model/`, which the old relocating `locateModel` also matched — the
   * looser form could not tell which of the two produced the refusal.
   */
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

  /**
   * The symmetry that stops the override path being a hole in req 6: every tuple
   * `--role X --model Y` can reach passes the *same* validator a save is gated
   * on.
   *
   * Stated precisely, because cross-agent review pointed out two stronger
   * readings this cannot support. It does **not** prove the resolver *called*
   * the validator — only that its output satisfies it — and since the two share
   * one implementation, a defect present in both is invisible here. What it does
   * catch is the failure that actually threatens req 6: an override that lands
   * on a tuple no role could have been configured to hold.
   */
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
    // The implementer is Opus on Claude Code; the ranking must not hand the
    // review back to the same model.
    expect(target.selection.modelId).not.toBe("claude-opus-5");
    expect(target.overridden).toBe(false);
    // A ranked reviewer arrives already routed — docs/261's rule that the spawn
    // must not re-ask a settled question.
    expect(target.route).toBeDefined();
    expect(target.reviewer?.slot).toBeDefined();
    expect(store.getReviewerPin).toHaveBeenCalled();
  });

  /**
   * docs/261's two-slot ranking must survive **intact** behind the `auto`
   * branch. Asserted by comparing against `selectReviewer`'s own answer rather
   * than against a value typed out here — a hand-written expectation would keep
   * passing while the two drifted apart.
   *
   * Titled for the fields it actually compares, not "everything". `ReviewerTarget`
   * also carries `serviceName`, which `ResolvedRoleTarget` deliberately does not:
   * it is a display label derivable from `selection.serviceId`, and the settings
   * view computes it in `describe()` rather than the spawn target carrying a
   * second copy to drift.
   */
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
    // Including the spawn shaping and the secret behind it — an "unchanged"
    // claim that compared only the model would pass while the environment the
    // review authenticates with silently went missing.
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

/**
 * The fixture the checklist names: **both reviewer slots unroutable**.
 *
 * Both slots are pinned to an Anthropic model while the only credential is a
 * DeepSeek key, so each resolves to `pin_unavailable` and `selectReviewer`
 * returns `no_reviewer_available`. That is what makes the next two tests able to
 * fail: a complete override must resolve *anyway*, and a partial one must fail
 * with the ranking's own reason.
 */
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
        modelId: "deepseek-v4-flash",
        reasoningEffort: "max",
      },
      CLAUDE_IMPLEMENTER,
      { credentialStore: store, env: EMPTY_ENV, isInstalled: ALL_INSTALLED },
    );
    expect(target.harnessId).toBe("claude");
    expect(target.reasoningEffort).toBe("max");
    expect(target.overridden).toBe(true);
    // The observable proof that `selectReviewer` never ran: `slotPlans` reads
    // both pins on every call, so an untouched spy means no ranking happened.
    // Ranking first would have thrown `no_reviewer_available` and rejected a
    // target the caller fully specified.
    expect(store.getReviewerPin).not.toHaveBeenCalled();
    // Nothing routed it, so no route is carried — the spawn resolves its own.
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
    // Only the level moved; everything else came from the winner.
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
    // A level override leaves the ranked triple and harness exactly as resolved,
    // so the route it was resolved for still applies.
    expect(
      resolveRoleByName("reviewer", { reasoningEffort: "low" }, CLAUDE_IMPLEMENTER, deps()).route,
    ).toBeDefined();
    // A model override moves the tuple, so the ranked route was resolved for
    // something else and must not be carried onto it. `deepseek-v4-pro` is the
    // sibling of whatever the ranking picked — carryable by the same harness, so
    // the call succeeds and the assertion is about the route rather than about a
    // refusal.
    const moved = resolveRoleByName(
      "reviewer",
      { modelId: "deepseek-v4-pro" },
      CLAUDE_IMPLEMENTER,
      deps(),
    );
    expect(moved.selection.modelId).toBe("deepseek-v4-pro");
    expect(moved.route).toBeUndefined();
  });

  /**
   * **The behaviour planning#388's fix must NOT break**, pinned here because
   * without a test the next person will "fix" it too.
   *
   * `plan.md` rule (c) — overriding the model replaces the
   * `(service, billing mode, model)` triple as a whole and re-resolves where
   * that model lives — is written for **this** branch, and stays. The base here
   * is a reviewer slot pin: ShipIt's own working state for a ranking it
   * performs, and a slot pinned *for model M* says nothing about model X, so
   * there is no surviving user decision to honour. A **pinned role** is the
   * opposite case — five choices the user made and can see — and refuses; see
   * "refuses a model the role's service does not offer".
   */
  it("still re-resolves the service on a model override — plan rule (c), the `auto` branch", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const deps = () => ({
      credentialStore: storeWith({ routes: [ANTHROPIC_KEY, DEEPSEEK_KEY], roles: [REVIEWER] }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    });
    // The ranking runs away from the Anthropic implementer, so the winner it
    // completes from is on DeepSeek — which is what makes the relocation
    // observable rather than a no-op.
    const ranked = resolveRoleByName("reviewer", {}, CLAUDE_IMPLEMENTER, deps());
    expect(ranked.selection.serviceId).toBe("deepseek");
    // A PARTIAL override, so it cannot take the complete-override shortcut and
    // genuinely completes from the ranked winner. The harness is named alongside
    // the model to keep the tuple carryable whichever harness the ranking picked;
    // neither the service nor the billing mode is named, and those are what the
    // assertion is about. `claude-opus-5` lives on Anthropic and nowhere else, so
    // honouring it means moving the service the ranking had chosen.
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

  /**
   * Req 10's second paragraph, and the receipt of 2026-08-15: once the caller
   * overrides the reviewer, no promise survives that the review runs on anything
   * different. This is the requirement, not a bug to be fixed later — so the
   * test asserts the override is **honoured**, not refused or re-ranked.
   */
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

  /**
   * "Refused naming the parameter, **on every params kind alike**" — so the test
   * compares the two paths rather than asserting one of them loosely. An earlier
   * version checked only the reviewer, and only for `/cannot run/`, which a
   * re-derivation branch for the reviewer would have passed.
   */
  it("refuses an incoherent override on the reviewer exactly as on a pinned role", async () => {
    const { resolveRoleByName } = await import("./roles.js");
    const pinned = pinnedRole("deep-dive", DEEPSEEK_ON_CLAUDE);
    const deps = () => ({
      credentialStore: storeWith({ routes: [DEEPSEEK_KEY], roles: [REVIEWER, pinned] }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    });
    // The same incoherent override — `max` is not a level Codex declares —
    // aimed at each params kind in turn.
    const override = {
      harnessId: "codex" as const,
      serviceId: "deepseek",
      billingMode: "key" as const,
      modelId: "deepseek-v4-flash",
      reasoningEffort: "max",
    };
    const messages = ["reviewer", "deep-dive"].map((name) => {
      try {
        resolveRoleByName(name, override, CLAUDE_IMPLEMENTER, deps());
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    });
    // Both refused…
    expect(messages.every((m) => typeof m === "string")).toBe(true);
    // …both naming the parameter at fault and the harness it is wrong for…
    for (const message of messages) {
      expect(message).toContain("max");
      expect(message).toContain("Codex");
    }
    // …and identically apart from the role's own name, which is the "exactly as"
    // the requirement asks for.
    expect(messages[0]?.replace("reviewer", "ROLE")).toBe(
      messages[1]?.replace("deep-dive", "ROLE"),
    );
  });
});

// ---- The settings projection ------------------------------------------------

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
        label: "V4 Flash",
        reasoningEffort: "high",
      },
    });
  });
});

/**
 * **Three failure states, not two.** The remedy differs in each, so collapsing
 * them sends the user to the wrong place: `stranded` needs a Settings edit,
 * `disconnected` needs the *service* reconnected and the role left alone, and
 * `quota_exhausted` needs nothing at all.
 */
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

  /**
   * **No stub.** The user removed the service, so the install holds no
   * credential at all — the ordinary way a role stops working, and the case the
   * requirement describes.
   *
   * An earlier version of this test manufactured `auth_required` from a stubbed
   * account manager while a ready account row sat in the store, a combination
   * the real manager does not produce; cross-agent review caught that it proved
   * only the mapping. It also found the defect underneath: with the credential
   * genuinely gone, `isSelectionEligible` fails first and the role was reported
   * `stranded` — telling the user to edit a role that is entirely correct, which
   * is the advice the requirement expressly rules out.
   */
  it("disconnected — the tuple is valid and the service lost its credential", async () => {
    const { resolveRoleView } = await import("./roles.js");
    const view = resolveRoleView(ROLE_ON_ANTHROPIC_SUB, {
      // No routes: the credential this role names is simply gone.
      credentialStore: storeWith({ routes: [], roles: [ROLE_ON_ANTHROPIC_SUB] }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    });
    expect(view.unavailableReason).toBe("disconnected");
    // Deliberately NOT `stranded`, and deliberately NO field to highlight: the
    // role is correct, and the remedy is to reconnect the service.
    expect(view.invalidField).toBeUndefined();
  });

  it("separates a gone credential from a harness that could never carry the model", async () => {
    const { resolveRoleView } = await import("./roles.js");
    // Same missing-credential story, but the tuple itself is also impossible —
    // Codex speaks only `openai-responses` and Anthropic's models only
    // `anthropic-messages`. That is a catalogue fact, so it is the role's fault
    // and an edit is the remedy.
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
    // DeepSeek ships a `key` mode and no `sub` mode.
    const gone = pinnedRole("deep-dive", { ...DEEPSEEK_ON_CLAUDE, billingMode: "sub" });
    const view = resolveRoleView(gone, {
      credentialStore: storeWith({ routes: [DEEPSEEK_KEY], roles: [gone] }),
      env: EMPTY_ENV,
      isInstalled: ALL_INSTALLED,
    });
    expect(view.unavailableReason).toBe("stranded");
    expect(view.invalidField).toBe("billingMode");
  });

  /**
   * Two faults at once: the credential is gone **and** the level is one the
   * harness no longer declares. The tuple fault wins, because `disconnected`
   * says "reconnect the service and leave the role alone" — advice that would
   * not have fixed this role.
   */
  it("reports the editable fault, not the credential one, when a role has both", async () => {
    const { resolveRoleView } = await import("./roles.js");
    // `none` is Codex's level, not Claude Code's; and there are no routes.
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
    // Rule (d): the refusal names the parameter. Blaming the model would send
    // the editor to highlight a field that is perfectly correct.
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

/**
 * docs/264 phase 3 (req 8) — the prompt join.
 *
 * A sub-agent has ONE prompt channel (docs/144), so a role's standing
 * instructions and the run's own task have to become one string. Three
 * properties, and the middle one is the easiest to lose: the halves are
 * labelled, a role with no instructions changes nothing at all, and the length
 * check runs on the COMBINED string with the role named in the failure.
 */
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
    // Order matters: the standing brief frames the task, not the other way round.
    expect(joined.indexOf("Check against")).toBeLessThan(joined.indexOf("Review PR 12."));
  });

  it("returns the task unchanged — byte for byte — when the role carries nothing", async () => {
    const { joinRolePrompt } = await import("./roles.js");
    const task = "Review PR 12.\n\n## Not a heading of ours\n";
    expect(joinRolePrompt(task, { roleName: "plain" }, 200_000)).toBe(task);
    expect(joinRolePrompt(task, {}, 200_000)).toBe(task);
    // Whitespace-only instructions are nothing, not a header with a blank body.
    expect(joinRolePrompt(task, { roleName: "plain", rolePrompt: "   \n" }, 200_000)).toBe(task);
  });

  /**
   * The failure names the ROLE. A stored prompt is bounded at save and a task can
   * be valid on its own, so the pair going over is a fact about the join —
   * blaming the task would send the caller to shorten the one half it did not
   * write and cannot see.
   */
  it("checks the COMBINED length and names the role in the refusal", async () => {
    const { joinRolePrompt } = await import("./roles.js");
    const task = "x".repeat(60);
    // The task alone fits; the pair does not.
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
