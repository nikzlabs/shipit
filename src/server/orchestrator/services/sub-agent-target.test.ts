/**
 * docs/261 phase 2 (reqs 6, 7) — what a one-shot spawn runs on.
 *
 * Two properties carry the whole design, and both are refusals:
 *
 *  - an **incomplete explicit call is refused**, never completed from a stored
 *    default the caller cannot see — the failure mode `SubAgentDefaults` was;
 *  - a **role and an explicit parameter cannot be combined**, because asking for
 *    a review and naming a reviewer are two different questions (req 6).
 *
 * The role path drives the **real** catalogue and the real reviewer resolver
 * rather than a fixture, for `reviewer-model.test.ts`'s reason: which model
 * reaches which harness is a statement about that catalogue, so a fixture could
 * pass here and disagree with what ShipIt does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CredentialRoute, ReviewerPin, ReviewerSlot } from "../../shared/types.js";
import { ServiceError } from "./types.js";

function route(serviceId: string, billingMode: "sub" | "key"): CredentialRoute {
  return {
    serviceId,
    billingMode,
    id: `${serviceId}-${billingMode}`,
    via: "string",
    status: "ready",
    priority: 0,
    isPrimary: true,
    label: "test",
    createdAt: 0,
    updatedAt: 0,
  };
}

function storeWith(routes: CredentialRoute[], pins: Partial<Record<ReviewerSlot, ReviewerPin>> = {}) {
  return {
    getReviewerPin: (slot: ReviewerSlot) => pins[slot],
    listCredentialRoutes: (serviceId?: string, billingMode?: string) =>
      routes.filter(
        (r) =>
          (serviceId === undefined || r.serviceId === serviceId)
          && (billingMode === undefined || r.billingMode === billingMode),
      ),
    getCredentialSecret: (id: string) => (routes.some((r) => r.id === id) ? "sk-test" : undefined),
    getSelectionMode: () => "strict" as const,
    getCredentialRoute: (id: string) => routes.find((r) => r.id === id),
    // docs/252 follow-up — the string-delivered walk applies the user's
    // cutoffs, so its credential source carries them. Default: nothing set.
    getFailoverCutoffs: () => ({ session: 90, weekly: 90 }),
  };
}

const OPENAI_KEY = route("openai", "key");
const ANTHROPIC_KEY = route("anthropic", "key");
const DEEPSEEK_KEY = route("deepseek", "key");

/** A complete explicit body — the baseline each refusal removes one field from. */
const FULL = {
  agentId: "codex",
  serviceId: "openai",
  billingMode: "sub",
  modelId: "gpt-5.6-sol",
  reasoningEffort: "high",
};

describe("parseSubAgentSpawnTarget — the explicit path (req 7)", () => {
  it("accepts a call that names every parameter", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    // The body names `agentId` (the wire's own word for the harness); the
    // parsed target names `subAgentId`, matching the spawn's vocabulary.
    expect(parseSubAgentSpawnTarget(FULL)).toEqual({
      kind: "explicit",
      subAgentId: "codex",
      serviceId: "openai",
      billingMode: "sub",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
  });

  /**
   * The refusal the feature exists for. Each of the five is load-bearing:
   * `--model` alone cannot say which credential pays for a model two services
   * offer (req 3), and the effort is part of the reviewer rather than the
   * harness's own default (req 5).
   */
  for (const field of ["agentId", "serviceId", "billingMode", "modelId", "reasoningEffort"]) {
    it(`refuses a call missing ${field} rather than filling it in`, async () => {
      const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
      const body: Record<string, unknown> = Object.fromEntries(
        Object.entries(FULL).filter(([key]) => key !== field),
      );
      expect(() => parseSubAgentSpawnTarget(body)).toThrow(ServiceError);
      try {
        parseSubAgentSpawnTarget(body);
      } catch (err) {
        expect((err as ServiceError).statusCode).toBe(400);
        expect((err as ServiceError).message).toContain("missing");
      }
    });
  }

  it("names every missing flag at once, so one round trip fixes the call", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    try {
      parseSubAgentSpawnTarget({ agentId: "codex" });
      throw new Error("expected a refusal");
    } catch (err) {
      const message = (err as ServiceError).message;
      for (const flag of ["--service", "--billing-mode", "--model", "--effort"]) {
        expect(message).toContain(flag);
      }
      expect(message).not.toContain("--agent,");
    }
  });

  it("treats a blank string as absent — a quoted empty flag is not an answer", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() => parseSubAgentSpawnTarget({ ...FULL, reasoningEffort: "  " })).toThrow(ServiceError);
  });

  it("refuses a billing mode that is neither sub nor key", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() => parseSubAgentSpawnTarget({ ...FULL, billingMode: "free" })).toThrow(/sub/);
  });
});

describe("parseSubAgentSpawnTarget — the role path (req 6)", () => {
  it("accepts a role on its own", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(parseSubAgentSpawnTarget({ role: "reviewer" })).toEqual({
      kind: "role",
      role: "reviewer",
    });
  });

  // Naming a role AND a reviewer is asking two different questions; the design
  // separates them rather than letting one silently win. The harness, service
  // and billing mode are resolved by ShipIt, so they cannot ride the role; the
  // two docs/263 overrides (model, effort) can, as per-review choices.
  for (const [field, flag] of [
    ["agentId", "--agent"],
    ["serviceId", "--service"],
    ["billingMode", "--billing-mode"],
  ]) {
    it(`refuses a role combined with ${flag}`, async () => {
      const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
      expect(() =>
        parseSubAgentSpawnTarget({ role: "reviewer", [field]: "whatever" }),
      ).toThrow(new RegExp(flag));
    });
  }

  it("carries a user-named model through as an override (docs/263)", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(parseSubAgentSpawnTarget({ role: "reviewer", modelId: "GPT-5.6" })).toEqual({
      kind: "role",
      role: "reviewer",
      modelName: "GPT-5.6",
    });
  });

  it("carries a user-named reasoning level through as an override (docs/263)", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(parseSubAgentSpawnTarget({ role: "reviewer", reasoningEffort: "high" })).toEqual({
      kind: "role",
      role: "reviewer",
      reasoningEffort: "high",
    });
  });

  it("carries both overrides together (docs/263)", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(
      parseSubAgentSpawnTarget({ role: "reviewer", modelId: "GPT-5.6", reasoningEffort: "high" }),
    ).toEqual({ kind: "role", role: "reviewer", modelName: "GPT-5.6", reasoningEffort: "high" });
  });

  it("refuses an unknown role by name rather than ignoring it", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() => parseSubAgentSpawnTarget({ role: "critic" })).toThrow(/critic/);
  });

  // docs/263 req 2 — a blank override is a NAMED value that cannot run, not an
  // absence. Absence means "ShipIt resolves it"; a blank means the user named
  // nothing and must be refused rather than silently run at the default.
  it("refuses a blank override rather than silently running the default", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() => parseSubAgentSpawnTarget({ role: "reviewer", modelId: "  " })).toThrow(/blank/);
    expect(() => parseSubAgentSpawnTarget({ role: "reviewer", reasoningEffort: "" })).toThrow(
      /blank/,
    );
  });
});

describe("resolveSubAgentSpawnTarget", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../../shared/installed-harnesses.js");
  });

  const installAll = () =>
    vi.doMock("../../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => true,
      readInstalledHarnesses: () => ["claude", "codex"],
    }));

  it("takes an explicit call literally — no route, no derivation", async () => {
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    const resolved = resolveSubAgentSpawnTarget(
      {
        kind: "explicit",
        subAgentId: "codex",
        serviceId: "openai",
        billingMode: "sub",
        modelId: "gpt-5.6-sol",
        reasoningEffort: "high",
      },
      { harnessId: "claude" },
      { credentialStore: storeWith([]) },
    );
    expect(resolved.selection).toEqual({
      serviceId: "openai",
      billingMode: "sub",
      modelId: "gpt-5.6-sol",
    });
    expect(resolved.reasoningEffort).toBe("high");
    expect(resolved.route).toBeUndefined();
    expect(resolved.reviewer).toBeUndefined();
  });

  it("refuses a triple the catalogue does not carry", async () => {
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() =>
      resolveSubAgentSpawnTarget(
        {
          kind: "explicit",
          subAgentId: "codex",
          serviceId: "openai",
          billingMode: "sub",
          modelId: "gpt-9-imaginary",
          reasoningEffort: "high",
        },
        { harnessId: "claude" },
        { credentialStore: storeWith([]) },
      ),
    ).toThrow(/gpt-9-imaginary/);
  });

  // req 5 corollary — the level is named in the call, so a level the harness
  // does not offer is the caller's error. Silently dropping it (the old
  // behaviour: an unrecognized value meant "pass no flag") would run the review
  // at a level nobody chose.
  it("refuses an effort the named harness does not offer", async () => {
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() =>
      resolveSubAgentSpawnTarget(
        {
          kind: "explicit",
          subAgentId: "codex",
          serviceId: "openai",
          billingMode: "sub",
          modelId: "gpt-5.6-sol",
          reasoningEffort: "ludicrous",
        },
        { harnessId: "claude" },
        { credentialStore: storeWith([]) },
      ),
    ).toThrow(/ludicrous/);
  });

  // req 6 — the role resolves to a complete reviewer without the caller naming
  // anything, and req 4 picks the one furthest from the implementer: a Claude
  // session gets the GPT reviewer, on the other harness.
  it("resolves a role to the reviewer furthest from the implementer", async () => {
    installAll();
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    const resolved = resolveSubAgentSpawnTarget(
      { kind: "role", role: "reviewer" },
      {
        harnessId: "claude",
        selection: { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" },
      },
      { credentialStore: storeWith([OPENAI_KEY, ANTHROPIC_KEY]), env: {} },
    );
    expect(resolved.harnessId).toBe("codex");
    expect(resolved.selection.serviceId).toBe("openai");
    // req 5 — complete: a reviewer always carries a level.
    expect(resolved.reasoningEffort).toBeTruthy();
    // "resolved once, at spawn admission" — the route is captured here, not
    // re-derived by the spawn.
    expect(resolved.route).toBeDefined();
    expect(resolved.reviewer?.tier).toBe(1);
    expect(resolved.reviewer?.tierBasis).toBe("model-and-harness");
  });

  // The implementer is what the ranking is computed against, so the SAME install
  // must answer differently for a Codex session — with no editing in between
  // (req 4's "reviewing works whichever model is implementing").
  it("picks a different reviewer for a different implementer, with nothing reconfigured", async () => {
    installAll();
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    const deps = { credentialStore: storeWith([OPENAI_KEY, DEEPSEEK_KEY]), env: {} };
    const forClaude = resolveSubAgentSpawnTarget(
      { kind: "role", role: "reviewer" },
      { harnessId: "claude", selection: { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4" } },
      deps,
    );
    const forCodex = resolveSubAgentSpawnTarget(
      { kind: "role", role: "reviewer" },
      { harnessId: "codex", selection: { serviceId: "openai", billingMode: "key", modelId: "gpt-5.6-sol" } },
      deps,
    );
    expect(forClaude.harnessId).toBe("codex");
    expect(forCodex.harnessId).toBe("claude");
  });

  // Eligible is not runnable: with no credential at all, nothing routes, and the
  // review STOPS and says so rather than spawning something that cannot run.
  it("refuses a role when no reviewer has a usable credential", async () => {
    installAll();
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() =>
      resolveSubAgentSpawnTarget(
        { kind: "role", role: "reviewer" },
        { harnessId: "claude" },
        { credentialStore: storeWith([]), env: {} },
      ),
    ).toThrow(/No reviewer is available/);
  });

  // ---- docs/263 — the role carries a model and/or effort the user named ----

  // reqs 1–3 — the named model is resolved against the real catalogue and the
  // install: ShipIt picks the service, billing mode and harness, and captures
  // the route here so the card can report who paid.
  it("resolves a user-named model to a routed reviewer (docs/263)", async () => {
    installAll();
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    const resolved = resolveSubAgentSpawnTarget(
      { kind: "role", role: "reviewer", modelName: "GPT-5.6 Sol" },
      { harnessId: "claude" },
      { credentialStore: storeWith([OPENAI_KEY, ANTHROPIC_KEY]), env: {} },
    );
    expect(resolved.harnessId).toBe("codex");
    expect(resolved.selection).toMatchObject({ serviceId: "openai", modelId: "gpt-5.6-sol" });
    // req 5 — complete: a named reviewer carries a level (the harness default).
    expect(resolved.reasoningEffort).toBe("high");
    // req 3 — who pays is captured at admission, not re-derived by the spawn.
    expect(resolved.route).toBeDefined();
    // A named reviewer belongs to no slot.
    expect(resolved.reviewer).toBeUndefined();
  });

  // The model name matches by label too, and the harness preference is a
  // preference, not a filter: a model only the implementer's own harness can
  // run still resolves on it (docs/261, docs/263 req 5 Scope) — the human named
  // it, which lifts the distance guarantee just as a pin does.
  it("resolves a label-only name onto a model only the implementer's harness can run", async () => {
    installAll();
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    const resolved = resolveSubAgentSpawnTarget(
      { kind: "role", role: "reviewer", modelName: "V4 Flash" },
      { harnessId: "claude" },
      { credentialStore: storeWith([DEEPSEEK_KEY]), env: {} },
    );
    expect(resolved.harnessId).toBe("claude");
    expect(resolved.selection.modelId).toBe("deepseek-v4-flash");
  });

  it("applies an effort the user named onto the resolved reviewer (docs/263)", async () => {
    installAll();
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    const resolved = resolveSubAgentSpawnTarget(
      { kind: "role", role: "reviewer", modelName: "GPT-5.6 Sol", reasoningEffort: "medium" },
      { harnessId: "claude" },
      { credentialStore: storeWith([OPENAI_KEY]), env: {} },
    );
    expect(resolved.reasoningEffort).toBe("medium");
  });

  it("applies an effort the user named to the configured reviewer (docs/263)", async () => {
    installAll();
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    const resolved = resolveSubAgentSpawnTarget(
      { kind: "role", role: "reviewer", reasoningEffort: "high" },
      {
        harnessId: "claude",
        selection: { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" },
      },
      { credentialStore: storeWith([OPENAI_KEY, ANTHROPIC_KEY]), env: {} },
    );
    // The slot path still reports which reviewer ran and why.
    expect(resolved.reviewer?.slot).toBeTruthy();
    expect(resolved.reasoningEffort).toBe("high");
  });

  // Req 7's rule, applied to the override: a level the resolved harness does
  // not offer is an error, not a silently dropped flag.
  it("refuses an effort the resolved harness does not offer (docs/263)", async () => {
    installAll();
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() =>
      resolveSubAgentSpawnTarget(
        { kind: "role", role: "reviewer", modelName: "GPT-5.6 Sol", reasoningEffort: "ludicrous" },
        { harnessId: "claude" },
        { credentialStore: storeWith([OPENAI_KEY]), env: {} },
      ),
    ).toThrow(/ludicrous/);
  });

  it("refuses a model name nothing matches, listing the catalogue (docs/263)", async () => {
    installAll();
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() =>
      resolveSubAgentSpawnTarget(
        { kind: "role", role: "reviewer", modelName: "Fictional Model X" },
        { harnessId: "claude" },
        { credentialStore: storeWith([OPENAI_KEY]), env: {} },
      ),
    ).toThrow(/No model matches "Fictional Model X"/);
  });

  it("refuses a model name that spans several models (docs/263)", async () => {
    installAll();
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    // "GPT-5.6" substrings Sol/Terra/Luna — three canonical models.
    expect(() =>
      resolveSubAgentSpawnTarget(
        { kind: "role", role: "reviewer", modelName: "GPT-5.6" },
        { harnessId: "claude" },
        { credentialStore: storeWith([OPENAI_KEY]), env: {} },
      ),
    ).toThrow(/matches more than one model/);
  });

  it("refuses a named model no credential on the install can run (docs/263)", async () => {
    installAll();
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() =>
      resolveSubAgentSpawnTarget(
        { kind: "role", role: "reviewer", modelName: "GLM-5.2" },
        { harnessId: "claude" },
        { credentialStore: storeWith([OPENAI_KEY]), env: {} },
      ),
    ).toThrow(/No service on this install can run GLM-5.2/);
  });
});

describe("assertHarnessCanRunSelection", () => {
  const selection = { serviceId: "openai", billingMode: "sub" as const, modelId: "gpt-5.6-sol" };

  it("accepts a selection in the harness's eligible set", async () => {
    const { assertHarnessCanRunSelection } = await import("./sub-agent-target.js");
    expect(() => assertHarnessCanRunSelection("Codex", [selection], selection)).not.toThrow();
  });

  it("refuses a harness pointed at a model no credential of its own offers", async () => {
    const { assertHarnessCanRunSelection } = await import("./sub-agent-target.js");
    expect(() =>
      assertHarnessCanRunSelection("Claude Code", [selection], { ...selection, modelId: "gpt-5.6-luna" }),
    ).toThrow(/cannot run/);
  });

  // An EMPTY eligible set means no credential source is wired (a test registry,
  // a bare runtime), not "nothing is eligible" — refusing everything there would
  // break installs the route check already covers.
  it("skips the check when the registry reports no eligible set at all", async () => {
    const { assertHarnessCanRunSelection } = await import("./sub-agent-target.js");
    expect(() => assertHarnessCanRunSelection("Codex", [], selection)).not.toThrow();
    expect(() => assertHarnessCanRunSelection("Codex", undefined, selection)).not.toThrow();
  });
});
