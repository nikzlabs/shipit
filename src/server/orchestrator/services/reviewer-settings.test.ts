import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CredentialRoute, ReviewerPin, ReviewerSlot } from "../../shared/types.js";

/**
 * A refusal, asserted by its CONTRACT rather than by `instanceof ServiceError`.
 *
 * These tests `vi.resetModules()` and re-import the module under test, so the
 * `ServiceError` class it throws is a different object identity from one
 * imported statically here — `toThrow(ServiceError)` would fail on a perfectly
 * correct refusal. The status code and the message are what callers depend on
 * anyway.
 */
function expectRefusal(fn: () => unknown, message: RegExp): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown, "expected a refusal, got none").toBeDefined();
  expect(thrown).toMatchObject({ statusCode: 400, message: expect.stringMatching(message) });
}

/**
 * docs/261 phase 3 (reqs 1, 5, 8) — the reviewer settings payload, and what an
 * edit to it is allowed to be.
 *
 * Driven against the **real** catalogue, like `reviewer-model.test.ts`: every
 * rule here is a statement about which models reach which harness and what
 * levels that harness declares, so a fixture catalogue would let these pass and
 * disagree with what ShipIt actually offers.
 */

function route(
  over: Pick<CredentialRoute, "serviceId" | "billingMode">,
): CredentialRoute {
  return {
    ...over,
    id: `${over.serviceId}-${over.billingMode}`,
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
    getCredentialSecret: (id: string) =>
      routes.some((r) => r.id === id) ? "sk-test" : undefined,
    getSelectionMode: () => "strict" as const,
    getCredentialRoute: (id: string) => routes.find((r) => r.id === id),
    // docs/252 follow-up — the string-delivered walk applies the user's
    // cutoffs, so its credential source carries them. Default: nothing set.
    getFailoverCutoffs: () => ({ session: 90, weekly: 90 }),
  };
}

const ANTHROPIC_KEY = route({ serviceId: "anthropic", billingMode: "key" });
const OPENAI_KEY = route({ serviceId: "openai", billingMode: "key" });
const DEEPSEEK_KEY = route({ serviceId: "deepseek", billingMode: "key" });

const installAll = () =>
  vi.doMock("../../shared/installed-harnesses.js", () => ({
    isHarnessInstalled: () => true,
    readInstalledHarnesses: () => ["claude", "codex"],
  }));

describe("buildReviewerSettings (req 8)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../../shared/installed-harnesses.js");
  });

  /**
   * The requirement in one assertion: an unpinned slot is *auto-configured*,
   * and auto-configured is a state with a COMPLETE answer — model, service,
   * harness and reasoning level (reqs 5, 8). The thing this replaces is a
   * picker that renders a blank and silently works.
   */
  it("labels an untouched install's slots auto-configured, each with what it resolves to", async () => {
    installAll();
    const { buildReviewerSettings } = await import("./reviewer-settings.js");
    const views = buildReviewerSettings({
      credentialStore: storeWith([OPENAI_KEY, DEEPSEEK_KEY]),
      env: {},
    });

    expect(views.map((v) => v.slot)).toEqual(["first", "second"]);
    expect(views.map((v) => v.source)).toEqual(["auto", "auto"]);
    for (const view of views) {
      expect(view.pin).toBeUndefined();
      expect(view.unavailableReason).toBeUndefined();
      // EVERY field the tab renders, `billingMode` and `modelId` included.
      // Leaving those two out let a payload drop the billing mode and still
      // pass a check whose whole subject is completeness — cross-backend review
      // caught the omission, which is the same defect class this assertion is
      // about.
      expect(view.resolved).toEqual(
        expect.objectContaining({
          serviceId: expect.any(String),
          billingMode: expect.stringMatching(/^(sub|key)$/),
          modelId: expect.any(String),
          serviceName: expect.any(String),
          label: expect.any(String),
          harnessId: expect.any(String),
          harnessName: expect.any(String),
          reasoningEffort: expect.any(String),
        }),
      );
      // Req 5 — never an empty level. A reviewer that fell back to the CLI's
      // own default is the one thing the requirement rules out, and on the wire
      // that would look exactly like this field being blank.
      expect(view.resolved?.reasoningEffort).toBeTruthy();
    }
  });

  /**
   * The visible half of req 8's re-derivation. Adding a service must change
   * what an untouched slot reports, with no write and no user action — that is
   * the case this feature exists for, since a one-service install cannot
   * satisfy req 4's different-family preference at all.
   */
  it("re-derives when the install gains a service, still labelled auto", async () => {
    installAll();
    const { buildReviewerSettings } = await import("./reviewer-settings.js");

    const before = buildReviewerSettings({ credentialStore: storeWith([ANTHROPIC_KEY]), env: {} });
    expect(before[1].resolved?.serviceId).toBe("anthropic");

    const after = buildReviewerSettings({
      credentialStore: storeWith([ANTHROPIC_KEY, DEEPSEEK_KEY]),
      env: {},
    });
    expect(after[1].resolved?.serviceId).toBe("deepseek");
    expect(after.map((v) => v.source)).toEqual(["auto", "auto"]);
  });

  it("reports a pinned slot as pinned, and returns the pin alongside the resolution", async () => {
    installAll();
    const { buildReviewerSettings } = await import("./reviewer-settings.js");
    const pin: ReviewerPin = {
      serviceId: "anthropic",
      billingMode: "key",
      modelId: "claude-sonnet-5",
      reasoningEffort: "medium",
    };
    const views = buildReviewerSettings({
      credentialStore: storeWith([ANTHROPIC_KEY, DEEPSEEK_KEY], { first: pin }),
      env: {},
    });

    expect(views[0].source).toBe("pinned");
    expect(views[0].pin).toEqual(pin);
    expect(views[0].resolved?.modelId).toBe("claude-sonnet-5");
    // The pin's level, not the harness's ShipIt-authored default — a pin wins
    // outright (req 8).
    expect(views[0].resolved?.reasoningEffort).toBe("medium");
    expect(views[1].source).toBe("auto");
  });

  /**
   * planning#352 — the tab is told where a pinned level does NOT survive.
   *
   * The tab names one harness (its derivation is implementer-independent) while
   * a review derives its own, so the note cannot be scoped to what this view
   * resolved onto: on this very row a pin accepted at `max` against Claude Code
   * runs on Codex, which declares no `max`. Reporting the level flat here is
   * what made the substitution silent.
   */
  it("names, on a pinned slot, every harness the pinned level does not survive onto", async () => {
    installAll();
    const { buildReviewerSettings } = await import("./reviewer-settings.js");
    const pin: ReviewerPin = {
      serviceId: "deepseek",
      billingMode: "key",
      modelId: "deepseek-v4-flash",
      reasoningEffort: "max",
    };
    const views = buildReviewerSettings({
      credentialStore: storeWith([DEEPSEEK_KEY], { first: pin }),
      env: {},
    });

    // This view's own harness offers `max`, so the level it reports is the pin's.
    expect(views[0].resolved?.harnessId).toBe("claude");
    expect(views[0].resolved?.reasoningEffort).toBe("max");
    const subs = views[0].resolved?.effortSubstitutions ?? [];
    const codex = subs.find((s) => s.harnessId === "codex");
    expect(codex, "a review on Codex runs at another level and the tab is not told").toBeDefined();
    // Named for the user, not by id — this string is rendered.
    expect(codex?.harnessName).toBeTruthy();
    expect(codex?.reasoningEffort).not.toBe("max");
    expect(subs.map((s) => s.harnessId)).not.toContain("claude");
  });

  /** Nothing to say on a slot nobody pinned: there is no level to substitute. */
  it("says nothing about substitutions on an auto-configured slot", async () => {
    installAll();
    const { buildReviewerSettings } = await import("./reviewer-settings.js");
    const views = buildReviewerSettings({
      credentialStore: storeWith([DEEPSEEK_KEY]),
      env: {},
    });
    expect(views.map((v) => v.resolved?.effortSubstitutions)).toEqual([undefined, undefined]);
  });

  /**
   * A pin whose credential went away and an install that can run nothing read
   * very differently to the user — "the reviewer you chose is gone" versus "add
   * a credential" — so they are not collapsed into one absence.
   */
  it("distinguishes a pin that lost its credential from an install with nothing to run", async () => {
    installAll();
    const { buildReviewerSettings } = await import("./reviewer-settings.js");
    const pin: ReviewerPin = {
      serviceId: "openai",
      billingMode: "key",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
    };

    const lostCredential = buildReviewerSettings({
      credentialStore: storeWith([ANTHROPIC_KEY], { first: pin }),
      env: {},
    });
    expect(lostCredential[0]).toEqual(
      expect.objectContaining({ source: "pinned", pin, unavailableReason: "pin_unavailable" }),
    );
    expect(lostCredential[0].resolved).toBeUndefined();

    const nothingAtAll = buildReviewerSettings({ credentialStore: storeWith([]), env: {} });
    expect(nothingAtAll.map((v) => v.unavailableReason)).toEqual([
      "nothing_eligible",
      "nothing_eligible",
    ]);
  });

  /**
   * Two slots, always — an empty array would say "this build has no reviewers",
   * which is a different and untrue statement from "neither has an answer". The
   * tab renders one row per slot off this length.
   */
  it("returns both slots even with no credential store at all", async () => {
    installAll();
    const { buildReviewerSettings } = await import("./reviewer-settings.js");
    const views = buildReviewerSettings({});
    expect(views.map((v) => v.slot)).toEqual(["first", "second"]);
    expect(views.map((v) => v.unavailableReason)).toEqual([
      "nothing_eligible",
      "nothing_eligible",
    ]);
  });
});

describe("resolveReviewerPinPatch (reqs 5, 8)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../../shared/installed-harnesses.js");
  });

  /**
   * Pinning is atomic (req 8). The wire may omit the level — that is the "the
   * user changed the model" case — and the stored pin is complete anyway,
   * because the client must not re-derive which harness a model runs on.
   */
  it("completes an omitted level from the derived harness's review default", async () => {
    installAll();
    const { resolveReviewerPinPatch } = await import("./reviewer-settings.js");
    const { REVIEWER_DEFAULT_EFFORT } = await import("../reviewer-model.js");

    const pin = resolveReviewerPinPatch(
      { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" },
      storeWith([ANTHROPIC_KEY]),
      {},
    );
    expect(pin).toEqual({
      serviceId: "anthropic",
      billingMode: "key",
      modelId: "claude-opus-5",
      reasoningEffort: REVIEWER_DEFAULT_EFFORT.claude,
    });
  });

  it("keeps a level the derived harness declares", async () => {
    installAll();
    const { resolveReviewerPinPatch } = await import("./reviewer-settings.js");
    const pin = resolveReviewerPinPatch(
      { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5", reasoningEffort: "low" },
      storeWith([ANTHROPIC_KEY]),
      {},
    );
    expect(pin.reasoningEffort).toBe("low");
  });

  /**
   * planning#352 — a level the derived selection does not offer is **re-derived,
   * not refused**.
   *
   * This used to be a 400, on the reading that a silent replacement is as bad as
   * a silent supply. What that missed is the edit it blocks: a service change
   * that keeps the model can derive a different harness, so the change failed
   * until the user lowered the level first — req 11 blocked by req 5, over a
   * level that came along with the model rather than being chosen for the new
   * one. The replacement is not silent because this **returns** the pin that was
   * stored, and the tab reports a level that changed under an edit.
   */
  it("re-derives a level the derived selection does not offer", async () => {
    installAll();
    const { resolveReviewerPinPatch } = await import("./reviewer-settings.js");
    const { REVIEWER_DEFAULT_EFFORT } = await import("../reviewer-model.js");
    const pin = resolveReviewerPinPatch(
      {
        serviceId: "anthropic",
        billingMode: "key",
        modelId: "claude-opus-5",
        // Codex declares `minimal`; Claude Code does not.
        reasoningEffort: "minimal",
      },
      storeWith([ANTHROPIC_KEY]),
      {},
    );

    expect(pin.reasoningEffort).toBe(REVIEWER_DEFAULT_EFFORT.claude);
    // The MODEL half of the pin is untouched — the pin applies as far as it can
    // and no further, which is what makes this an edit that lands rather than
    // one that fails.
    expect(pin).toMatchObject({
      serviceId: "anthropic",
      billingMode: "key",
      modelId: "claude-opus-5",
    });
  });

  /**
   * The docs/274 req 14 end of the same rule: a row whose CLI drops the flag
   * before the wire offers no level to name, so one that arrives anyway is
   * dropped rather than refused. Pinning such a reviewer must stay possible —
   * it is perfectly runnable, with one field fewer.
   */
  it("drops a level on a selection that offers none, and still pins", async () => {
    // Grok Build alone, so the row derives onto the one harness that sends no
    // reasoning flag at all under key billing.
    vi.doMock("../../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: (id: string) => id === "grok",
      readInstalledHarnesses: () => ["grok"],
    }));
    const { resolveReviewerPinPatch } = await import("./reviewer-settings.js");
    const { reasoningOptionsFor } = await import("../../shared/catalogue/index.js");
    const selection = { serviceId: "xai", billingMode: "key" as const, modelId: "grok-4.6" };
    // The premise, asserted rather than assumed.
    expect(reasoningOptionsFor("grok", selection)).toEqual([]);

    expect(
      resolveReviewerPinPatch(
        { ...selection, reasoningEffort: "high" },
        storeWith([route({ serviceId: "xai", billingMode: "key" })]),
        {},
      ),
    ).toEqual(selection);
  });

  it("refuses a triple the catalogue does not carry", async () => {
    installAll();
    const { resolveReviewerPinPatch } = await import("./reviewer-settings.js");
    expectRefusal(
      () =>
        resolveReviewerPinPatch(
          { serviceId: "anthropic", billingMode: "key", modelId: "no-such-model" },
          storeWith([ANTHROPIC_KEY]),
          {},
        ),
      /No catalogue entry/,
    );
  });

  /**
   * A pin nothing can run would fail on every review and the tab never offers
   * one, so it is API misuse rather than a state to persist. Same rule
   * `nonTurnModel` already applies.
   */
  it("refuses a model no installed harness has a credential for", async () => {
    installAll();
    const { resolveReviewerPinPatch } = await import("./reviewer-settings.js");
    expectRefusal(
      () =>
        resolveReviewerPinPatch(
          { serviceId: "openai", billingMode: "key", modelId: "gpt-5.6-sol" },
          storeWith([ANTHROPIC_KEY]),
          {},
        ),
      /No installed harness can run/,
    );
  });

  it("refuses a model whose only harness is not installed", async () => {
    vi.doMock("../../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: (id: string) => id === "claude",
      readInstalledHarnesses: () => ["claude"],
    }));
    const { resolveReviewerPinPatch } = await import("./reviewer-settings.js");
    expectRefusal(
      () =>
        resolveReviewerPinPatch(
          { serviceId: "openai", billingMode: "key", modelId: "gpt-5.6-sol" },
          storeWith([OPENAI_KEY]),
          {},
        ),
      /No installed harness can run/,
    );
  });
});

describe("parseReviewerPinPatch / requireReviewerSlot", () => {
  it("passes a well-formed patch through, with and without a level", async () => {
    const { parseReviewerPinPatch } = await import("./reviewer-settings.js");
    expect(
      parseReviewerPinPatch(
        { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" },
        "first",
      ),
    ).toEqual({ serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" });
    expect(
      parseReviewerPinPatch(
        { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5", reasoningEffort: "high" },
        "first",
      )?.reasoningEffort,
    ).toBe("high");
  });

  /** `null` is *Reset to auto* (req 8), not a malformed pin. */
  it("reads null as the reset", async () => {
    const { parseReviewerPinPatch } = await import("./reviewer-settings.js");
    expect(parseReviewerPinPatch(null, "second")).toBeNull();
  });

  // Each field gets its own message, so the failure names what to fix rather
  // than saying the body was bad.
  it.each([
    ["a non-object", 7, /must be a pin object or null/],
    ["a missing serviceId", { billingMode: "key", modelId: "claude-opus-5" }, /serviceId is required/],
    ["an unknown billing mode", { serviceId: "anthropic", billingMode: "plan", modelId: "m" }, /billingMode must be/],
    ["a missing modelId", { serviceId: "anthropic", billingMode: "key" }, /modelId is required/],
    ["an empty level", { serviceId: "anthropic", billingMode: "key", modelId: "m", reasoningEffort: "" }, /reasoningEffort must be/],
  ])("refuses %s", async (_label, raw, message) => {
    const { parseReviewerPinPatch } = await import("./reviewer-settings.js");
    expectRefusal(() => parseReviewerPinPatch(raw, "first"), message);
  });

  it("refuses a slot name that is not one of the two", async () => {
    const { requireReviewerSlot } = await import("./reviewer-settings.js");
    expect(requireReviewerSlot("first")).toBe("first");
    expect(requireReviewerSlot("second")).toBe("second");
    expectRefusal(() => requireReviewerSlot("third"), /Unknown reviewer slot/);
  });
});
