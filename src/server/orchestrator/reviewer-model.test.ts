import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CredentialRoute, ReviewerPin, ReviewerSlot } from "../shared/types.js";
import { HARNESSES } from "../shared/catalogue/index.js";

/**
 * docs/261 phase 1 (reqs 1, 3, 4, 5, 8) — the two reviewers and the distance
 * ranking that picks between them.
 *
 * Like `non-turn-model.test.ts`, every end-to-end test drives the **real**
 * catalogue rather than a fixture: the derivation rules are statements about
 * that catalogue's order and about which models actually reach which harness, so
 * a fixture would let them pass here and disagree with what ShipIt does.
 *
 * The ranking itself is also exercised as a pure function, one rung at a time.
 * When this file was written no family spanned both harnesses and tiers 3 and 5
 * were unreachable end to end; docs/268's third harness changed that (an
 * anthropic-key model now bends onto OpenCode — tier 3 is asserted end to end
 * in the selection suite below, and tier 5 is reachable the same way through a
 * gateway row). The unit rungs stay because they pin each predicate in
 * isolation, not because the catalogue cannot reach them.
 */

function route(
  over: Pick<CredentialRoute, "serviceId" | "billingMode"> & { via?: CredentialRoute["via"] },
): CredentialRoute {
  return {
    serviceId: over.serviceId,
    billingMode: over.billingMode,
    id: `${over.serviceId}-${over.billingMode}`,
    via: over.via ?? "string",
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
    getCredentialSecret: (id: string) =>
      routes.some((r) => r.id === id && r.via === "string") ? "sk-test" : undefined,
    getSelectionMode: () => "strict" as const,
    // docs/252 req 20 widened it again: spawn shaping asks whether a route id
    // names a STORED row, because an adopted credential keeps a legacy reserved
    // id and can no longer be recognised by its id's shape.
    getCredentialRoute: (id: string) => routes.find((r) => r.id === id),
    // docs/252 follow-up — the string-delivered walk applies the user's
    // cutoffs, so its credential source carries them. Default: nothing set.
    getFailoverCutoffs: () => ({ session: 90, weekly: 90 }),
  };
}

const ANTHROPIC_KEY = route({ serviceId: "anthropic", billingMode: "key" });
const OPENAI_KEY = route({ serviceId: "openai", billingMode: "key" });
const DEEPSEEK_KEY = route({ serviceId: "deepseek", billingMode: "key" });
const OPENROUTER_KEY = route({ serviceId: "openrouter", billingMode: "key" });

describe("reviewerDistanceTier (req 4)", () => {
  const claude = { canonicalModelKey: "claude-opus-5", family: "claude" as const };
  const sonnet = { canonicalModelKey: "claude-sonnet-5", family: "claude" as const };
  const gpt = { canonicalModelKey: "gpt-5.4", family: "gpt" as const };

  it("tier 1 — a different family on a different harness is the ideal", async () => {
    const { reviewerDistanceTier } = await import("./reviewer-model.js");
    expect(
      reviewerDistanceTier(
        { harnessId: "claude", identity: claude },
        { harnessId: "codex", identity: gpt },
      ),
    ).toBe(1);
  });

  it("tier 2 — a different family on the same harness", async () => {
    const { reviewerDistanceTier } = await import("./reviewer-model.js");
    expect(
      reviewerDistanceTier(
        { harnessId: "claude", identity: claude },
        { harnessId: "claude", identity: gpt },
      ),
    ).toBe(2);
  });

  it("tier 3 — a different model of the same family, on a different harness", async () => {
    const { reviewerDistanceTier } = await import("./reviewer-model.js");
    expect(
      reviewerDistanceTier(
        { harnessId: "claude", identity: claude },
        { harnessId: "codex", identity: sonnet },
      ),
    ).toBe(3);
  });

  it("tier 4 — a different model of the same family, on the same harness", async () => {
    const { reviewerDistanceTier } = await import("./reviewer-model.js");
    expect(
      reviewerDistanceTier(
        { harnessId: "claude", identity: claude },
        { harnessId: "claude", identity: sonnet },
      ),
    ).toBe(4);
  });

  it("tier 5 — the SAME model through a different harness", async () => {
    const { reviewerDistanceTier } = await import("./reviewer-model.js");
    expect(
      reviewerDistanceTier(
        { harnessId: "claude", identity: claude },
        { harnessId: "codex", identity: claude },
      ),
    ).toBe(5);
  });

  it("tier 6 — the same model on the same harness", async () => {
    const { reviewerDistanceTier } = await import("./reviewer-model.js");
    expect(
      reviewerDistanceTier(
        { harnessId: "claude", identity: claude },
        { harnessId: "claude", identity: claude },
      ),
    ).toBe(6);
  });

  /**
   * The bug the first draft of the design shipped, named so it cannot come back.
   * Ranking "different harness" above "different model" sends work to the SAME
   * model through another CLI — same weights, same training, same answers — in
   * preference to a genuinely different model. Req 4 forbids reviewing work with
   * the thing that produced it whenever any alternative is configured, and the
   * human was explicit: "model needs to be checked first".
   */
  it("same model on another harness must NOT outrank a different model on the same one", async () => {
    const { reviewerDistanceTier } = await import("./reviewer-model.js");
    const sameModelOtherHarness = reviewerDistanceTier(
      { harnessId: "claude", identity: claude },
      { harnessId: "codex", identity: claude },
    );
    const differentModelSameHarness = reviewerDistanceTier(
      { harnessId: "claude", identity: claude },
      { harnessId: "claude", identity: sonnet },
    );
    // Lower is further from the implementer, so the different MODEL must win.
    expect(differentModelSameHarness).toBeLessThan(sameModelOtherHarness);
  });

  // A gateway serves another vendor's models, so service says nothing about
  // independence — which is why service is not an axis at all.
  it("treats a gateway-served model as the same model, not a distant one", async () => {
    const { reviewerDistanceTier, } = await import("./reviewer-model.js");
    const { modelIdentityFor } = await import("../shared/catalogue/index.js");
    const direct = modelIdentityFor({
      serviceId: "anthropic",
      billingMode: "key",
      modelId: "claude-opus-5",
    });
    const gateway = modelIdentityFor({
      serviceId: "openrouter",
      billingMode: "key",
      modelId: "anthropic/claude-opus-5",
    });
    expect(
      reviewerDistanceTier(
        { harnessId: "claude", identity: direct },
        { harnessId: "claude", identity: gateway },
      ),
    ).toBe(6);
  });

  // An implementer with no resolved selection leaves the model axes undecidable.
  // The ranking must not claim a sameness it cannot prove, so it collapses onto
  // the harness axis rather than refusing.
  it("falls back to the harness axis when the implementer's model is unknown", async () => {
    const { reviewerDistanceTier } = await import("./reviewer-model.js");
    expect(
      reviewerDistanceTier({ harnessId: "claude" }, { harnessId: "codex", identity: gpt }),
    ).toBe(1);
    expect(
      reviewerDistanceTier({ harnessId: "claude" }, { harnessId: "claude", identity: gpt }),
    ).toBe(2);
  });
});

describe("the ShipIt-authored review effort (reqs 5, 8)", () => {
  /**
   * The rule this used to assert was "every harness offers levels, and the
   * authored default is one of them". docs/274 splits it in two, because Grok
   * Build is the first harness that offers NONE — in API-key mode the CLI drops
   * `--reasoning-effort` before the wire, so its option list is honestly empty.
   *
   * What must not weaken is the half that catches a real mistake: an authored
   * value that names a level its harness does not have. So a harness with
   * levels is checked exactly as before, and a harness without them must say so
   * explicitly with `null` — not by omission, which would let a forgotten entry
   * pass as a deliberate one.
   */
  it("names a level every harness actually offers, or null where there are none", async () => {
    const { REVIEWER_DEFAULT_EFFORT } = await import("./reviewer-model.js");
    for (const harness of HARNESSES) {
      const options = harness.capabilities.reasoning?.options.map((o) => o.value) ?? [];
      const authored = REVIEWER_DEFAULT_EFFORT[harness.id];
      if (options.length === 0) {
        expect(authored, `${harness.id} offers no reasoning levels, so its default must be null`).toBeNull();
        continue;
      }
      expect(options).toContain(authored);
    }
  });

  // The zero-levels case end to end: a derived reviewer on such a harness is
  // still COMPLETE (req 5) — it simply has one field fewer, rather than being
  // handed a level the CLI would ignore.
  it("omits the level entirely for a harness that declares none", async () => {
    const { REVIEWER_DEFAULT_EFFORT } = await import("./reviewer-model.js");
    expect(REVIEWER_DEFAULT_EFFORT.grok).toBeNull();
    expect(HARNESSES.find((h) => h.id === "grok")?.capabilities.reasoning?.options).toEqual([]);
  });
});

describe("resolving the two reviewer slots", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../shared/installed-harnesses.js");
  });

  const installAll = () =>
    vi.doMock("../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => true,
      readInstalledHarnesses: () => ["claude", "codex"],
    }));

  // req 8 — review works without anyone having configured a reviewer, and the
  // derived pair takes the best available difference: a different family AND a
  // different harness is the ideal, and it is reachable here.
  it("derives both slots when nothing is pinned", async () => {
    installAll();
    const { resolveReviewerSlots } = await import("./reviewer-model.js");
    const slots = resolveReviewerSlots({
      credentialStore: storeWith([OPENAI_KEY, DEEPSEEK_KEY]),
      env: {},
    });

    expect(slots.map((s) => s.source)).toEqual(["auto", "auto"]);
    // Slot 1 is the picker's own ordering: first service, first mode, first model.
    expect(slots[0].target?.selection).toEqual({
      serviceId: "openai",
      billingMode: "key",
      modelId: "gpt-5.6-sol",
    });
    expect(slots[0].target?.harnessId).toBe("codex");
    // Slot 2 is the same ranking run against slot 1 — DeepSeek is a different
    // family and reaches a different harness, which is req 4's ideal.
    expect(slots[1].target?.selection.serviceId).toBe("deepseek");
    expect(slots[1].target?.harnessId).toBe("claude");
  });

  // req 5 + req 8 — an auto-configured reviewer is COMPLETE. A derived model
  // with the reasoning level left to the harness's own default is the one thing
  // req 5 rules out.
  it("gives a derived reviewer a reasoning level", async () => {
    installAll();
    const { resolveReviewerSlots, REVIEWER_DEFAULT_EFFORT } = await import("./reviewer-model.js");
    const slots = resolveReviewerSlots({
      credentialStore: storeWith([DEEPSEEK_KEY]),
      env: {},
    });

    expect(slots[0].target?.reasoningEffort).toBe(REVIEWER_DEFAULT_EFFORT.claude);
    expect(slots[0].target?.reasoningEffort).toBeTruthy();
  });

  /**
   * req 4 + req 8 — the case the draft's `skipFamily` filter got wrong. An
   * install with one family would derive NO second reviewer under a filter,
   * which is precisely where req 4 says to take the best available lesser
   * difference. One ranking function degrades through model and harness instead.
   */
  it("still derives a second reviewer on a one-family install", async () => {
    installAll();
    const { resolveReviewerSlots } = await import("./reviewer-model.js");
    const slots = resolveReviewerSlots({
      credentialStore: storeWith([ANTHROPIC_KEY]),
      env: {},
    });

    expect(slots[0].target?.selection.modelId).toBe("claude-opus-5");
    expect(slots[1].target).not.toBeNull();
    // Same family, same harness — a different MODEL is the best difference this
    // install has, and it is taken rather than refused.
    expect(slots[1].target?.selection.modelId).toBe("claude-sonnet-5");
    expect(slots[1].target?.selection.serviceId).toBe("anthropic");
  });

  /**
   * req 8's re-derivation, which is the requirement a value written once at
   * first run would fail. Nothing is written back, so the SAME unpinned
   * configuration answers differently the moment the install gains a service —
   * and that is the case this feature exists for, because a one-service install
   * cannot satisfy req 4's different-family preference at all.
   */
  it("improves an unpinned reviewer when a service is added, with no write", async () => {
    installAll();
    const { resolveReviewerSlots } = await import("./reviewer-model.js");

    const before = resolveReviewerSlots({ credentialStore: storeWith([ANTHROPIC_KEY]), env: {} });
    expect(before[1].target?.selection.serviceId).toBe("anthropic");

    const after = resolveReviewerSlots({
      credentialStore: storeWith([ANTHROPIC_KEY, DEEPSEEK_KEY]),
      env: {},
    });
    // A different family now exists, so slot 2 moves onto it — no user action,
    // no migration, and both slots are still reported as auto-configured.
    expect(after[1].target?.selection.serviceId).toBe("deepseek");
    expect(after.map((s) => s.source)).toEqual(["auto", "auto"]);
  });

  // req 8 — "a pin always wins: nothing re-derives over a choice the user made".
  it("uses a pin instead of deriving, and reports the slot as pinned", async () => {
    installAll();
    const { resolveReviewerSlots } = await import("./reviewer-model.js");
    const slots = resolveReviewerSlots({
      credentialStore: storeWith([ANTHROPIC_KEY, DEEPSEEK_KEY], {
        first: {
          serviceId: "anthropic",
          billingMode: "key",
          modelId: "haiku",
          reasoningEffort: "low",
        },
      }),
      env: {},
    });

    expect(slots[0].source).toBe("pinned");
    expect(slots[0].target?.selection.modelId).toBe("haiku");
    // The pin carries its own level — req 5, and the reason a pin is atomic.
    expect(slots[0].target?.reasoningEffort).toBe("low");
    expect(slots[1].source).toBe("auto");
  });

  // docs/252 req 13 — a pin is a persisted selection and strands on a retired
  // model exactly as a session does. Following the successor is what stops one
  // retirement from disabling a configured reviewer forever.
  it("follows a retired pin onto its successor", async () => {
    installAll();
    const { resolveReviewerSlots } = await import("./reviewer-model.js");
    const slots = resolveReviewerSlots({
      credentialStore: storeWith([OPENAI_KEY], {
        first: {
          serviceId: "openai",
          billingMode: "key",
          modelId: "gpt-5.6",
          reasoningEffort: "high",
        },
      }),
      env: {},
    });

    expect(slots[0].source).toBe("pinned");
    expect(slots[0].target?.selection.modelId).toBe("gpt-5.6-sol");
  });

  it("reports a pin the install can no longer run", async () => {
    installAll();
    const { resolveReviewerSlots } = await import("./reviewer-model.js");
    const slots = resolveReviewerSlots({
      credentialStore: storeWith([DEEPSEEK_KEY], {
        first: {
          serviceId: "openai",
          billingMode: "key",
          modelId: "gpt-5.4",
          reasoningEffort: "high",
        },
      }),
      env: {},
    });

    expect(slots[0].target).toBeNull();
    expect(slots[0]).toMatchObject({ source: "pinned", reason: "pin_unavailable" });
    // The other slot is unaffected — a broken pin is not a broken reviewer set.
    expect(slots[1].target).not.toBeNull();
  });

  it("says nothing is eligible when the install has no credential at all", async () => {
    installAll();
    const { resolveReviewerSlots } = await import("./reviewer-model.js");
    const slots = resolveReviewerSlots({ credentialStore: storeWith([]), env: {} });
    expect(slots.every((s) => s.target === null)).toBe(true);
    expect(slots[0]).toMatchObject({ source: "auto", reason: "nothing_eligible" });
  });

  /**
   * "Eligible is not runnable." A configured, eligible subscription whose
   * accounts are all quota-exhausted is still eligible and route selection
   * returns `all_exhausted` — so ranking it would name a reviewer and then fail,
   * with a perfectly good second reviewer sitting unused.
   */
  it("skips a reviewer whose subscription is entirely spent", async () => {
    installAll();
    const { resolveReviewerSlots } = await import("./reviewer-model.js");
    const slots = resolveReviewerSlots({
      credentialStore: storeWith([
        route({ serviceId: "anthropic", billingMode: "sub", via: "account" }),
        DEEPSEEK_KEY,
      ]),
      providerAccountManager: {
        subscriptionLimitsFor: () => ({}),
        selectAccountForTurn: () => ({
          ok: false as const,
          reason: "all_exhausted" as const,
          earliestResetAt: null,
        }),
      },
      env: {},
    });

    // Anthropic's subscription sorts first in the catalogue and is eligible —
    // it is skipped because it cannot route, not because it is not offered.
    expect(slots[0].target?.selection.serviceId).toBe("deepseek");
  });
});

/**
 * The reviewer's harness derivation is its own — still derived and never chosen,
 * so req 3 is untouched, but with one preference `harnessForNonTurnSelection`
 * does not have. There the first installed harness is accepted as *arbitrary*
 * because the harness does not matter for a session title; here it is a ranking
 * axis, so catalogue order must not hand a reviewer the implementer's own
 * harness and drop it a tier for nothing.
 *
 * **The preference itself cannot be exercised against today's catalogue, and
 * that is worth stating rather than hiding behind a passing test.** No shipped
 * model runs on both harnesses: Claude's family speaks only Anthropic-Messages
 * and GPT's only Responses, so every selection has exactly one eligible harness
 * and there is nothing to prefer between. What IS testable, and is the property
 * that would break the product if it were wrong, is that the preference is a
 * preference and not a filter.
 */
describe("reviewer harness derivation", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../shared/installed-harnesses.js");
  });

  /**
   * The preference itself, tested where it can actually fail. Asserting it
   * through `harnessesForSelection` cannot: every shipped selection has exactly
   * one eligible harness, so an implementation that ignored `avoidHarnessId`
   * entirely would pass. Cross-backend review found that hole in the first cut.
   */
  it("moves the avoided harness to the back — and keeps it", async () => {
    const { harnessesPreferring } = await import("./non-turn-model.js");
    const all = harnessesPreferring().map((h) => h.id);

    expect(harnessesPreferring("claude").map((h) => h.id)).toEqual(["codex", "opencode", "grok", "claude"]);
    expect(harnessesPreferring("codex").map((h) => h.id)).toEqual(["claude", "opencode", "grok", "codex"]);
    // A preference, never a filter: nothing is dropped, so a model only the
    // avoided harness can run is still reachable.
    expect(harnessesPreferring("claude").map((h) => h.id).sort()).toEqual([...all].sort());
  });

  it("still resolves a model only the implementer's own harness can run", async () => {
    vi.doMock("../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => true,
      readInstalledHarnesses: () => ["claude", "codex"],
    }));
    const { harnessesForSelection } = await import("./non-turn-model.js");
    // The subscription mode, not the key mode: since docs/268 an Anthropic
    // KEY model runs on OpenCode too, so it no longer isolates "only the
    // implementer's own harness". The sub mode still does — its account
    // credential needs an account target and its env-token credential is
    // carrier-restricted to Claude Code.
    const credentials = [
      { serviceId: "anthropic", billingMode: "sub" as const, via: "account" as const },
    ];
    const selection = {
      serviceId: "anthropic",
      billingMode: "sub" as const,
      modelId: "claude-opus-5",
    };

    // Avoiding the only harness that can run it must not empty the list — a
    // filter would refuse the reviewer outright, which is the bug this shape
    // exists to avoid.
    expect(harnessesForSelection(selection, credentials, { avoidHarnessId: "claude" })).toEqual(
      harnessesForSelection(selection, credentials),
    );
    expect(harnessesForSelection(selection, credentials)).toHaveLength(1);
  });
});

describe("selecting the reviewer furthest from the implementer (req 4)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../shared/installed-harnesses.js");
  });

  const installAll = () =>
    vi.doMock("../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => true,
      readInstalledHarnesses: () => ["claude", "codex"],
    }));

  /**
   * The gateway case, end to end. The implementer runs OpenRouter's
   * `anthropic/claude-opus-5`; one reviewer is Anthropic's own `claude-opus-5`.
   * Two different services and two different ids — and the SAME model, so it is
   * ranked last. Under a service-first ranking this pair would have looked
   * distant while sharing everything that matters.
   */
  it("does not review a gateway-served model with the vendor-served same model", async () => {
    installAll();
    const { selectReviewer } = await import("./reviewer-model.js");
    const result = selectReviewer(
      {
        harnessId: "claude",
        selection: {
          serviceId: "openrouter",
          billingMode: "key",
          modelId: "anthropic/claude-opus-5",
        },
      },
      {
        credentialStore: storeWith([ANTHROPIC_KEY, OPENROUTER_KEY], {
          first: {
            serviceId: "anthropic",
            billingMode: "key",
            modelId: "claude-opus-5",
            reasoningEffort: "high",
          },
          second: {
            serviceId: "anthropic",
            billingMode: "key",
            modelId: "claude-sonnet-5",
            reasoningEffort: "high",
          },
        }),
        env: {},
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.slot).toBe("second");
    expect(result.target.selection.modelId).toBe("claude-sonnet-5");
    // Tier 3 since docs/268, not 4: the anthropic-key pin now also runs on
    // OpenCode, so the harness derivation bends away from the implementer and
    // adds the different-harness axis to the different-model one.
    expect(result.tier).toBe(3);
    expect(result.target.harnessId).toBe("opencode");
  });

  it("prefers a different family over a different service of the same one", async () => {
    installAll();
    const { selectReviewer } = await import("./reviewer-model.js");
    const result = selectReviewer(
      {
        harnessId: "claude",
        selection: { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" },
      },
      {
        credentialStore: storeWith([ANTHROPIC_KEY, DEEPSEEK_KEY, OPENROUTER_KEY], {
          first: {
            serviceId: "openrouter",
            billingMode: "key",
            modelId: "anthropic/claude-sonnet-5",
            reasoningEffort: "high",
          },
          second: {
            serviceId: "deepseek",
            billingMode: "key",
            modelId: "deepseek-v4-flash",
            reasoningEffort: "high",
          },
        }),
        env: {},
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.selection.serviceId).toBe("deepseek");
    // DeepSeek reaches BOTH harnesses (Anthropic-Messages and the Responses API,
    // since 2026-08-13), so its reviewer bends away from the implementer's Claude
    // harness to Codex — different family AND different harness, the ranking's
    // ideal. The same-family-but-different-service openrouter slot stays on Claude
    // and is outranked. Tier 2 is unit-covered in the distance-ranking suite.
    expect(result.target.harnessId).toBe("codex");
    expect(result.tier).toBe(1);
  });

  // The tie rule: equally distant reviewers go to the first configured one.
  it("breaks a tie in favour of the first slot", async () => {
    installAll();
    const { selectReviewer } = await import("./reviewer-model.js");
    const result = selectReviewer(
      {
        harnessId: "claude",
        selection: { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" },
      },
      {
        credentialStore: storeWith([ANTHROPIC_KEY], {
          first: {
            serviceId: "anthropic",
            billingMode: "key",
            modelId: "claude-sonnet-5",
            reasoningEffort: "high",
          },
          second: {
            serviceId: "anthropic",
            billingMode: "key",
            modelId: "haiku",
            reasoningEffort: "high",
          },
        }),
        env: {},
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.slot).toBe("first");
  });

  // The whole chain on an ordinary two-service install: derive both slots,
  // rank them against the implementer, and land on req 4's ideal.
  it("sends Claude-on-Anthropic work to a different family on a different harness", async () => {
    installAll();
    const { selectReviewer } = await import("./reviewer-model.js");
    const result = selectReviewer(
      {
        harnessId: "claude",
        selection: { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" },
      },
      { credentialStore: storeWith([ANTHROPIC_KEY, OPENAI_KEY]), env: {} },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.harnessId).toBe("codex");
    expect(result.tier).toBe(1);
  });

  /**
   * An implementer whose model ShipIt cannot identify still gets a reviewer —
   * the ordering falls back to the harness axis — but the reported tier must not
   * be read as a family difference nobody established. `tierBasis` is what says
   * so; without it a consumer would render "different family" from a comparison
   * that never happened.
   */
  it("marks the ranking as harness-only when the implementer's model is unknown", async () => {
    installAll();
    const { selectReviewer } = await import("./reviewer-model.js");
    const result = selectReviewer(
      { harnessId: "claude" },
      { credentialStore: storeWith([ANTHROPIC_KEY, OPENAI_KEY]), env: {} },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tierBasis).toBe("harness-only");
    // Since docs/268 BOTH slots reach a different-harness candidate (slot 1's
    // anthropic key resolves onto OpenCode) and tie at the same rung — and the
    // harness-only tie-break (planning#408) then prefers the GPT slot: its
    // family provably differs from Claude Code's native (Anthropic) family,
    // while slot 1's claude-opus-5 is most likely what the session itself runs.
    expect(result.target.harnessId).toBe("codex");
    expect(result.target.selection.serviceId).toBe("openai");
  });

  /**
   * planning#408 — the harness-only tie-break is a weak PRIOR, and these are its
   * fences: it must never override a known-identity comparison, and it must
   * never outrank a real tier difference.
   */
  it("does not apply the harness-only tie-break when the implementer's model is known", async () => {
    installAll();
    const { selectReviewer } = await import("./reviewer-model.js");
    // A GLM session on Claude Code: the harness's native family (claude) is
    // WRONG for this session, and the identity comparison already knows it.
    // Both pins land on tier 1 (different family, different harness), so a
    // tie-break that ignored the known identity would flip to the GPT slot.
    const result = selectReviewer(
      {
        harnessId: "claude",
        selection: { serviceId: "zai", billingMode: "sub", modelId: "glm-5.2[1m]" },
      },
      {
        credentialStore: storeWith([ANTHROPIC_KEY, OPENAI_KEY], {
          first: {
            serviceId: "anthropic",
            billingMode: "key",
            modelId: "claude-sonnet-5",
            reasoningEffort: "high",
          },
          second: {
            serviceId: "openai",
            billingMode: "key",
            modelId: "gpt-5.4",
            reasoningEffort: "high",
          },
        }),
        env: {},
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tierBasis).toBe("model-and-harness");
    expect(result.tier).toBe(1);
    // The ordinary tie rule holds: equal tier keeps the FIRST slot, even though
    // its family matches the harness's native one.
    expect(result.target.slot).toBe("first");
    expect(result.target.selection.modelId).toBe("claude-sonnet-5");
  });

  /**
   * The comparator's fences, pinned as a unit — every rung × prior combination
   * in one place, including combinations the end-to-end test below reaches only
   * one of.
   */
  it("the tie-break prior decides ties only — never a real tier difference", async () => {
    const { beatsIncumbentReviewer } = await import("./reviewer-model.js");
    // A worse tier loses even when it avoids the likely family…
    expect(
      beatsIncumbentReviewer(
        { tier: 2, avoidsLikelyFamily: true },
        { tier: 1, avoidsLikelyFamily: false },
      ),
    ).toBe(false);
    // …and a better tier wins even when it matches it.
    expect(
      beatsIncumbentReviewer(
        { tier: 1, avoidsLikelyFamily: false },
        { tier: 2, avoidsLikelyFamily: true },
      ),
    ).toBe(true);
    // On a tie, avoiding the likely family displaces the earlier slot…
    expect(
      beatsIncumbentReviewer(
        { tier: 1, avoidsLikelyFamily: true },
        { tier: 1, avoidsLikelyFamily: false },
      ),
    ).toBe(true);
    // …but with no prior in play (a known implementer identity computes none,
    // so both sides read false) the earlier slot keeps the tie.
    expect(
      beatsIncumbentReviewer(
        { tier: 1, avoidsLikelyFamily: false },
        { tier: 1, avoidsLikelyFamily: false },
      ),
    ).toBe(false);
    // A candidate already avoiding it is not displaced by another that does.
    expect(
      beatsIncumbentReviewer(
        { tier: 1, avoidsLikelyFamily: true },
        { tier: 1, avoidsLikelyFamily: true },
      ),
    ).toBe(false);
  });

  /**
   * The tier-dominance fence end to end, through the one shipped row that can
   * reach it: the Z.ai coding plan's GLM is carrier-restricted to Claude Code
   * (`carriers: ["claude"]`), so it CANNOT bend away from a Claude implementer
   * — it lands prior-avoiding (glm ≠ the native claude family) on the
   * implementer's own harness at tier 2, against a prior-matching claude-opus-5
   * that reaches OpenCode at tier 1. The tier must win.
   */
  it("keeps a further prior-matching reviewer over a nearer prior-avoiding one", async () => {
    installAll();
    const { selectReviewer } = await import("./reviewer-model.js");
    const result = selectReviewer(
      { harnessId: "claude" },
      {
        credentialStore: storeWith([ANTHROPIC_KEY, route({ serviceId: "zai", billingMode: "sub" })], {
          first: {
            serviceId: "anthropic",
            billingMode: "key",
            modelId: "claude-opus-5",
            reasoningEffort: "high",
          },
          second: {
            serviceId: "zai",
            billingMode: "sub",
            modelId: "glm-5.2[1m]",
            reasoningEffort: "high",
          },
        }),
        env: {},
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tierBasis).toBe("harness-only");
    expect(result.target.slot).toBe("first");
    expect(result.target.harnessId).toBe("opencode");
    expect(result.tier).toBe(1);
  });

  it("marks the ranking as model-and-harness when the implementer's model is known", async () => {
    installAll();
    const { selectReviewer } = await import("./reviewer-model.js");
    const result = selectReviewer(
      {
        harnessId: "claude",
        selection: { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" },
      },
      { credentialStore: storeWith([ANTHROPIC_KEY, DEEPSEEK_KEY]), env: {} },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tierBasis).toBe("model-and-harness");
  });

  it("stops and says so when no configured reviewer can run", async () => {
    installAll();
    const { selectReviewer } = await import("./reviewer-model.js");
    const result = selectReviewer(
      { harnessId: "claude" },
      { credentialStore: storeWith([]), env: {} },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_reviewer_available");
  });

  // The target is what retries, attribution and the transcript card all read.
  // Recomputing during a retry is how a review ends up attributed to a model
  // that did not run it, so the resolved value is immutable.
  it("returns a frozen, complete target", async () => {
    installAll();
    const { selectReviewer } = await import("./reviewer-model.js");
    const result = selectReviewer(
      {
        harnessId: "claude",
        selection: { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" },
      },
      { credentialStore: storeWith([ANTHROPIC_KEY, DEEPSEEK_KEY]), env: {} },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Deeply, not just at the top level: a shallow freeze leaves `selection` and
    // `route` writable, so "immutable through retries" would have been true of
    // the wrapper alone. Cross-backend review found exactly that.
    expect(Object.isFrozen(result.target)).toBe(true);
    expect(Object.isFrozen(result.target.selection)).toBe(true);
    expect(Object.isFrozen(result.target.route)).toBe(true);
    if (result.target.serviceRouting) {
      expect(Object.isFrozen(result.target.serviceRouting)).toBe(true);
    }
    // Everything req 1 says a reviewer is: service, billing mode, model, the
    // derived harness, and the reasoning level.
    expect(result.target.selection.serviceId).toBeTruthy();
    expect(result.target.selection.billingMode).toBeTruthy();
    expect(result.target.selection.modelId).toBeTruthy();
    expect(result.target.harnessId).toBeTruthy();
    expect(result.target.reasoningEffort).toBeTruthy();
    expect(result.target.route).toBeTruthy();
    expect(result.target.serviceName).toBe("DeepSeek");
  });
});
