/**
 * docs/264 phase 3 (reqs 10, 12, 16) — **one parser and one refusal rule behind
 * both spawn commands**, over docs/261's one-shot rules.
 *
 * Three properties carry this phase, and the middle one is the whole of req 16:
 *
 *  - an **incomplete call with no base is refused**, never completed from a
 *    stored default the caller cannot see — the failure mode `SubAgentDefaults`
 *    was, and the refusal docs/261 established;
 *  - that refusal **narrows rather than disappearing**: a partial call over a
 *    PARENT is ordinary and must not be refused (the shipped `--model X` form
 *    docs/261 req 10 guarantees), and a role plus a parameter is no longer two
 *    questions at once but the override path (req 10);
 *  - a role name is **not checked here at all** any more. It is any name the user
 *    typed (req 18), so a compiled-in list would reject the user's own roles;
 *    resolution is the authority and its refusal names the roles that exist
 *    (req 13).
 *
 * The role path drives the **real** catalogue and the real reviewer resolver
 * rather than a fixture, for `reviewer-model.test.ts`'s reason: which model
 * reaches which harness is a statement about that catalogue, so a fixture could
 * pass here and disagree with what ShipIt does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentRole, CredentialRoute, ReviewerPin, ReviewerSlot } from "../../shared/types.js";
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

/** The reviewer as the real store synthesizes it: always present, params resolved. */
const REVIEWER_ROLE: AgentRole = { name: "reviewer", params: { kind: "auto" } };

function storeWith(
  routes: CredentialRoute[],
  pins: Partial<Record<ReviewerSlot, ReviewerPin>> = {},
  roles: AgentRole[] = [],
) {
  const all = [...roles, REVIEWER_ROLE];
  return {
    getReviewerPin: (slot: ReviewerSlot) => pins[slot],
    // docs/264 — `getRoles` always yields the reviewer, which is what makes
    // "review this" resolve on an install nobody configured. The real synthesis
    // is `credential-store.test.ts`'s; these fakes model its result.
    getRoles: () => all,
    getRole: (name: string) => all.find((r) => r.name === name),
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

describe("parseSubAgentSpawnTarget — the explicit path (docs/261 req 7)", () => {
  it("accepts a call that names every parameter", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(parseSubAgentSpawnTarget(FULL)).toEqual({
      kind: "explicit",
      harnessId: "codex",
      serviceId: "openai",
      billingMode: "sub",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
  });

  /**
   * The refusal the feature exists for. Each of the five is load-bearing:
   * `--model` alone cannot say which credential pays for a model two services
   * offer (docs/261 req 3), and the effort is part of the call rather than the
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

describe("parseSpawnTarget — the role path with overrides (docs/264 reqs 10, 13, 18)", () => {
  it("accepts a role on its own, with nothing overridden", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(parseSubAgentSpawnTarget({ role: "reviewer" })).toEqual({
      kind: "role",
      role: "reviewer",
      overrides: {},
    });
  });

  // The reversal at the heart of phase 3: docs/261 refused each of these
  // combinations as "two questions at once". Req 10 makes every one of them the
  // override path, so what used to be five refusals is now five accepted calls.
  for (const [field, key, value] of [
    ["agentId", "harnessId", "codex"],
    ["serviceId", "serviceId", "openai"],
    ["billingMode", "billingMode", "key"],
    ["modelId", "modelId", "gpt-5.6-sol"],
    ["reasoningEffort", "reasoningEffort", "high"],
  ] as const) {
    it(`carries a role plus ${field} as an override rather than refusing it`, async () => {
      const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
      expect(parseSubAgentSpawnTarget({ role: "deep-dive", [field]: value })).toEqual({
        kind: "role",
        role: "deep-dive",
        overrides: { [key]: value },
      });
    });
  }

  // req 18 — any name the user types. The parser cannot know which roles exist
  // (they are the user's, stored server-side), so it must not judge the name;
  // resolution refuses an unknown one and lists what does exist (req 13).
  it("passes an unknown role name through rather than rejecting it locally", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(parseSubAgentSpawnTarget({ role: "deep dive, please" })).toEqual({
      kind: "role",
      role: "deep dive, please",
      overrides: {},
    });
  });

  /**
   * **A named-but-blank parameter is refused, not treated as absent.** The two
   * are different claims: absent means "the base supplies it", blank means the
   * caller tried to say something that did not survive its shell. Dropping it ran
   * the BARE role — a run nobody asked for, which is precisely the dropped
   * override req 10 forbids. Cross-agent review found this.
   */
  for (const [field, flag] of [
    ["agentId", "--agent"],
    ["serviceId", "--service"],
    ["modelId", "--model"],
    ["reasoningEffort", "--effort"],
  ] as const) {
    it(`refuses a role whose ${flag} override is present but empty`, async () => {
      const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
      expect(() => parseSubAgentSpawnTarget({ role: "reviewer", [field]: "   " })).toThrow(
        new RegExp(flag),
      );
      // A non-string is the same mistake arriving over HTTP rather than a shell.
      expect(() => parseSubAgentSpawnTarget({ role: "reviewer", [field]: 42 })).toThrow(
        new RegExp(flag),
      );
    });
  }

  /**
   * **A role name survives verbatim, because resolution is by EXACT key**
   * (req 18). Storage stores the key as typed (`credential-store.ts`'s `setRole`,
   * deliberately un-normalized), so trimming here does not tidy a name — it names
   * a different role. Two ways that failed, both reachable on a name req 18
   * permits: `" reviewer "` is an ordinary role, distinct from the reserved one,
   * and ran ShipIt's automatic reviewer instead of itself (reqs 3, 4, 7);
   * `" deep dive "` was refused as unknown while existing.
   */
  it("passes a role name through exactly as typed, spaces included (req 18)", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    for (const name of [" reviewer ", " deep dive ", "deep dive "]) {
      expect(parseSubAgentSpawnTarget({ role: name })).toEqual({
        kind: "role",
        role: name,
        overrides: {},
      });
    }
  });

  /**
   * The blank case is the one thing a verbatim name still refuses, and it costs
   * nothing: a name blank once whitespace is discounted cannot be stored, so it
   * can never be a role — while `--role ""` is something the caller TRIED to say
   * (the same rule every other named parameter follows above).
   */
  it("refuses a --role that is present but empty rather than reading it as absent", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    for (const value of ["", "   ", 42]) {
      // The message matters as much as the throw: without it the call fell
      // through to the explicit path and was refused for "missing --agent,
      // --service, …", which names every flag but the one at fault.
      expect(() => parseSubAgentSpawnTarget({ role: value })).toThrow(
        /--role was given an empty value/,
      );
    }
  });

  /**
   * The one value that is present and still reads as absence, and it is a
   * decision rather than a gap: a `null` cannot come from a shell — the CLI
   * cannot spell one — so it only arrives from a caller writing a body, where
   * `null` is how JSON says "no value". Refusing it would refuse the idiom
   * (`{ modelId: user.model ?? null }`) instead of catching a failed expansion,
   * which is what the blank rule above is for.
   */
  it("reads an explicit null as absence, unlike a blank string", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(parseSubAgentSpawnTarget({ role: "reviewer", modelId: null, agentId: null })).toEqual({
      kind: "role",
      role: "reviewer",
      overrides: {},
    });
  });

  it("still refuses a billing mode that is neither sub nor key, even as an override", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() => parseSubAgentSpawnTarget({ role: "reviewer", billingMode: "free" })).toThrow(/sub/);
  });
});

describe("parseSpawnTarget — the parent base (req 16)", () => {
  /**
   * The one place the two commands differ, and the regression this phase most
   * has to avoid: `shipit session create --model X` is a partial call over the
   * PARENT, which docs/261 req 10 guarantees. The same call on `agent run` is
   * refused, because a one-shot run has no parent to complete it from.
   */
  it("accepts a partial call when a parent is available, and refuses it when not", async () => {
    const { parseSpawnTarget } = await import("./sub-agent-target.js");
    expect(parseSpawnTarget({ modelId: "gpt-5.6-sol" }, { parentBase: true })).toEqual({
      kind: "inherit",
      overrides: { modelId: "gpt-5.6-sol" },
    });
    expect(() => parseSpawnTarget({ modelId: "gpt-5.6-sol" }, { parentBase: false })).toThrow(
      /missing/,
    );
  });

  it("reads an empty call over a parent as inheriting everything", async () => {
    const { parseSpawnTarget } = await import("./sub-agent-target.js");
    expect(parseSpawnTarget({}, { parentBase: true })).toEqual({ kind: "inherit", overrides: {} });
  });

  it("reads a complete call as explicit even where a parent exists", async () => {
    // Nothing is left to complete, so the parent is not consulted — the same
    // target `agent run` would produce, which is what one parser buys.
    const { parseSpawnTarget } = await import("./sub-agent-target.js");
    expect(parseSpawnTarget(FULL, { parentBase: true })).toEqual({
      kind: "explicit",
      harnessId: "codex",
      serviceId: "openai",
      billingMode: "sub",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
  });

  it("prefers a role over the parent when both could apply", async () => {
    const { parseSpawnTarget } = await import("./sub-agent-target.js");
    expect(parseSpawnTarget({ role: "deep-dive", modelId: "x" }, { parentBase: true })).toEqual({
      kind: "role",
      role: "deep-dive",
      overrides: { modelId: "x" },
    });
  });
});

describe("resolveSpawnTarget", () => {
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
        harnessId: "codex",
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
    // Nothing named a role, so there is nothing to attribute the run to (req 14).
    expect(resolved.roleName).toBeUndefined();
  });

  it("refuses a triple the catalogue does not carry", async () => {
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() =>
      resolveSubAgentSpawnTarget(
        {
          kind: "explicit",
          harnessId: "codex",
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

  /**
   * **One validator, both commands.** This check used to live only on the
   * one-shot path (`runSubAgent`'s `assertHarnessCanRunSelection`, against the
   * registry's eligible set), so a child session naming the same incoherent pair
   * was accepted, persisted and left for turn-time routing to fail on. Asked here
   * of the CATALOGUE — do the harness and the model share an API style — because
   * that is the half no credential can change. Cross-agent review found the gap.
   */
  it("refuses a harness pointed at a model it shares no API style with", async () => {
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() =>
      resolveSubAgentSpawnTarget(
        {
          kind: "explicit",
          harnessId: "claude",
          serviceId: "openai",
          billingMode: "sub",
          modelId: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
        { harnessId: "claude" },
        { credentialStore: storeWith([]) },
      ),
    ).toThrow(/cannot run/);
  });

  // docs/261 req 5's corollary — the level is named in the call, so a level the
  // harness does not offer is the caller's error. Silently dropping it (the old
  // behaviour: an unrecognized value meant "pass no flag") would run the review
  // at a level nobody chose.
  it("refuses an effort the named harness does not offer", async () => {
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() =>
      resolveSubAgentSpawnTarget(
        {
          kind: "explicit",
          harnessId: "codex",
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

  // docs/261 req 6 — the role resolves to a complete reviewer without the caller
  // naming anything, and req 4 picks the one furthest from the implementer: a
  // Claude session gets the GPT reviewer, on the other harness.
  it("resolves a role to the reviewer furthest from the implementer", async () => {
    installAll();
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    const resolved = resolveSubAgentSpawnTarget(
      { kind: "role", role: "reviewer", overrides: {} },
      {
        harnessId: "claude",
        selection: { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" },
      },
      { credentialStore: storeWith([OPENAI_KEY, ANTHROPIC_KEY]), env: {} },
    );
    expect(resolved.harnessId).toBe("codex");
    expect(resolved.selection.serviceId).toBe("openai");
    // docs/261 req 5 — complete: a reviewer always carries a level.
    expect(resolved.reasoningEffort).toBeTruthy();
    // "resolved once, at spawn admission" — the route is captured here, not
    // re-derived by the spawn.
    expect(resolved.route).toBeDefined();
    expect(resolved.reviewer?.tier).toBe(1);
    expect(resolved.reviewer?.tierBasis).toBe("model-and-harness");
    // docs/264 req 14 — the run is attributable to what was ASKED FOR, not only
    // to what it resolved to.
    expect(resolved.roleName).toBe("reviewer");
  });

  // The implementer is what the ranking is computed against, so the SAME install
  // must answer differently for a Codex session — with no editing in between
  // (docs/261 req 4's "reviewing works whichever model is implementing").
  it("picks a different reviewer for a different implementer, with nothing reconfigured", async () => {
    installAll();
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    const deps = { credentialStore: storeWith([OPENAI_KEY, DEEPSEEK_KEY]), env: {} };
    const forClaude = resolveSubAgentSpawnTarget(
      { kind: "role", role: "reviewer", overrides: {} },
      { harnessId: "claude", selection: { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4" } },
      deps,
    );
    const forCodex = resolveSubAgentSpawnTarget(
      { kind: "role", role: "reviewer", overrides: {} },
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
        { kind: "role", role: "reviewer", overrides: {} },
        { harnessId: "claude" },
        { credentialStore: storeWith([]), env: {} },
      ),
    ).toThrow(/cannot run/);
  });

  /**
   * The whole of the trimming defect, end to end: a user's own role named
   * `" reviewer "` (req 18 permits it, and storage keeps the two apart) must run
   * ITS tuple, not ShipIt's automatic reviewer. Trimming at the parser made the
   * two names one, so the run silently landed on the ranked reviewer — the
   * substitution req 7 forbids, on a role that exists.
   */
  it("runs the role whose name matches exactly, not the reserved one it resembles", async () => {
    installAll();
    const { parseSubAgentSpawnTarget, resolveSubAgentSpawnTarget } = await import(
      "./sub-agent-target.js"
    );
    const spaced: AgentRole = {
      name: " reviewer ",
      params: {
        kind: "pinned",
        harnessId: "claude",
        serviceId: "anthropic",
        billingMode: "key",
        modelId: "claude-opus-5",
        reasoningEffort: "high",
      },
    };
    const resolved = resolveSubAgentSpawnTarget(
      parseSubAgentSpawnTarget({ role: " reviewer " }),
      {
        harnessId: "claude",
        selection: { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" },
      },
      { credentialStore: storeWith([OPENAI_KEY, ANTHROPIC_KEY], {}, [spaced]), env: {} },
    );
    expect(resolved.roleName).toBe(" reviewer ");
    expect(resolved.harnessId).toBe("claude");
    expect(resolved.selection.modelId).toBe("claude-opus-5");
    // The ranking never ran: this is a pinned role, so there is no reviewer
    // account of a choice — the tell that the reserved role was not what ran.
    expect(resolved.reviewer).toBeUndefined();
  });

  // req 13 — the refusal is the remedy: it names the roles that DO exist, so an
  // agent that guessed a name learns what it could have said.
  it("refuses an unknown role, naming the roles that exist", async () => {
    installAll();
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() =>
      resolveSubAgentSpawnTarget(
        { kind: "role", role: "critic", overrides: {} },
        { harnessId: "claude" },
        { credentialStore: storeWith([OPENAI_KEY]), env: {} },
      ),
    ).toThrow(/critic.*reviewer/s);
  });

  // req 10 — an override reaches the run. The reviewer's distance guarantee is
  // set aside for an overridden run, which is the requirement rather than a bug:
  // the caller said what they wanted.
  it("applies an override over a role, landing where the caller asked", async () => {
    installAll();
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    const resolved = resolveSubAgentSpawnTarget(
      {
        kind: "role",
        role: "reviewer",
        overrides: { harnessId: "claude", modelId: "claude-opus-5" },
      },
      {
        harnessId: "claude",
        selection: { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" },
      },
      { credentialStore: storeWith([OPENAI_KEY, ANTHROPIC_KEY]), env: {} },
    );
    // The ranking would have chosen Codex/GPT (the test above); the caller named
    // Claude on the implementer's OWN model, and gets it. That is req 10 rather
    // than a bug: an override sets the distance guarantee aside, and the level
    // still completes from the ranked winner because nothing overrode it.
    expect(resolved.harnessId).toBe("claude");
    expect(resolved.selection.modelId).toBe("claude-opus-5");
    expect(resolved.reasoningEffort).toBeTruthy();
    expect(resolved.roleName).toBe("reviewer");
  });
});

describe("resolveSpawnTargetForChild (req 11)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../../shared/installed-harnesses.js");
  });

  /**
   * The failure this exists to prevent does not appear for days. A one-shot run
   * is admitted, routed and finished inside one request, so freezing its
   * credential keeps its attribution honest. A child session takes turns of its
   * own for as long as it lives — carrying the frozen route in would pin it to
   * one credential and break account failover the first time that subscription
   * hit its quota, long after anyone would connect the two.
   */
  it("drops the frozen route and the ranking, keeping the tuple and the role name", async () => {
    vi.doMock("../../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => true,
      readInstalledHarnesses: () => ["claude", "codex"],
    }));
    const { resolveSpawnTarget, resolveSpawnTargetForChild } = await import("./sub-agent-target.js");
    const args = [
      { kind: "role" as const, role: "reviewer", overrides: {} },
      {
        harnessId: "claude" as const,
        selection: { serviceId: "anthropic", billingMode: "key" as const, modelId: "claude-opus-5" },
      },
      { credentialStore: storeWith([OPENAI_KEY, ANTHROPIC_KEY]), env: {} },
    ] as const;

    const oneShot = resolveSpawnTarget(...args);
    const child = resolveSpawnTargetForChild(...args);

    expect(oneShot.route).toBeDefined();
    expect(child.route).toBeUndefined();
    expect(child.reviewer).toBeUndefined();
    // Everything that decides what the child STARTS as survives intact.
    expect(child.harnessId).toBe(oneShot.harnessId);
    expect(child.selection).toEqual(oneShot.selection);
    expect(child.reasoningEffort).toBe(oneShot.reasoningEffort);
    expect(child.roleName).toBe("reviewer");
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
