import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CredentialRoute, ReviewerPin, ReviewerSlot } from "../../shared/types.js";
import { reasoningOptionsFor } from "../../shared/catalogue/index.js";

// resetModules changes ServiceError identity; assert its fields instead of instanceof.
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
      expect(view.resolved?.reasoningEffort).toBeTruthy();
    }
  });

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
    expect(views[0].resolved?.reasoningEffort).toBe("medium");
    expect(views[1].source).toBe("auto");
  });

  it("names, on a pinned slot, every harness the pinned level does not survive onto", async () => {
    installAll();
    const { buildReviewerSettings } = await import("./reviewer-settings.js");
    const pin: ReviewerPin = {
      serviceId: "deepseek",
      billingMode: "key",
      modelId: "deepseek-flash",
      reasoningEffort: "minimal",
    };
    const views = buildReviewerSettings({
      credentialStore: storeWith([DEEPSEEK_KEY], { first: pin }),
      env: {},
    });

    expect(views[0].resolved?.harnessId).toBe("claude");
    expect(views[0].resolved?.reasoningEffort).not.toBe("minimal");
    expect(reasoningOptionsFor("claude", {
      serviceId: "deepseek",
      billingMode: "key",
      modelId: "deepseek-flash",
    }).map((option) => option.value)).toContain(views[0].resolved?.reasoningEffort);
    const subs = views[0].resolved?.effortSubstitutions ?? [];
    const claude = subs.find((s) => s.harnessId === "claude");
    expect(claude, "a review on Claude runs at another level and the tab is not told").toBeDefined();
    expect(claude?.harnessName).toBeTruthy();
    expect(claude?.reasoningEffort).not.toBe("minimal");
    expect(subs.map((s) => s.harnessId)).not.toContain("codex");
  });

  it("says nothing about substitutions on an auto-configured slot", async () => {
    installAll();
    const { buildReviewerSettings } = await import("./reviewer-settings.js");
    const views = buildReviewerSettings({
      credentialStore: storeWith([DEEPSEEK_KEY]),
      env: {},
    });
    expect(views.map((v) => v.resolved?.effortSubstitutions)).toEqual([undefined, undefined]);
  });

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

  it("re-derives a level the derived selection does not offer", async () => {
    installAll();
    const { resolveReviewerPinPatch } = await import("./reviewer-settings.js");
    const { REVIEWER_DEFAULT_EFFORT } = await import("../reviewer-model.js");
    const pin = resolveReviewerPinPatch(
      {
        serviceId: "anthropic",
        billingMode: "key",
        modelId: "claude-opus-5",
        reasoningEffort: "minimal",
      },
      storeWith([ANTHROPIC_KEY]),
      {},
    );

    expect(pin.reasoningEffort).toBe(REVIEWER_DEFAULT_EFFORT.claude);
    expect(pin).toMatchObject({
      serviceId: "anthropic",
      billingMode: "key",
      modelId: "claude-opus-5",
    });
  });

  it("drops a level on a selection that offers none, and still pins", async () => {
    vi.doMock("../../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: (id: string) => id === "grok",
      readInstalledHarnesses: () => ["grok"],
    }));
    const { resolveReviewerPinPatch } = await import("./reviewer-settings.js");
    const { reasoningOptionsFor } = await import("../../shared/catalogue/index.js");
    const selection = { serviceId: "xai", billingMode: "key" as const, modelId: "grok-4.6" };
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

  it("reads null as the reset", async () => {
    const { parseReviewerPinPatch } = await import("./reviewer-settings.js");
    expect(parseReviewerPinPatch(null, "second")).toBeNull();
  });

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
