import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CredentialRoute, ReviewerPin, ReviewerSlot } from "../shared/types.js";
import {
  HARNESSES,
  allServices,
  catalogueEntriesForHarness,
  reasoningOptionsFor,
  resolveStyle,
} from "../shared/catalogue/index.js";

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
    getCredentialRoute: (id: string) => routes.find((r) => r.id === id),
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
    expect(differentModelSameHarness).toBeLessThan(sameModelOtherHarness);
  });

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
  it("names a level every harness actually offers, or null where there are none", async () => {
    const { REVIEWER_DEFAULT_EFFORT } = await import("./reviewer-model.js");
    for (const harness of HARNESSES) {
      const offered = new Set(
        catalogueEntriesForHarness(harness.id).flatMap((entry) =>
          reasoningOptionsFor(harness.id, entry.selection).map((o) => o.value),
        ),
      );
      const authored = REVIEWER_DEFAULT_EFFORT[harness.id];
      if (offered.size === 0) {
        expect(authored, `${harness.id} offers no reasoning levels on any selection, so its default must be null`).toBeNull();
        continue;
      }
      expect([...offered]).toContain(authored);
    }
  });

  it("splits the level per selection: none on a key-billed grok row, real ones on the subscription", async () => {
    const { REVIEWER_DEFAULT_EFFORT } = await import("./reviewer-model.js");
    expect(REVIEWER_DEFAULT_EFFORT.grok).toBe("high");

    const byMode = { sub: 0, key: 0 };
    for (const entry of catalogueEntriesForHarness("grok")) {
      const offered = reasoningOptionsFor("grok", entry.selection).map((o) => o.value);
      byMode[entry.selection.billingMode] += 1;
      if (entry.selection.billingMode === "key") {
        expect(offered, `${entry.selection.serviceId}/${entry.selection.modelId}`).toEqual([]);
      } else {
        expect(offered.length, `${entry.selection.serviceId}/${entry.selection.modelId}`).toBeGreaterThan(0);
        expect(offered).toContain(REVIEWER_DEFAULT_EFFORT.grok);
      }
    }
    expect(byMode.sub, "no subscription grok rows in the catalogue").toBeGreaterThan(0);
    expect(byMode.key, "no key-billed grok rows in the catalogue").toBeGreaterThan(0);
  });

  it("leaves a shared gateway row's levels intact for the harnesses that honour them", async () => {
    await import("./reviewer-model.js");
    const shared = catalogueEntriesForHarness("grok").filter(
      (entry) => entry.selection.billingMode === "key" && entry.selection.serviceId !== "xai",
    );
    expect(shared.length, "no shared key-billed rows to check").toBeGreaterThan(0);
    for (const entry of shared) {
      expect(reasoningOptionsFor("grok", entry.selection)).toEqual([]);
      for (const other of ["claude", "codex", "opencode"] as const) {
        if (resolveStyle(other, entry.model) === undefined) continue;
        expect(
          reasoningOptionsFor(other, entry.selection).length,
          `${other} lost its levels on ${entry.selection.serviceId}/${entry.selection.modelId}`,
        ).toBeGreaterThan(0);
      }
    }
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

  it("derives both slots when nothing is pinned", async () => {
    installAll();
    const { resolveReviewerSlots } = await import("./reviewer-model.js");
    const slots = resolveReviewerSlots({
      credentialStore: storeWith([OPENAI_KEY, DEEPSEEK_KEY]),
      env: {},
    });

    expect(slots.map((s) => s.source)).toEqual(["auto", "auto"]);
    expect(slots[0].target?.selection).toEqual({
      serviceId: "openai",
      billingMode: "key",
      modelId: "gpt-5.6-sol",
    });
    expect(slots[0].target?.harnessId).toBe("codex");
    expect(slots[1].target?.selection.serviceId).toBe("deepseek");
    expect(slots[1].target?.harnessId).toBe("claude");
  });

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

  it("still derives a second reviewer on a one-family install", async () => {
    installAll();
    const { resolveReviewerSlots } = await import("./reviewer-model.js");
    const slots = resolveReviewerSlots({
      credentialStore: storeWith([ANTHROPIC_KEY]),
      env: {},
    });

    expect(slots[0].target?.selection.modelId).toBe("claude-opus-5");
    expect(slots[1].target).not.toBeNull();
    expect(slots[1].target?.selection.modelId).toBe("claude-sonnet-5");
    expect(slots[1].target?.selection.serviceId).toBe("anthropic");
  });

  it("improves an unpinned reviewer when a service is added, with no write", async () => {
    installAll();
    const { resolveReviewerSlots } = await import("./reviewer-model.js");

    const before = resolveReviewerSlots({ credentialStore: storeWith([ANTHROPIC_KEY]), env: {} });
    expect(before[1].target?.selection.serviceId).toBe("anthropic");

    const after = resolveReviewerSlots({
      credentialStore: storeWith([ANTHROPIC_KEY, DEEPSEEK_KEY]),
      env: {},
    });
    expect(after[1].target?.selection.serviceId).toBe("deepseek");
    expect(after.map((s) => s.source)).toEqual(["auto", "auto"]);
  });

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
    expect(slots[0].target?.reasoningEffort).toBe("low");
    expect(slots[1].source).toBe("auto");
  });

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
    expect(slots[1].target).not.toBeNull();
  });

  it("says nothing is eligible when the install has no credential at all", async () => {
    installAll();
    const { resolveReviewerSlots } = await import("./reviewer-model.js");
    const slots = resolveReviewerSlots({ credentialStore: storeWith([]), env: {} });
    expect(slots.every((s) => s.target === null)).toBe(true);
    expect(slots[0]).toMatchObject({ source: "auto", reason: "nothing_eligible" });
  });

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

    expect(slots[0].target?.selection.serviceId).toBe("deepseek");
  });
});

describe("reviewer harness derivation", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../shared/installed-harnesses.js");
  });

  it("moves the avoided harness to the back — and keeps it", async () => {
    const { harnessesPreferring } = await import("./non-turn-model.js");
    const all = harnessesPreferring().map((h) => h.id);

    expect(harnessesPreferring("claude").map((h) => h.id)).toEqual(["codex", "opencode", "grok", "claude"]);
    expect(harnessesPreferring("codex").map((h) => h.id)).toEqual(["claude", "opencode", "grok", "codex"]);
    expect(harnessesPreferring("claude").map((h) => h.id).sort()).toEqual([...all].sort());
  });

  it("still resolves a model only the implementer's own harness can run", async () => {
    vi.doMock("../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => true,
      readInstalledHarnesses: () => ["claude", "codex"],
    }));
    const { harnessesForSelection } = await import("./non-turn-model.js");
    // The subscription credential restricts this model to Claude Code.
    const credentials = [
      { serviceId: "anthropic", billingMode: "sub" as const, via: "account" as const },
    ];
    const selection = {
      serviceId: "anthropic",
      billingMode: "sub" as const,
      modelId: "claude-opus-5",
    };

    expect(harnessesForSelection(selection, credentials, { avoidHarnessId: "claude" })).toEqual(
      harnessesForSelection(selection, credentials),
    );
    expect(harnessesForSelection(selection, credentials)).toHaveLength(1);
  });
});

describe("a pinned level does not cross onto a selection that refuses it (planning#352)", () => {
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

  it("keeps the pinned MODEL and re-derives the level when the review lands elsewhere", async () => {
    installAll();
    const { selectReviewer } = await import("./reviewer-model.js");
    const result = selectReviewer(
      {
        harnessId: "codex",
        selection: { serviceId: "openai", billingMode: "key", modelId: "gpt-5.4" },
      },
      {
        // Pin both slots so automatic selection cannot bypass the pinned level.
        credentialStore: storeWith([DEEPSEEK_KEY], {
          first: {
            serviceId: "deepseek",
            billingMode: "key",
            modelId: "deepseek-flash",
            reasoningEffort: "minimal",
          },
          second: {
            serviceId: "deepseek",
            billingMode: "key",
            modelId: "deepseek-flash",
            reasoningEffort: "minimal",
          },
        }),
        env: {},
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.harnessId).toBe("claude");
    expect(result.target.selection.modelId).toBe("deepseek-flash");
    expect(result.target.source).toBe("pinned");
    expect(result.target.reasoningEffort).not.toBe("minimal");
    expect(
      reasoningOptionsFor("claude", result.target.selection).map((o) => o.value),
    ).toContain(result.target.reasoningEffort);
  });

  it("leaves the pinned level alone where the resolved selection offers it", async () => {
    installAll();
    const { selectReviewer } = await import("./reviewer-model.js");
    const result = selectReviewer(
      {
        harnessId: "claude",
        selection: { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" },
      },
      {
        credentialStore: storeWith([DEEPSEEK_KEY], {
          first: {
            serviceId: "deepseek",
            billingMode: "key",
            modelId: "deepseek-flash",
            reasoningEffort: "minimal",
          },
        }),
        env: {},
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.harnessId).toBe("codex");
    expect(result.target.reasoningEffort).toBe("minimal");
  });

  it("holds for every dual-harness row in the catalogue", async () => {
    installAll();
    const { selectReviewer } = await import("./reviewer-model.js");

    let checked = 0;
    let crossed = 0;
    for (const service of allServices()) {
      for (const mode of service.modes) {
        for (const model of mode.models) {
          const selection = { serviceId: service.id, billingMode: mode.kind, modelId: model.id };
          const carriers = HARNESSES.filter((h) => resolveStyle(h.id, model) !== undefined).map(
            (h) => ({ id: h.id, levels: reasoningOptionsFor(h.id, selection).map((o) => o.value) }),
          );
          if (carriers.length < 2) continue;
          for (const carrier of carriers) {
            const divergent = carrier.levels.find((level) =>
              carriers.some((other) => other.id !== carrier.id && !other.levels.includes(level)),
            );
            if (!divergent) continue;
            const result = selectReviewer(
              { harnessId: carrier.id },
              {
                credentialStore: storeWith(
                  [route({ serviceId: service.id, billingMode: mode.kind })],
                  { first: { ...selection, reasoningEffort: divergent } },
                ),
                env: {},
              },
            );
            if (!result.ok || result.target.source !== "pinned") continue;
            checked += 1;
            if (result.target.harnessId !== carrier.id) crossed += 1;
            const offered = reasoningOptionsFor(
              result.target.harnessId,
              result.target.selection,
            ).map((o) => o.value);
            const where = `${service.id}/${mode.kind}/${model.id} pinned "${divergent}" on `
              + `${carrier.id}, resolved on ${result.target.harnessId}`;
            if (offered.length === 0) {
              expect(result.target.reasoningEffort, where).toBeUndefined();
            } else {
              expect(offered, where).toContain(result.target.reasoningEffort);
            }
          }
        }
      }
    }
    expect(checked, "no dual-harness rows with divergent levels were checked").toBeGreaterThan(0);
    expect(crossed, "no pinned reviewer ever crossed onto another harness").toBeGreaterThan(0);
  });
});

describe("reviewerEffortSubstitutions", () => {
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

  it("names every harness the pinned level does not survive onto, and what it becomes", async () => {
    installAll();
    const { reviewerEffortSubstitutions } = await import("./reviewer-model.js");
    const subs = reviewerEffortSubstitutions(
      {
        serviceId: "deepseek",
        billingMode: "key",
        modelId: "deepseek-flash",
        reasoningEffort: "minimal",
      },
      { credentialStore: storeWith([DEEPSEEK_KEY]), env: {} },
    );

    expect(subs.map((s) => s.harnessId)).not.toContain("codex");
    const claude = subs.find((s) => s.harnessId === "claude");
    expect(claude).toBeDefined();
    expect(
      reasoningOptionsFor("claude", {
        serviceId: "deepseek",
        billingMode: "key",
        modelId: "deepseek-flash",
      }).map((o) => o.value),
    ).toContain(claude?.reasoningEffort);
    expect(claude?.reasoningLabel).toBeTruthy();
  });

  it("names a harness that would send no level at all", async () => {
    installAll();
    const { reviewerEffortSubstitutions } = await import("./reviewer-model.js");
    const subs = reviewerEffortSubstitutions(
      {
        serviceId: "deepseek",
        billingMode: "key",
        modelId: "deepseek-flash",
        reasoningEffort: "high",
      },
      { credentialStore: storeWith([DEEPSEEK_KEY]), env: {} },
    );

    expect(subs.map((s) => s.harnessId)).toEqual(["grok"]);
    expect(subs[0].reasoningEffort).toBeUndefined();
  });

  it("says nothing when the pinned level survives everywhere it could resolve", async () => {
    installAll();
    const { reviewerEffortSubstitutions } = await import("./reviewer-model.js");
    expect(
      reviewerEffortSubstitutions(
        {
          serviceId: "anthropic",
          billingMode: "key",
          modelId: "claude-opus-5",
          reasoningEffort: "high",
        },
        { credentialStore: storeWith([ANTHROPIC_KEY]), env: {} },
      ),
    ).toEqual([]);
  });

  it("says nothing for a pin that names no level", async () => {
    installAll();
    const { reviewerEffortSubstitutions } = await import("./reviewer-model.js");
    expect(
      reviewerEffortSubstitutions(
        { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-flash" },
        { credentialStore: storeWith([DEEPSEEK_KEY]), env: {} },
      ),
    ).toEqual([]);
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
            modelId: "deepseek-flash",
            reasoningEffort: "high",
          },
        }),
        env: {},
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.selection.serviceId).toBe("deepseek");
    expect(result.target.harnessId).toBe("codex");
    expect(result.tier).toBe(1);
  });

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
    expect(result.target.harnessId).toBe("codex");
    expect(result.target.selection.serviceId).toBe("openai");
  });

  it("does not apply the harness-only tie-break when the implementer's model is known", async () => {
    installAll();
    const { selectReviewer } = await import("./reviewer-model.js");
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
    expect(result.target.slot).toBe("first");
    expect(result.target.selection.modelId).toBe("claude-sonnet-5");
  });

  it("the tie-break prior decides ties only — never a real tier difference", async () => {
    const { beatsIncumbentReviewer } = await import("./reviewer-model.js");
    expect(
      beatsIncumbentReviewer(
        { tier: 2, avoidsLikelyFamily: true },
        { tier: 1, avoidsLikelyFamily: false },
      ),
    ).toBe(false);
    expect(
      beatsIncumbentReviewer(
        { tier: 1, avoidsLikelyFamily: false },
        { tier: 2, avoidsLikelyFamily: true },
      ),
    ).toBe(true);
    expect(
      beatsIncumbentReviewer(
        { tier: 1, avoidsLikelyFamily: true },
        { tier: 1, avoidsLikelyFamily: false },
      ),
    ).toBe(true);
    expect(
      beatsIncumbentReviewer(
        { tier: 1, avoidsLikelyFamily: false },
        { tier: 1, avoidsLikelyFamily: false },
      ),
    ).toBe(false);
    expect(
      beatsIncumbentReviewer(
        { tier: 1, avoidsLikelyFamily: true },
        { tier: 1, avoidsLikelyFamily: true },
      ),
    ).toBe(false);
  });

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
    expect(Object.isFrozen(result.target)).toBe(true);
    expect(Object.isFrozen(result.target.selection)).toBe(true);
    expect(Object.isFrozen(result.target.route)).toBe(true);
    if (result.target.serviceRouting) {
      expect(Object.isFrozen(result.target.serviceRouting)).toBe(true);
    }
    expect(result.target.selection.serviceId).toBeTruthy();
    expect(result.target.selection.billingMode).toBeTruthy();
    expect(result.target.selection.modelId).toBeTruthy();
    expect(result.target.harnessId).toBeTruthy();
    expect(result.target.reasoningEffort).toBeTruthy();
    expect(result.target.route).toBeTruthy();
    expect(result.target.serviceName).toBe("DeepSeek");
  });
});
