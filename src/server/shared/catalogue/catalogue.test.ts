import { describe, it, expect } from "vitest";
import {
  SERVICES,
  HARNESSES,
  allHarnesses,
  allServices,
  catalogueEntriesForHarness,
  getHarness,
  getService,
  reasoningOptionsFor,
  selectionHonoursEffort,
  catalogueContextWindows,
  catalogueModelLabels,
  contextWindowFor,
  credentialModeForStorageEnv,
  credentialStorageEnvNames,
  getMode,
  getModel,
  isContextSentinel,
  isPriceSentinel,
  modeReportsQuota,
  subQuotaRefreshable,
  MODEL_FAMILY_IDS,
  MODEL_ID_ALIASES,
  MODEL_IDENTITIES,
  MODEL_IDENTITY_BY_KEY,
  modelIdentityFor,
  normalizeModelIdForIdentity,
  modesOfferingModel,
  catalogueModelIdsForHarness,
  eligibleEntriesForHarness,
  harnessCanCarry,
  harnessCredentialTarget,
  harnessServiceSupport,
  harnessSupportsMode,
  harnessSendsReasoningEffort,
  harnessSupportsService,
  isSelectionEligible,
  resolveSpawnShaping,
  spawnCredentialTarget,
  parseSelection,
  resolveEndpoint,
  resolveModelSelection,
  resolveRetiredModelId,
  resolveStyle,
  retirementSuccessor,
  sameCredentialOwner,
  sameSelection,
  selectionExists,
  serializeSelection,
  storageEnvFor,
  allLoginIntegrations,
  credentialHarnessForLogin,
  harnessesForLoginIntegration,
  harnessForNativeService,
  loginIntegrationForService,
  serviceForLoginIntegration,
  visionSupportFor,
} from "./index.js";
import type {
  ApiStyle,
  BillingModeDef,
  HarnessId,
  ModelDef,
  ModelSelection,
  ServiceDef,
} from "./index.js";
import { formatModelName } from "../../../client/utils/format-model.js";

// Widen literal rows so invariant checks can index all API styles.
const CATALOGUE: readonly ServiceDef[] = SERVICES;

function everyRow(): { service: ServiceDef; mode: BillingModeDef; model: ModelDef }[] {
  return CATALOGUE.flatMap((service) =>
    service.modes.flatMap((mode) => mode.models.map((model) => ({ service, mode, model }))),
  );
}

describe("no shipped row still carries a sentinel", () => {
  it.each(everyRow().map((r) => [`${r.service.id}/${r.mode.kind}/${r.model.id}`, r] as const))(
    "%s has a real price",
    (_label, row) => {
      expect(isPriceSentinel(row.model.price)).toBe(false);
    },
  );

  it.each(everyRow().map((r) => [`${r.service.id}/${r.mode.kind}/${r.model.id}`, r] as const))(
    "%s has a real context window",
    (_label, row) => {
      expect(isContextSentinel(row.model.contextWindow)).toBe(false);
    },
  );

  it("prices are per million tokens and output is never cheaper than input", () => {
    for (const { service, mode, model } of everyRow()) {
      const where = `${service.id}/${mode.kind}/${model.id}`;
      if (model.price.input > 0) expect(model.price.input, where).toBeGreaterThan(0.001);
      expect(model.price.input, where).toBeLessThan(1000);
      expect(model.price.output, where).toBeGreaterThanOrEqual(model.price.input);
      expect(model.price.cacheRead, where).toBeLessThanOrEqual(model.price.input);
      expect(model.price.cacheWrite, where).toBeGreaterThanOrEqual(0);
    }
  });

  it("a gateway prices a model independently of the vendor that makes it", () => {
    const direct = (modelId: string) =>
      getModel({ serviceId: "deepseek", billingMode: "key", modelId });
    const or = (modelId: string) => getModel({ serviceId: "openrouter", billingMode: "key", modelId });
    const vercel = (modelId: string) => getModel({ serviceId: "vercel", billingMode: "key", modelId });

    expect(or("deepseek/deepseek-v4-pro")?.price.input).not.toBe(direct("deepseek-v4-pro")!.price.input);
    expect(vercel("deepseek/deepseek-v4-pro")?.price.input).not.toBe(direct("deepseek-v4-pro")!.price.input);
    expect(or("deepseek/deepseek-v4-flash")?.price.input).not.toBe(
      vercel("deepseek/deepseek-v4-flash")?.price.input,
    );
    expect(or("google/gemini-3.7-flash")?.price.input).not.toBe(
      vercel("google/gemini-3.7-flash")?.price.input,
    );
  });
});

describe("a model's declared styles are reachable", () => {
  it("every model style has an endpoint on its own mode", () => {
    for (const { service, mode, model } of everyRow()) {
      for (const style of model.styles) {
        expect(
          mode.endpoints[style],
          `${service.id}/${mode.kind}/${model.id} declares ${style} with no endpoint`,
        ).toBeTruthy();
      }
    }
  });

  it("every model declares at least one style", () => {
    for (const { service, mode, model } of everyRow()) {
      expect(model.styles.length, `${service.id}/${mode.kind}/${model.id}`).toBeGreaterThan(0);
    }
  });
});

describe("model identity and lineage (docs/261 req 4)", () => {
  it("every offering declares both fields, from the declared sets", () => {
    for (const { service, mode, model } of everyRow()) {
      const where = `${service.id}/${mode.kind}/${model.id}`;
      expect(model.canonicalModelKey, `${where} has no canonicalModelKey`).toBeTruthy();
      expect(MODEL_FAMILY_IDS, `${where} declares an unknown family`).toContain(model.family);
    }
  });

  it("every authored pair is one the shared declaration carries", () => {
    for (const { service, mode, model } of everyRow()) {
      const declared = MODEL_IDENTITY_BY_KEY[model.canonicalModelKey];
      const where = `${service.id}/${mode.kind}/${model.id}`;
      expect(declared, `${where} names an undeclared canonical model`).toBeTruthy();
      expect(declared?.family, `${where} disagrees with the declared family`).toBe(model.family);
    }
  });

  it("every row's id reduces to its own canonical key, or is a declared alias", () => {
    for (const { service, mode, model } of everyRow()) {
      const where = `${service.id}/${mode.kind}/${model.id}`;
      const alias = MODEL_ID_ALIASES[model.id];
      if (alias !== undefined) {
        expect(alias, `${where} is declared an alias of a different model`).toBe(
          model.canonicalModelKey,
        );
        continue;
      }
      expect(
        normalizeModelIdForIdentity(model.id),
        `${where} names an identity its id does not match — either the wrong `
          + `MODEL_IDENTITIES entry was spread, or it needs a MODEL_ID_ALIASES entry`,
      ).toBe(model.canonicalModelKey);
    }
  });

  it("no billing mode offers the same canonical model twice", () => {
    for (const service of CATALOGUE) {
      for (const mode of service.modes) {
        const keys = mode.models.map((m) => m.canonicalModelKey);
        expect(
          new Set(keys).size,
          `${service.id}/${mode.kind} offers one canonical model under two rows`,
        ).toBe(keys.length);
      }
    }
  });

  it("declares no alias for a row that does not exist", () => {
    const ids = new Set(everyRow().map((r) => r.model.id));
    for (const id of Object.keys(MODEL_ID_ALIASES)) {
      expect(ids, `${id} is aliased and offered nowhere`).toContain(id);
    }
  });

  it("every member of a canonicalModelKey group agrees on its family", () => {
    const byKey = new Map<string, { family: string; where: string }>();
    for (const { service, mode, model } of everyRow()) {
      const where = `${service.id}/${mode.kind}/${model.id}`;
      const seen = byKey.get(model.canonicalModelKey);
      if (!seen) {
        byKey.set(model.canonicalModelKey, { family: model.family, where });
        continue;
      }
      expect(model.family, `${where} disagrees with ${seen.where}`).toBe(seen.family);
    }
  });

  it("a gateway-served model IS the vendor-served one", () => {
    const direct = getModel({ serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" });
    const gateway = getModel({
      serviceId: "openrouter",
      billingMode: "key",
      modelId: "anthropic/claude-opus-5",
    });
    expect(direct?.canonicalModelKey).toBe(gateway?.canonicalModelKey);
    expect(direct?.id).not.toBe(gateway?.id);
  });

  it("GLM's two spellings are one model", () => {
    const plan = getModel({ serviceId: "zai", billingMode: "sub", modelId: "glm-5.2[1m]" });
    const key = getModel({ serviceId: "zai", billingMode: "key", modelId: "glm-5.2" });
    expect(plan?.canonicalModelKey).toBe(key?.canonicalModelKey);
  });

  it("siblings share a family and differ as models", () => {
    const opus = getModel({ serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" });
    const sonnet = getModel({ serviceId: "anthropic", billingMode: "sub", modelId: "claude-sonnet-5" });
    expect(opus?.family).toBe(sonnet?.family);
    expect(opus?.canonicalModelKey).not.toBe(sonnet?.canonicalModelKey);
  });

  it("one model under two gateway namespaces stays one model", () => {
    const pairs = [
      { or: "x-ai/grok-4.6", vercel: "xai/grok-4.6", key: "grok-4.6", family: "grok" },
      {
        or: "qwen/qwen3.8-max",
        vercel: "alibaba/qwen3.8-max",
        key: "qwen3.8-max",
        family: "qwen",
      },
    ] as const;
    for (const pair of pairs) {
      const or = getModel({ serviceId: "openrouter", billingMode: "key", modelId: pair.or });
      const vercel = getModel({ serviceId: "vercel", billingMode: "key", modelId: pair.vercel });
      expect(or?.canonicalModelKey, `${pair.or} is missing or misidentified`).toBe(pair.key);
      expect(vercel?.canonicalModelKey, `${pair.vercel} is missing or misidentified`).toBe(pair.key);
      expect(or?.family).toBe(pair.family);
      expect(vercel?.family).toBe(pair.family);
      expect(or?.id).not.toBe(vercel?.id);
    }
  });

  it("declares no identity no row uses", () => {
    const used = new Set(everyRow().map((r) => r.model.canonicalModelKey));
    for (const entry of Object.values(MODEL_IDENTITIES)) {
      expect(used, `${entry.canonicalModelKey} is declared and unused`).toContain(
        entry.canonicalModelKey,
      );
    }
  });

  it("reports a selection's identity, and nothing for a triple naming no row", () => {
    expect(
      modelIdentityFor({ serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4-pro" }),
    ).toEqual({ canonicalModelKey: "deepseek-v4-pro", family: "deepseek" });
    expect(
      modelIdentityFor({ serviceId: "deepseek", billingMode: "key", modelId: "nope" }),
    ).toBeUndefined();
  });

});

describe("the selection triple names exactly one row", () => {
  it("a service holds at most one mode per kind", () => {
    for (const service of CATALOGUE) {
      const kinds = service.modes.map((m) => m.kind);
      expect(new Set(kinds).size, `${service.id} has duplicate billing modes`).toBe(kinds.length);
    }
  });

  it("a mode holds no duplicate model id", () => {
    for (const service of CATALOGUE) {
      for (const mode of service.modes) {
        const ids = mode.models.map((m) => m.id);
        expect(new Set(ids).size, `${service.id}/${mode.kind} has a duplicate model id`).toBe(ids.length);
      }
    }
  });

  it("service ids are unique", () => {
    const ids = SERVICES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("every mode can be authenticated", () => {
  it("declares at least one credential shape", () => {
    for (const service of CATALOGUE) {
      for (const mode of service.modes) {
        expect(mode.credentials.length, `${service.id}/${mode.kind}`).toBeGreaterThan(0);
      }
    }
  });

  it("a subscription mode names the reader that fills its indicator", () => {
    for (const service of CATALOGUE) {
      for (const mode of service.modes) {
        if (mode.kind !== "sub") continue;
        expect(Object.hasOwn(mode, "quota"), `${service.id}/sub declares no quota field`).toBe(true);
        expect(typeof mode.quota, `${service.id}/sub quota must be a reader id`).toBe("string");
      }
    }
  });
});

describe("quota integrations that are implemented, and those that can be re-read (planning#339)", () => {
  it.each([
    ["anthropic", true, true],
    ["openai", true, false],
    ["zai", true, true],
    ["opencode", false, false],
    ["xai", true, true],
  ])("%s: reports quota %s, refreshable %s", (serviceId, reports, refreshable) => {
    expect(modeReportsQuota(serviceId, "sub")).toBe(reports);
    expect(subQuotaRefreshable(serviceId)).toBe(refreshable);
  });

  it("a key mode never reports a quota and is never refreshable", () => {
    for (const service of CATALOGUE) {
      if (!service.modes.some((mode) => mode.kind === "key")) continue;
      expect(modeReportsQuota(service.id, "key"), `${service.id}/key`).toBe(false);
      if (!service.modes.some((mode) => mode.kind === "sub")) {
        expect(subQuotaRefreshable(service.id), service.id).toBe(false);
      }
    }
  });

  it("nothing is refreshable without also reporting", () => {
    for (const service of CATALOGUE) {
      if (subQuotaRefreshable(service.id)) {
        expect(modeReportsQuota(service.id, "sub"), service.id).toBe(true);
      }
    }
  });
});

describe("retirement records keep a session able to take a turn (req 13)", () => {
  it("names a successor for every style the retired model was declared under", () => {
    for (const service of CATALOGUE) {
      for (const mode of service.modes) {
        for (const retired of mode.retired) {
          expect(retired.styles.length, `${service.id}/${mode.kind}/${retired.id}`).toBeGreaterThan(0);
          for (const style of retired.styles) {
            const successorId = retired.successors[style];
            expect(
              successorId,
              `${service.id}/${mode.kind}: ${retired.id} has no successor for ${style}`,
            ).toBeTruthy();
          }
        }
      }
    }
  });

  it("resolves each successor to a current model of the SAME mode, under that style", () => {
    for (const service of CATALOGUE) {
      for (const mode of service.modes) {
        for (const retired of mode.retired) {
          for (const [style, successorId] of Object.entries(retired.successors)) {
            const successor = mode.models.find((m) => m.id === successorId);
            expect(
              successor,
              `${service.id}/${mode.kind}: successor ${successorId} is not a current model of this mode`,
            ).toBeDefined();
            expect(
              successor?.styles.includes(style as ApiStyle),
              `${service.id}/${mode.kind}: successor ${successorId} is not declared under ${style}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("never retires an id that is still a current model of the same mode", () => {
    for (const service of CATALOGUE) {
      for (const mode of service.modes) {
        for (const retired of mode.retired) {
          expect(
            mode.models.some((m) => m.id === retired.id),
            `${service.id}/${mode.kind}: ${retired.id} is both retired and current`,
          ).toBe(false);
        }
      }
    }
  });
});

describe("resolving a retired model (req 13, phase 8)", () => {
  const RETIRED: ModelSelection = { serviceId: "openai", billingMode: "sub", modelId: "gpt-5.6" };

  it("moves a pinned selection onto the successor of its OWN service and mode", () => {
    expect(retirementSuccessor("codex", RETIRED)).toEqual({
      serviceId: "openai",
      billingMode: "sub",
      modelId: "gpt-5.6-sol",
    });
    expect(retirementSuccessor("codex", { ...RETIRED, billingMode: "key" })).toEqual({
      serviceId: "openai",
      billingMode: "key",
      modelId: "gpt-5.6-sol",
    });
  });

  it("never crosses the service or the billing mode", () => {
    for (const harness of HARNESSES) {
      for (const service of CATALOGUE) {
        for (const mode of service.modes) {
          for (const retired of mode.retired) {
            const successor = retirementSuccessor(harness.id, {
              serviceId: service.id,
              billingMode: mode.kind,
              modelId: retired.id,
            });
            if (!successor) continue;
            expect(successor.serviceId, `${service.id}/${mode.kind}`).toBe(service.id);
            expect(successor.billingMode, `${service.id}/${mode.kind}`).toBe(mode.kind);
          }
        }
      }
    }
  });

  it("only ever lands on a model the harness can actually run", () => {
    for (const harness of HARNESSES) {
      for (const service of CATALOGUE) {
        for (const mode of service.modes) {
          for (const retired of mode.retired) {
            const successor = retirementSuccessor(harness.id, {
              serviceId: service.id,
              billingMode: mode.kind,
              modelId: retired.id,
            });
            if (!successor) continue;
            const model = getModel(successor);
            expect(model, `${harness.id}: ${successor.modelId}`).toBeDefined();
            expect(
              resolveStyle(harness.id, model!),
              `${harness.id} cannot speak to successor ${successor.modelId}`,
            ).toBeDefined();
          }
        }
      }
    }
  });

  it("offers nothing to a harness that speaks none of the retired model's styles", () => {
    expect(retirementSuccessor("claude", RETIRED)).toBeUndefined();
  });

  it("says nothing about a model that is still current, or that never existed", () => {
    expect(
      retirementSuccessor("codex", { ...RETIRED, modelId: "gpt-5.6-sol" }),
    ).toBeUndefined();
    expect(retirementSuccessor("codex", { ...RETIRED, modelId: "nope" })).toBeUndefined();
    expect(
      retirementSuccessor("codex", { ...RETIRED, serviceId: "nope" }),
    ).toBeUndefined();
  });

  it("resolves a BARE retired id for a caller that has no service", () => {
    expect(resolveRetiredModelId("codex", "gpt-5.6", "openai")).toEqual({
      serviceId: "openai",
      billingMode: "sub",
      modelId: "gpt-5.6-sol",
    });
    expect(resolveRetiredModelId("claude", "gpt-5.6", "openai")).toBeUndefined();
    expect(resolveRetiredModelId("codex", undefined)).toBeUndefined();
  });

  it("does not answer for a service other than the one asked about", () => {
    const CONTESTED = "claude-fable-5";
    expect(
      CATALOGUE.find((s) => s.id === "anthropic")!
        .modes.some((m) => m.retired.some((r) => r.id === CONTESTED)),
    ).toBe(true);
    expect(
      CATALOGUE.find((s) => s.id === "opencode")!
        .modes.some((m) => m.models.some((model) => model.id === CONTESTED)),
    ).toBe(true);

    expect(
      retirementSuccessor("claude", { serviceId: "opencode", billingMode: "key", modelId: CONTESTED }),
    ).toBeUndefined();
    expect(
      retirementSuccessor("claude", { serviceId: "anthropic", billingMode: "sub", modelId: CONTESTED }),
    ).toEqual({ serviceId: "anthropic", billingMode: "sub", modelId: "claude-fable-5-1" });

    expect(retirementSuccessor("codex", { serviceId: "anthropic", billingMode: "sub", modelId: "gpt-5.6" })).toBeUndefined();
  });
});

describe("harnesses", () => {
  it("declare at least one style and one credential destination", () => {
    for (const harness of HARNESSES) {
      expect(harness.styles.length, harness.id).toBeGreaterThan(0);
      const targets = harness.spawn.credential;
      expect(
        Boolean(targets.string ?? targets.account),
        `${harness.id} can authenticate nothing at all`,
      ).toBe(true);
    }
  });

  it("name a native service that exists", () => {
    for (const harness of HARNESSES) {
      if (!harness.nativeService) continue;
      expect(
        SERVICES.some((s) => s.id === harness.nativeService),
        `${harness.id} names unknown native service ${harness.nativeService}`,
      ).toBe(true);
    }
  });

  it("resolve a style for every model they join with, and an endpoint with it", () => {
    for (const harness of HARNESSES) {
      for (const entry of catalogueEntriesForHarness(harness.id)) {
        const style = resolveStyle(harness.id, entry.model);
        expect(style, `${harness.id} joined ${entry.model.id} with no style`).toBeDefined();
        expect(
          resolveEndpoint(harness.id, entry.selection),
          `${harness.id}/${entry.service.id}/${entry.model.id} has no endpoint`,
        ).toBeTruthy();
      }
    }
  });
});

describe("the harness\u00d7service join", () => {
  it("leads with the harness's own vendor, in the order the picker had", () => {
    expect(catalogueModelIdsForHarness("claude").slice(0, 4)).toEqual([
      "claude-opus-5",
      "claude-sonnet-5",
      "haiku",
      "claude-fable-5-1",
    ]);
    expect(catalogueModelIdsForHarness("codex").slice(0, 10)).toEqual([
      "gpt-5.6-sol",
      "gpt-6-astra",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.3-codex-spark",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.5",
      "gpt-5.3-codex",
      "gpt-5.2",
    ]);
  });

  it("offers GPT-6 Astra through both OpenAI billing modes without making it the default", () => {
    const selections = (["sub", "key"] as const).map((billingMode) => ({
      billingMode,
      model: getModel({ serviceId: "openai", billingMode, modelId: "gpt-6-astra" }),
    }));

    for (const { billingMode, model } of selections) {
      expect(model, `openai/${billingMode}`).toMatchObject({
        label: "GPT-6 Astra",
        canonicalModelKey: "gpt-6-astra",
        family: "gpt",
        contextWindow: { default: 272_000 },
        price: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      });
      expect(model?.styles).toEqual(["openai-responses"]);
    }
    const keySelection = {
      serviceId: "openai",
      billingMode: "key" as const,
      modelId: "gpt-6-astra",
    };
    expect(reasoningOptionsFor("codex", keySelection).map((option) => option.value))
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(reasoningOptionsFor("grok", keySelection)).toEqual([]);
    expect(catalogueModelIdsForHarness("codex")[0]).toBe("gpt-5.6-sol");
    expect(visionSupportFor({ serviceId: "openai", billingMode: "sub", modelId: "gpt-6-astra" }))
      .toBe("yes");
  });

  it("offers Codex Spark only through the OpenAI subscription", () => {
    const sub = getModel({
      serviceId: "openai",
      billingMode: "sub",
      modelId: "gpt-5.3-codex-spark",
    });
    const key = getModel({
      serviceId: "openai",
      billingMode: "key",
      modelId: "gpt-5.3-codex-spark",
    });
    const proxy = getModel({
      serviceId: "openai",
      billingMode: "key",
      modelId: "gpt-5.3-codex",
    });

    expect(sub?.price).toEqual(proxy?.price);
    expect(key).toBeUndefined();
  });

  it("reaches services the harness shares a style with, and no others", () => {
    expect(catalogueModelIdsForHarness("claude")).toContain("deepseek-flash");
    expect(catalogueModelIdsForHarness("codex")).toContain("deepseek-flash");
    expect(catalogueModelIdsForHarness("codex")).toContain("deepseek-v4-pro");
    expect(catalogueModelIdsForHarness("codex")).toContain("openai/gpt-5.6-sol");
    expect(catalogueModelIdsForHarness("claude")).toContain("anthropic/claude-opus-5");
    expect(catalogueModelIdsForHarness("codex")).toContain("deepseek/deepseek-v4-flash");
    expect(catalogueModelIdsForHarness("codex")).toContain("deepseek/deepseek-v4-pro");
    expect(catalogueModelIdsForHarness("codex")).not.toContain("anthropic/claude-opus-5");
    expect(catalogueModelIdsForHarness("codex")).not.toContain("z-ai/glm-5.2");
  });
});

describe("eligibility (req 8)", () => {
  const deepseekKey = { serviceId: "deepseek", billingMode: "key" as const, via: "string" as const };
  const openaiKey = { serviceId: "openai", billingMode: "key" as const, via: "string" as const };
  const openaiAccount = { serviceId: "openai", billingMode: "sub" as const, via: "account" as const };
  const anthropicAccount = {
    serviceId: "anthropic",
    billingMode: "sub" as const,
    via: "account" as const,
  };

  it("offers nothing at all when no credential is configured", () => {
    expect(eligibleEntriesForHarness("claude", [])).toEqual([]);
    expect(eligibleEntriesForHarness("codex", [])).toEqual([]);
  });

  it("offers Codex Spark to an OpenAI subscription, never an OpenAI API key", () => {
    const spark = {
      serviceId: "openai",
      billingMode: "sub" as const,
      modelId: "gpt-5.3-codex-spark",
    };
    expect(isSelectionEligible("codex", spark, [openaiAccount])).toBe(true);
    expect(
      isSelectionEligible("codex", { ...spark, billingMode: "key" }, [openaiKey]),
    ).toBe(false);
  });

  it("req 2: a DeepSeek key alone makes Claude Code runnable, with no Anthropic row", () => {
    const entries = eligibleEntriesForHarness("claude", [deepseekKey]);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.selection.serviceId === "deepseek")).toBe(true);
    expect(
      isSelectionEligible(
        "claude",
        { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" },
        [deepseekKey],
      ),
    ).toBe(false);
  });

  it("correlates the CONFIGURED route's shape with what the harness can carry", () => {
    expect(harnessCanCarry("claude", anthropicAccount)).toBe(true);
    expect(
      harnessCanCarry("claude", { serviceId: "deepseek", billingMode: "key", via: "account" }),
    ).toBe(false);
  });
});

describe("support before a credential exists (the add-service table)", () => {
  it("answers per service what the join and the credential shapes allow", () => {
    expect(harnessSupportsService("claude", "zai")).toBe(true);
    expect(harnessSupportsService("codex", "zai")).toBe(false);
    expect(harnessSupportsService("claude", "openrouter")).toBe(true);
    expect(harnessSupportsService("codex", "openrouter")).toBe(true);
    expect(harnessSupportsService("codex", "openai")).toBe(true);
    expect(harnessSupportsService("claude", "openai")).toBe(false);
    expect(harnessSupportsService("claude", "deepseek")).toBe(true);
    expect(harnessSupportsService("codex", "deepseek")).toBe(true);
  });

  it("is the SAME answer eligibility gives once that credential is added", () => {
    for (const service of allServices()) {
      for (const mode of service.modes) {
        for (const harness of allHarnesses()) {
          const credentials = mode.credentials.map((c) => ({
            serviceId: service.id,
            billingMode: mode.kind,
            via: c.via,
          }));
          expect(harnessSupportsMode(harness.id, service.id, mode.kind)).toBe(
            eligibleEntriesForHarness(harness.id, credentials).length > 0,
          );
        }
      }
    }
  });

  it("is not hiding a per-shape difference behind one mode cell", () => {
    for (const service of allServices()) {
      for (const harness of allHarnesses()) {
        for (const mode of service.modes) {
          const answers = new Set<boolean>();
          for (const credential of mode.credentials) {
            answers.add(
              eligibleEntriesForHarness(harness.id, [
                { serviceId: service.id, billingMode: mode.kind, via: credential.via },
              ]).length > 0,
            );
          }
          expect({ service: service.id, harness: harness.id, mode: mode.kind, answers: answers.size }).toEqual({
            service: service.id,
            harness: harness.id,
            mode: mode.kind,
            answers: 1,
          });
        }
      }
    }
  });

  it("the tri-state service cell matches the per-mode truth, and disagreement is real (docs/268)", () => {
    for (const service of allServices()) {
      for (const harness of allHarnesses()) {
        const answers = service.modes.map((mode) =>
          harnessSupportsMode(harness.id, service.id, mode.kind),
        );
        const expected = answers.every(Boolean) ? "all" : answers.some(Boolean) ? "some" : "none";
        expect({ service: service.id, harness: harness.id, support: harnessServiceSupport(harness.id, service.id) })
          .toEqual({ service: service.id, harness: harness.id, support: expected });
      }
    }
    expect(harnessServiceSupport("opencode", "anthropic")).toBe("some");
    expect(harnessServiceSupport("opencode", "openai")).toBe("all");
    expect(harnessSupportsMode("opencode", "anthropic", "sub")).toBe(false);
    expect(harnessSupportsMode("opencode", "anthropic", "key")).toBe(true);
    expect(harnessSupportsMode("opencode", "zai", "sub")).toBe(false);
    expect(harnessSupportsMode("opencode", "zai", "key")).toBe(true);
    expect(harnessServiceSupport("opencode", "zai")).toBe("some");
    expect(harnessServiceSupport("claude", "anthropic")).toBe("all");
  });

  it("a harness that cannot override its endpoint joins only its own vendor", () => {
    // No current harness declares "none"; adding one must not expose foreign endpoints.
    for (const harness of allHarnesses()) {
      if (harness.spawn.endpoint.kind !== "none") continue;
      for (const entry of catalogueEntriesForHarness(harness.id)) {
        expect(entry.selection.serviceId).toBe(harness.nativeService);
      }
    }
  });

  it("never overrides a credential destination for a harness that has no default one", () => {
    for (const service of allServices()) {
      for (const mode of service.modes) {
        for (const credential of mode.credentials) {
          if (credential.via !== "string") continue;
          for (const harnessId of Object.keys(credential.targetOverride ?? {})) {
            expect(harnessCredentialTarget(harnessId as HarnessId, "string")).toBeDefined();
          }
        }
      }
    }
  });

  it("says no about a service or mode the catalogue does not have", () => {
    expect(harnessSupportsService("claude", "not-a-service")).toBe(false);
    expect(harnessSupportsMode("claude", "deepseek", "sub")).toBe(false);
  });
});

describe("spawn shaping", () => {
  it("materializes DeepSeek's key into Claude Code's own variable, at DeepSeek's endpoint", () => {
    const shaping = resolveSpawnShaping("claude", {
      serviceId: "deepseek",
      billingMode: "key",
      modelId: "deepseek-flash",
    });
    expect(shaping?.style).toBe("anthropic-messages");
    expect(shaping?.endpoint.url).toBe("https://api.deepseek.com/anthropic");
    expect(shaping?.credential).toEqual({
      sourceEnv: "DEEPSEEK_API_KEY",
      target: { kind: "env", name: "ANTHROPIC_API_KEY" },
    });
  });

  it("materializes DeepSeek's key into Codex's own variable, at its Responses endpoint", () => {
    const shaping = resolveSpawnShaping("codex", {
      serviceId: "deepseek",
      billingMode: "key",
      modelId: "deepseek-flash",
    });
    expect(shaping?.style).toBe("openai-responses");
    expect(shaping?.endpoint.url).toBe("https://api.deepseek.com/v1");
    expect(shaping?.credential).toEqual({
      sourceEnv: "DEEPSEEK_API_KEY",
      target: { kind: "env", name: "OPENAI_API_KEY" },
    });
  });

  it("points Codex at OpenRouter's Responses base, which is NOT its Anthropic one", () => {
    const codex = resolveSpawnShaping("codex", {
      serviceId: "openrouter",
      billingMode: "key",
      modelId: "deepseek/deepseek-v4-flash",
    });
    expect(codex?.style).toBe("openai-responses");
    expect(codex?.endpoint.url).toBe("https://openrouter.ai/api/v1");
    expect(codex?.credential).toEqual({
      sourceEnv: "OPENROUTER_API_KEY",
      target: { kind: "env", name: "OPENAI_API_KEY" },
    });

    const claude = resolveSpawnShaping("claude", {
      serviceId: "openrouter",
      billingMode: "key",
      modelId: "deepseek/deepseek-v4-flash",
    });
    expect(claude?.style).toBe("anthropic-messages");
    expect(claude?.endpoint.url).toBe("https://openrouter.ai/api");
  });

  it("honours a mode's targetOverride — GLM's plan is a bearer token, not an x-api-key", () => {
    const shaping = resolveSpawnShaping("claude", {
      serviceId: "zai",
      billingMode: "sub",
      modelId: "glm-5.2[1m]",
    });
    expect(shaping?.credential).toEqual({
      sourceEnv: "ZAI_CODING_PLAN_KEY",
      target: { kind: "env", name: "ANTHROPIC_AUTH_TOKEN" },
    });
  });

  it("keeps Anthropic's subscription token a bearer token, not an x-api-key (planning#354)", () => {
    const shaping = resolveSpawnShaping("claude", {
      serviceId: "anthropic",
      billingMode: "sub",
      modelId: "claude-opus-5",
    });
    expect(shaping?.credential).toEqual({
      sourceEnv: "ANTHROPIC_AUTH_TOKEN",
      target: { kind: "env", name: "ANTHROPIC_AUTH_TOKEN" },
    });
    expect(spawnCredentialTarget("claude", "anthropic", "sub")).toEqual({
      kind: "env",
      name: "ANTHROPIC_AUTH_TOKEN",
    });
  });

  it("has nothing to shape for a selection the harness shares no style with", () => {
    expect(
      resolveSpawnShaping("codex", {
        serviceId: "openrouter",
        billingMode: "key",
        modelId: "anthropic/claude-opus-5",
      }),
    ).toBeUndefined();
  });

  it("keeps the first-frame context windows the old table reported", () => {
    const windows = catalogueContextWindows();
    expect(windows["claude-opus-5"]).toBe(1_000_000);
    expect(windows["claude-sonnet-5"]).toBe(1_000_000);
    expect(windows["claude-fable-5"]).toBe(1_000_000);
    expect(windows["claude-fable-5-1"]).toBe(1_000_000);
    expect(windows.haiku).toBe(200_000);
    expect(windows["gpt-6-astra"]).toBe(272_000);
    expect(windows["gpt-5.6-sol"]).toBe(272_000);
    expect(windows["gpt-5.2"]).toBe(272_000);
  });

  it("keeps EVERY display label the client's hand-kept record reported", () => {
    const labels = catalogueModelLabels();
    const PRE_CATALOGUE_LABELS: Record<string, string> = {
      "claude-opus-5": "Opus 5",
      "claude-sonnet-5": "Sonnet 5",
      "haiku": "Haiku 4.5",
      "claude-fable-5": "Fable 5",
      "gpt-5.6-sol": "GPT-5.6 Sol",
      "gpt-5.6-terra": "GPT-5.6 Terra",
      "gpt-5.6-luna": "GPT-5.6 Luna",
      "gpt-5.3-codex-spark": "GPT-5.3 Codex Spark",
      "gpt-5.5": "GPT-5.5",
      "gpt-5.4": "GPT-5.4",
      "gpt-5.4-mini": "GPT-5.4 Mini",
      "gpt-5.3-codex": "GPT-5.3 Codex",
      "gpt-5.2": "GPT-5.2",
    };
    for (const [id, label] of Object.entries(PRE_CATALOGUE_LABELS)) {
      expect(labels[id], id).toBe(label);
      expect(formatModelName(id), id).toBe(label);
    }
  });

  it("keeps the labels for ids the catalogue has no row for", () => {
    expect(formatModelName("sonnet")).toBe("Sonnet 5");
    expect(formatModelName("claude-opus-4-8")).toBe("Opus 4.8");
    expect(formatModelName("gpt-5.6")).toBe("GPT-5.6 Sol");
  });
});

describe("the launch catalogue is a requirement, not a capability (req 15)", () => {
  it("ships every service req 15 names", () => {
    const ids = SERVICES.map((s) => s.id);
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai");
    expect(ids).toContain("deepseek");
    expect(ids).toContain("openrouter");
    expect(ids).toContain("vercel");
    expect(ids).toContain("zai");
  });

  it("gives GLM both billing modes, so the mechanism ships exercised on a custom service", () => {
    const zai = CATALOGUE.find((s) => s.id === "zai");
    expect(zai?.modes.map((m) => m.kind).sort()).toEqual(["key", "sub"]);
  });

  it("carries Anthropic and OpenAI as ordinary rows with both modes", () => {
    for (const id of ["anthropic", "openai"]) {
      const service = CATALOGUE.find((s) => s.id === id);
      expect(service?.modes.map((m) => m.kind).sort(), id).toEqual(["key", "sub"]);
    }
  });

  it("carries OpenCode's two products as two modes of one service (docs/272)", () => {
    const opencode = CATALOGUE.find((s) => s.id === "opencode");
    expect(opencode?.name).toBe("OpenCode");
    expect(opencode?.modes.map((m) => m.kind).sort()).toEqual(["key", "sub"]);
    expect(resolveEndpoint("opencode", { serviceId: "opencode", billingMode: "key", modelId: "claude-opus-5" }))
      .toBe("https://opencode.ai/zen");
    expect(resolveEndpoint("opencode", { serviceId: "opencode", billingMode: "key", modelId: "glm-5.2" }))
      .toBe("https://opencode.ai/zen/v1");
    expect(resolveEndpoint("opencode", { serviceId: "opencode", billingMode: "sub", modelId: "glm-5.3" }))
      .toBe("https://opencode.ai/zen/go/v1");
    expect(resolveEndpoint("codex", { serviceId: "opencode", billingMode: "key", modelId: "gpt-5.6-sol" }))
      .toBe("https://opencode.ai/zen/v1");
    expect(resolveEndpoint("codex", { serviceId: "opencode", billingMode: "sub", modelId: "gpt-5.6-luna" }))
      .toBe("https://opencode.ai/zen/go/v1");
  });

  it("serves Codex only the models each OpenCode product actually has (docs/272 §7)", () => {
    const idsFor = (billingMode: "key" | "sub") =>
      catalogueEntriesForHarness("codex")
        .filter((e) => e.service.id === "opencode" && e.mode.kind === billingMode)
        .map((e) => e.model.id);
    expect(idsFor("key").sort()).toEqual(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "grok-4.6"]);
    expect(idsFor("sub")).toEqual(["gpt-5.6-luna"]);
    for (const entry of catalogueEntriesForHarness("codex").filter((e) => e.service.id === "opencode")) {
      expect(entry.model.styles, entry.model.id).toEqual(["openai-responses"]);
    }
  });

  it("prices OpenCode's models as OpenCode, not as the vendors that make them", () => {
    const zen = (modelId: string) => getModel({ serviceId: "opencode", billingMode: "key", modelId });
    const go = (modelId: string) => getModel({ serviceId: "opencode", billingMode: "sub", modelId });
    expect(zen("claude-sonnet-5")!.price.input).toBeLessThan(
      getModel({ serviceId: "anthropic", billingMode: "key", modelId: "claude-sonnet-5" })!.price.input,
    );
    expect(zen("deepseek-v4-pro")!.price.input).toBeGreaterThan(
      getModel({ serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4-pro" })!.price.input,
    );
    expect(go("deepseek-v4-pro")!.price.input).not.toBe(zen("deepseek-v4-pro")!.price.input);
    expect(zen("gpt-5.6-terra")!.price.input).toBeGreaterThan(
      getModel({ serviceId: "openai", billingMode: "key", modelId: "gpt-5.6-terra" })!.price.input,
    );
    expect(go("gpt-5.6-luna")!.price.input).toBeLessThan(zen("gpt-5.6-luna")!.price.input);
  });

  it("names OpenCode's own inference as its harness's native service (docs/272)", () => {
    expect(HARNESSES.find((h) => h.id === "opencode")?.nativeService).toBe("opencode");
    expect(loginIntegrationForService("opencode")).toBeUndefined();
    expect(harnessForNativeService("opencode")).toBe("opencode");
  });

  it("offers OpenCode's inference to the harnesses whose pair was measured, and to no others", () => {
    const zenKey = { serviceId: "opencode", billingMode: "key" as const, via: "string" as const };
    const goKey = { serviceId: "opencode", billingMode: "sub" as const, via: "string" as const };
    for (const harness of ["opencode", "codex"] as const) {
      expect(eligibleEntriesForHarness(harness, [zenKey]).length, harness).toBeGreaterThan(0);
      expect(eligibleEntriesForHarness(harness, [goKey]).length, harness).toBeGreaterThan(0);
      expect(harnessSupportsService(harness, "opencode"), harness).toBe(true);
    }
    expect(eligibleEntriesForHarness("claude", [zenKey, goKey])).toEqual([]);
    expect(harnessSupportsService("claude", "opencode")).toBe(false);
    expect(
      catalogueEntriesForHarness("claude").some((e) => e.service.id === "opencode"),
    ).toBe(true);
  });

  it("lets a gateway offer a vendor's models to someone with no account there", () => {
    const viaGateway = catalogueEntriesForHarness("claude").filter(
      (e) => e.service.id === "openrouter",
    );
    expect(viaGateway.map((e) => e.model.id)).toContain("anthropic/claude-opus-5");
  });
});

describe("resolving a bare model id", () => {
  it("takes the first service and mode declaring it", () => {
    expect(resolveModelSelection("claude-opus-5")).toEqual({
      serviceId: "anthropic",
      billingMode: "sub",
      modelId: "claude-opus-5",
    });
  });

  it("honours a preferred service without being constrained by it", () => {
    expect(resolveModelSelection("deepseek-flash", "deepseek")?.serviceId).toBe("deepseek");
    expect(resolveModelSelection("deepseek-flash", "opencode")?.serviceId).toBe("opencode");
    expect(resolveModelSelection("claude-opus-5", "openrouter")?.serviceId).toBe("anthropic");
  });

  it("returns undefined for an id the catalogue does not carry", () => {
    expect(resolveModelSelection("claude-sonnet-4-20250514")).toBeUndefined();
    expect(resolveModelSelection(undefined)).toBeUndefined();
    expect(resolveModelSelection("")).toBeUndefined();
  });

  it("reports every mode offering an id, so a migration can prefer one", () => {
    expect(modesOfferingModel("claude-fable-5-1")).toEqual([
      { serviceId: "anthropic", billingMode: "sub" },
      { serviceId: "anthropic", billingMode: "key" },
    ]);
    expect(resolveModelSelection("claude-fable-5-1")?.serviceId).toBe("anthropic");
    expect(modesOfferingModel("claude-fable-5")).toEqual([
      { serviceId: "opencode", billingMode: "key" },
    ]);
    expect(resolveModelSelection("claude-fable-5")?.serviceId).toBe("opencode");
    expect(modesOfferingModel("nope")).toEqual([]);
  });
});

describe("selection identity", () => {
  const sub: ModelSelection = { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" };
  const key: ModelSelection = { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" };
  const other: ModelSelection = { serviceId: "anthropic", billingMode: "sub", modelId: "haiku" };

  it("distinguishes the same model id across billing modes", () => {
    expect(sameSelection(sub, key)).toBe(false);
    expect(sameCredentialOwner(sub, key)).toBe(false);
  });

  it("treats a plain model change within one mode as the same credential owner", () => {
    expect(sameSelection(sub, other)).toBe(false);
    expect(sameCredentialOwner(sub, other)).toBe(true);
  });

  it("resolves to a real row, and reports one that does not exist", () => {
    expect(selectionExists(sub)).toBe(true);
    expect(getModel(sub)?.label).toBe("Opus 5");
    expect(selectionExists({ ...sub, modelId: "nope" })).toBe(false);
    expect(getMode("nope", "key")).toBeUndefined();
  });

  it("reports a context window for a selection, honouring the harness", () => {
    expect(contextWindowFor(sub)).toBe(1_000_000);
    expect(contextWindowFor({ ...sub, modelId: "nope" })).toBeUndefined();
  });
});

describe("the scalar wire form", () => {
  it("round-trips every shipped row, including ids with slashes and brackets", () => {
    for (const { service, mode, model } of everyRow()) {
      const selection: ModelSelection = {
        serviceId: service.id,
        billingMode: mode.kind,
        modelId: model.id,
      };
      expect(parseSelection(serializeSelection(selection))).toEqual(selection);
    }
    expect(serializeSelection({ serviceId: "zai", billingMode: "sub", modelId: "glm-5.2[1m]" }))
      .toBe("zai:sub:glm-5.2[1m]");
    expect(parseSelection("openrouter:key:anthropic/claude-opus-5")).toEqual({
      serviceId: "openrouter",
      billingMode: "key",
      modelId: "anthropic/claude-opus-5",
    });
  });

  it("rejects a bare model id, so callers can tell legacy from well-formed", () => {
    expect(parseSelection("claude-opus-5")).toBeUndefined();
    expect(parseSelection("anthropic:claude-opus-5")).toBeUndefined();
    expect(parseSelection("anthropic:nonsense:claude-opus-5")).toBeUndefined();
    expect(parseSelection("anthropic:sub:")).toBeUndefined();
    expect(parseSelection("")).toBeUndefined();
    expect(parseSelection(undefined)).toBeUndefined();
  });

  it("keeps a model id containing a colon intact", () => {
    expect(parseSelection("svc:key:vendor:model:v2")).toEqual({
      serviceId: "svc",
      billingMode: "key",
      modelId: "vendor:model:v2",
    });
  });
});

describe("credentials", () => {
  it("never reuses one storageEnv name across two modes", () => {
    const seen = new Map<string, string>();
    for (const service of allServices()) {
      for (const mode of service.modes) {
        for (const credential of mode.credentials) {
          if (credential.via !== "string") continue;
          const owner = `${service.id}:${mode.kind}`;
          const previous = seen.get(credential.storageEnv);
          expect(previous, `${credential.storageEnv} claimed by ${previous} and ${owner}`)
            .toBeUndefined();
          seen.set(credential.storageEnv, owner);
        }
      }
    }
  });

  it("resolves a storageEnv name back to its owning mode", () => {
    for (const envName of credentialStorageEnvNames()) {
      const owner = credentialModeForStorageEnv(envName);
      expect(owner, envName).toBeDefined();
      expect(storageEnvFor(owner!.serviceId, owner!.billingMode)).toBe(envName);
    }
    expect(credentialModeForStorageEnv("NOT_A_CATALOGUE_KEY")).toBeUndefined();
  });

  it("never delivers a Bearer-semantics credential as an x-api-key (planning#354)", () => {
    let checked = 0;
    for (const service of allServices()) {
      for (const mode of service.modes) {
        for (const credential of mode.credentials) {
          if (credential.via !== "string" || credential.storageEnv !== "ANTHROPIC_AUTH_TOKEN") continue;
          const where = `${service.id}:${mode.kind}`;
          for (const harness of allHarnesses()) {
            if (!harnessCanCarry(harness.id, { serviceId: service.id, billingMode: mode.kind, via: "string" })) continue;
            checked += 1;
            expect(
              spawnCredentialTarget(harness.id, service.id, mode.kind),
              `${where} → ${harness.id}`,
            ).not.toEqual({ kind: "env", name: "ANTHROPIC_API_KEY" });
          }
        }
      }
    }
    expect(checked, "the loop must bind at least one carrying harness").toBeGreaterThan(0);
  });

  it("declares at least one credential shape for every mode", () => {
    for (const service of allServices()) {
      for (const mode of service.modes) {
        expect(mode.credentials.length, `${service.id}:${mode.kind}`).toBeGreaterThan(0);
      }
    }
  });

  it("gives every harness somewhere to put a credential", () => {
    for (const harness of allHarnesses()) {
      const { string: stringTarget, account: accountTarget } = harness.spawn.credential;
      expect(stringTarget ?? accountTarget, harness.id).toBeDefined();
    }
  });

  describe("login integrations", () => {
    it("round-trips every login flow through its service", () => {
      for (const loginId of allLoginIntegrations()) {
        const serviceId = serviceForLoginIntegration(loginId);
        expect(serviceId, loginId).toBeDefined();
        expect(loginIntegrationForService(serviceId!)).toBe(loginId);
      }
    });

    it("has no login flow for a service authenticated only by a supplied string", () => {
      expect(loginIntegrationForService("deepseek")).toBeUndefined();
      expect(loginIntegrationForService("openrouter")).toBeUndefined();
    });

    it("names the harness whose home directory each login writes into", () => {
      expect(credentialHarnessForLogin("anthropic-oauth")).toBe("claude");
      expect(credentialHarnessForLogin("openai-chatgpt")).toBe("codex");
      expect(credentialHarnessForLogin("xai-oauth")).toBe("grok");
    });

    it("fans a completed sign-in out to every harness that can use the credential", () => {
      expect(harnessesForLoginIntegration("anthropic-oauth")).toEqual(["claude"]);
      expect(harnessesForLoginIntegration("openai-chatgpt")).toEqual(["codex", "opencode"]);
      expect(harnessesForLoginIntegration("xai-oauth")).toEqual(["grok"]);
    });

    it("restricts an account credential to the harnesses that can present it", () => {
      const chatgpt = getService("openai")?.modes
        .find((m) => m.kind === "sub")
        ?.credentials.find((c) => c.via === "account");
      expect(chatgpt?.carriers).toEqual(["codex", "opencode"]);
      expect(harnessCanCarry("grok", {
        serviceId: "openai", billingMode: "sub", via: "account",
      })).toBe(false);
      expect(eligibleEntriesForHarness("grok", [{
        serviceId: "openai", billingMode: "sub", via: "account",
      }])).toEqual([]);

      const xaiAccount = getService("xai")?.modes
        .find((m) => m.kind === "sub")
        ?.credentials.find((c) => c.via === "account");
      expect(xaiAccount?.carriers).toEqual(["grok"]);
      expect(harnessCanCarry("codex", {
        serviceId: "xai", billingMode: "sub", via: "account",
      })).toBe(false);
      expect(harnessCanCarry("grok", {
        serviceId: "xai", billingMode: "sub", via: "account",
      })).toBe(true);

      const anthropic = getService("anthropic")?.modes
        .find((m) => m.kind === "sub")
        ?.credentials.find((c) => c.via === "account");
      expect(anthropic?.carriers).toBeUndefined();
    });

    it("an xAI account makes subscription models eligible on Grok only", () => {
      const xaiAccount = { serviceId: "xai", billingMode: "sub" as const, via: "account" as const };
      const xaiKey = { serviceId: "xai", billingMode: "key" as const, via: "string" as const };

      const grokSub = eligibleEntriesForHarness("grok", [xaiAccount]);
      expect(grokSub.map((e) => e.model.id).sort()).toEqual(["grok-4.5", "grok-4.6"]);
      expect(grokSub.every((e) => e.selection.billingMode === "sub")).toBe(true);
      expect(eligibleEntriesForHarness("codex", [xaiAccount])).toEqual([]);

      expect(eligibleEntriesForHarness("grok", [xaiKey]).some((e) => e.model.id === "grok-4.6")).toBe(true);
      expect(eligibleEntriesForHarness("codex", [xaiKey]).some((e) => e.model.id === "grok-4.6")).toBe(true);

      expect(harnessServiceSupport("grok", "xai")).toBe("all");
      expect(harnessServiceSupport("codex", "xai")).toBe("some");
      expect(harnessServiceSupport("opencode", "xai")).toBe("some");
      expect(harnessSupportsMode("grok", "xai", "sub")).toBe(true);
      expect(harnessSupportsMode("codex", "xai", "sub")).toBe(false);
    });

    it("keeps every declared login backed by a real auth manager", async () => {
      const { buildAgentRuntime } = await import("../../orchestrator/agents/index.js");
      const { AuthManager } = await import("../../orchestrator/agents/claude/auth-manager.js");
      const { CodexAuthManager } = await import("../../orchestrator/agents/codex/auth-manager.js");
      const { XaiAuthManager } = await import("../../orchestrator/agents/grok/auth-manager.js");
      const { authManagers } = buildAgentRuntime({
        authManager: new AuthManager(),
        codexAuthManager: new CodexAuthManager(),
        xaiAuthManager: new XaiAuthManager(),
      });
      for (const loginId of allLoginIntegrations()) {
        expect(authManagers.get(loginId)?.loginId, `no auth manager for ${loginId}`).toBe(loginId);
      }
      expect([...authManagers.keys()].sort()).toEqual(allLoginIntegrations().sort());
    });
  });

  describe("reasoning levels per selection (docs/274 req 14)", () => {
    it("distinguishes an empty list from an absent one", () => {
      const claude = reasoningOptionsFor("claude", {
        serviceId: "anthropic",
        billingMode: "sub",
        modelId: "claude-opus-5",
      });
      expect(claude).toEqual(getHarness("claude")?.capabilities.reasoning?.options);
      expect(claude.length).toBeGreaterThan(0);
    });

    it("falls back to the harness list when no selection is known", () => {
      expect(reasoningOptionsFor("codex", undefined))
        .toEqual(getHarness("codex")?.capabilities.reasoning?.options);
    });

    it("refuses a level the selection does not honour", () => {
      const keyGrok = { serviceId: "xai", billingMode: "key" as const, modelId: "grok-4.6" };
      expect(selectionHonoursEffort("grok", keyGrok, "high")).toBe(false);
      expect(selectionHonoursEffort("claude", {
        serviceId: "anthropic", billingMode: "sub" as const, modelId: "claude-opus-5",
      }, "high")).toBe(true);
    });

    it("keeps every declared per-model level inside its harness vocabulary", () => {
      for (const harness of allHarnesses()) {
        const vocabulary = new Set(harness.capabilities.reasoning?.options.map((o) => o.value) ?? []);
        for (const entry of catalogueEntriesForHarness(harness.id)) {
          if (!harnessSupportsMode(harness.id, entry.service.id, entry.mode.kind)) continue;
          if (!harnessSendsReasoningEffort(harness.id, entry.mode.kind)) {
            expect(reasoningOptionsFor(harness.id, entry.selection),
              `${harness.id}/${entry.model.id} exposes reasoning in a mode that sends no effort`)
              .toEqual([]);
            continue;
          }
          for (const level of entry.model.reasoningEfforts ?? []) {
            expect(
              vocabulary.has(level),
              `${harness.id}/${entry.model.id} names effort "${level}", which the harness does not declare`,
            ).toBe(true);
          }
        }
      }
    });
  });
});

describe("per-model image input (planning#460)", () => {
  it("resolves a verdict through every spelling a row id can take", () => {
    expect(visionSupportFor({ serviceId: "anthropic", billingMode: "sub", modelId: "haiku" })).toBe("yes");
    expect(visionSupportFor({ serviceId: "zai", billingMode: "sub", modelId: "glm-5.2[1m]" })).toBe("no");
    expect(
      visionSupportFor({ serviceId: "openrouter", billingMode: "key", modelId: "deepseek/deepseek-v4-flash" }),
    ).toBe("no");
    expect(visionSupportFor({ serviceId: "deepseek", billingMode: "key", modelId: "deepseek-flash" })).toBe("yes");
  });

  it("answers unverified — never no — for a selection it cannot resolve", () => {
    expect(visionSupportFor(undefined)).toBe("unverified");
    expect(visionSupportFor({ serviceId: "deepseek", billingMode: "key", modelId: "no-such-model" })).toBe(
      "unverified",
    );
    expect(visionSupportFor({ serviceId: "no-such-service", billingMode: "key", modelId: "haiku" })).toBe(
      "unverified",
    );
  });
});


it("offers only the checked OpenCode ChatGPT model and keeps Responses account-only", () => {
  const entries = catalogueEntriesForHarness("opencode").filter(e => e.service.id === "openai" && e.mode.kind === "sub");
  expect(entries.map(e => e.model.id)).toEqual(["gpt-5.5"]);
  expect(resolveStyle("opencode", getModel({ serviceId: "openai", billingMode: "key", modelId: "gpt-5.5" })!, "string")).toBe("openai-chat-completions");
  expect(harnessCanCarry("opencode", { serviceId: "anthropic", billingMode: "sub", via: "account" })).toBe(false);
});
