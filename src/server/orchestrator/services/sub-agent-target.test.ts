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
  // separates them rather than letting one silently win.
  for (const [field, flag] of [
    ["agentId", "--agent"],
    ["serviceId", "--service"],
    ["billingMode", "--billing-mode"],
    ["modelId", "--model"],
    ["reasoningEffort", "--effort"],
  ]) {
    it(`refuses a role combined with ${flag}`, async () => {
      const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
      expect(() =>
        parseSubAgentSpawnTarget({ role: "reviewer", [field]: "whatever" }),
      ).toThrow(new RegExp(flag));
    });
  }

  it("refuses an unknown role by name rather than ignoring it", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() => parseSubAgentSpawnTarget({ role: "critic" })).toThrow(/critic/);
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
