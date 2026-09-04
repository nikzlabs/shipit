/**
 * docs/252 phase 1 — the catalogue's invariants.
 *
 * `catalogue.md` states several type-level invariants the type system cannot
 * carry. This file is the other half of "encode what the types can, test what
 * they cannot": each `describe` below names an invariant that would otherwise
 * let a row type-check, join, appear in the picker, and then fail at spawn.
 */

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

/**
 * The rows at their declared *interface* type rather than the `as const` literal
 * type. `SERVICES` is `as const satisfies readonly ServiceDef[]`, which is what
 * makes `ServiceId` a literal union — but it also makes every endpoint map and
 * model id a singleton type, so an invariant check that indexes by `ApiStyle`
 * or compares two ids is a compile error against the narrow form. Widening here
 * (and only here) keeps the production narrowing intact.
 */
const CATALOGUE: readonly ServiceDef[] = SERVICES;

/** Every `(service, mode, model)` row, with the identity that names it. */
function everyRow(): { service: ServiceDef; mode: BillingModeDef; model: ModelDef }[] {
  return CATALOGUE.flatMap((service) =>
    service.modes.flatMap((mode) => mode.models.map((model) => ({ service, mode, model }))),
  );
}

describe("no shipped row still carries a sentinel", () => {
  // The sentinels are negative rather than zero precisely so a forgotten row is
  // loud. Zero is a real answer for `cacheWrite` (OpenAI charges nothing to
  // write the cache before the GPT-5.6 family), so a zero sentinel would have
  // read as an answer and shipped silently.
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
      // A rate expressed per *token* rather than per million would come out
      // vanishingly small; a rate expressed per thousand would come out huge.
      // These bounds catch the unit slip that a spot-check by eye does not.
      if (model.price.input > 0) expect(model.price.input, where).toBeGreaterThan(0.001);
      expect(model.price.input, where).toBeLessThan(1000);
      expect(model.price.output, where).toBeGreaterThanOrEqual(model.price.input);
      expect(model.price.cacheRead, where).toBeLessThanOrEqual(model.price.input);
      // `cacheWrite` MAY be zero — that is "the vendor charges nothing", not a
      // missing value — but it may never be negative.
      expect(model.price.cacheWrite, where).toBeGreaterThanOrEqual(0);
    }
  });

  // Pins the 2026-08-16 correction recorded in `services.ts`. A gateway is NOT a
  // pass-through: it marks the same model up or down, in both directions and by
  // large multiples. The old code reused the upstream vendor's price constant on
  // every gateway row, so the figure a user saw for a DeepSeek turn through
  // OpenRouter was wrong by ~2.3× in one direction and ~2.7× in the other. An
  // "each row has A price" check cannot see that; only naming the pairs can.
  it("a gateway prices a model independently of the vendor that makes it", () => {
    const direct = (modelId: string) =>
      getModel({ serviceId: "deepseek", billingMode: "key", modelId });
    const or = (modelId: string) => getModel({ serviceId: "openrouter", billingMode: "key", modelId });
    const vercel = (modelId: string) => getModel({ serviceId: "vercel", billingMode: "key", modelId });

    // OpenRouter undercuts DeepSeek's own rate for Flash and marks Pro up.
    expect(or("deepseek/deepseek-v4-flash")?.price.input).toBeLessThan(
      direct("deepseek-v4-flash")!.price.input,
    );
    expect(or("deepseek/deepseek-v4-pro")?.price.input).toBeGreaterThan(
      direct("deepseek-v4-pro")!.price.input,
    );
    // And the two gateways do not agree with each other either.
    expect(or("deepseek/deepseek-v4-flash")?.price.input).not.toBe(
      vercel("deepseek/deepseek-v4-flash")?.price.input,
    );
    expect(or("google/gemini-3.7-flash")?.price.input).not.toBe(
      vercel("google/gemini-3.7-flash")?.price.input,
    );
  });
});

describe("a model's declared styles are reachable", () => {
  // The invariant `ModelDef.styles` documents: every entry must also be a key of
  // the owning mode's `endpoints`. `styles` and `endpoints` are independent
  // fields, so without this a row joins and then has nowhere to send the request.
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

/**
 * docs/261 phase 0 (req 4) — model identity and lineage.
 *
 * The invariant is deliberately NOT "one model id offered by two services
 * declares the same family in both". That check cannot catch anything, because
 * the pair this feature exists for has **different** ids: Anthropic's
 * `claude-opus-5` and OpenRouter's `anthropic/claude-opus-5` are one model under
 * two spellings. What has to hold is that both name the same
 * `canonicalModelKey`, and that everything sharing a key agrees on its family.
 */
describe("model identity and lineage (docs/261 req 4)", () => {
  it("every offering declares both fields, from the declared sets", () => {
    for (const { service, mode, model } of everyRow()) {
      const where = `${service.id}/${mode.kind}/${model.id}`;
      expect(model.canonicalModelKey, `${where} has no canonicalModelKey`).toBeTruthy();
      expect(MODEL_FAMILY_IDS, `${where} declares an unknown family`).toContain(model.family);
    }
  });

  // "Declared once and referenced, not retyped per offering." A row is meant to
  // spread `MODEL_IDENTITIES.<handle>`, which makes a mismatched pair
  // unwritable; this is what catches a row that spelled the two fields by hand
  // and got them out of step — the typo that would otherwise compile, pass, and
  // make ShipIt call a same-model review independent.
  it("every authored pair is one the shared declaration carries", () => {
    for (const { service, mode, model } of everyRow()) {
      const declared = MODEL_IDENTITY_BY_KEY[model.canonicalModelKey];
      const where = `${service.id}/${mode.kind}/${model.id}`;
      expect(declared, `${where} names an undeclared canonical model`).toBeTruthy();
      expect(declared?.family, `${where} disagrees with the declared family`).toBe(model.family);
    }
  });

  /**
   * The invariant with teeth, and the one the first cut was missing. Every check
   * above passes when a row spreads the **wrong existing** declaration —
   * `MODEL_IDENTITIES.gpt56terra` on the GPT-5.6 Sol row is a valid,
   * self-consistent pair — so ShipIt would silently treat Sol and Terra as one
   * model and refuse to let either review the other's work. Tying the row's id
   * to its key is what catches it, with `MODEL_ID_ALIASES` as the one escape and
   * therefore the one place a human confirms "these really are the same model".
   */
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

  /**
   * The same mistake caught from the other side, and on its own merits: one mode
   * offering the same model twice is incoherent for the picker (two rows the
   * user must choose between that are one model) as well as for the ranking.
   */
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

  // The motivating pair, named so a future catalogue edit that splits it fails
  // for a reason a reader can act on rather than as an anonymous group mismatch.
  it("a gateway-served model IS the vendor-served one", () => {
    const direct = getModel({ serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" });
    const gateway = getModel({
      serviceId: "openrouter",
      billingMode: "key",
      modelId: "anthropic/claude-opus-5",
    });
    expect(direct?.canonicalModelKey).toBe(gateway?.canonicalModelKey);
    // Two different ids, which is the whole point — an id-equality invariant
    // would pass here vacuously and prove nothing.
    expect(direct?.id).not.toBe(gateway?.id);
  });

  // The same statement within one service: `[1m]` is a Claude Code instruction
  // that selects the long-context variant, not a different model.
  it("GLM's two spellings are one model", () => {
    const plan = getModel({ serviceId: "zai", billingMode: "sub", modelId: "glm-5.2[1m]" });
    const key = getModel({ serviceId: "zai", billingMode: "key", modelId: "glm-5.2" });
    expect(plan?.canonicalModelKey).toBe(key?.canonicalModelKey);
  });

  // Lineage is not identity: Opus and Sonnet are siblings and NOT the same
  // model. A single field could not say both, which is why there are two.
  it("siblings share a family and differ as models", () => {
    const opus = getModel({ serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" });
    const sonnet = getModel({ serviceId: "anthropic", billingMode: "sub", modelId: "claude-sonnet-5" });
    expect(opus?.family).toBe(sonnet?.family);
    expect(opus?.canonicalModelKey).not.toBe(sonnet?.canonicalModelKey);
  });

  // The gateway-only models (2026-08-16) are the case the alias table warns
  // about in reverse: nobody serves them directly, and the two gateways spell
  // the SAME model with different namespaces. If a future edit lets the two
  // spellings drift apart, ShipIt would call a Grok-reviews-Grok pass an
  // independent second opinion.
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
      // Different ids, so the equality above is not vacuous.
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

  /**
   * Every subscription NAMES the reader that fills req 10's indicator.
   *
   * A `quota: null` arm meaning "the vendor publishes nothing to read" existed
   * for one release and was removed with the claim that motivated it: xAI does
   * publish its weekly pool, and the probe that said otherwise had missed a
   * query parameter (planning#454). So the field is a reader id again, always —
   * and a subscription with no reader yet declares an id nothing implements,
   * which `modeReportsQuota` is what actually gates on.
   */
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

/**
 * planning#339 — **declaring a quota integration is not implementing one**, and
 * the two questions the UI asks about it are separate.
 *
 * `modeReportsQuota` decides whether a credential shows a usage read-out and
 * whether failover CUTOFFS are offered (a percentage of a number nobody
 * reports can never fire — the dishonesty req 10 refuses a surface over).
 * `subQuotaRefreshable` decides whether that read-out carries a refresh button,
 * which is a strictly narrower question: Codex's numbers are pushed by the
 * app-server during a turn and can only be received, so a button there would
 * spin and change nothing.
 *
 * These are pinned per service because the failure they guard is silent both
 * ways: a reader that ships without joining `IMPLEMENTED_QUOTA_INTEGRATIONS`
 * renders nothing, and an id added to it with no reader behind it renders an
 * empty pill that reads as "no usage" when the truth is "not measured".
 */
describe("quota integrations that are implemented, and those that can be re-read (planning#339)", () => {
  it.each([
    ["anthropic", true, true],
    ["openai", true, false],
    ["zai", true, true],
    // OpenCode Go is the case with no reader to write: the vendor publishes no
    // per-key usage API at all (docs/272 req 6), so it reports nothing by
    // decision rather than while waiting for one.
    ["opencode", false, false],
    // planning#454 — SuperGrok reads its weekly pool on demand. Pinned here
    // because this row spent a release at `false, false` on a probe that was
    // wrong, and the pill it produced was the bug the user reported.
    ["xai", true, true],
  ])("%s: reports quota %s, refreshable %s", (serviceId, reports, refreshable) => {
    expect(modeReportsQuota(serviceId, "sub")).toBe(reports);
    expect(subQuotaRefreshable(serviceId)).toBe(refreshable);
  });

  it("a key mode never reports a quota and is never refreshable", () => {
    for (const service of CATALOGUE) {
      if (!service.modes.some((mode) => mode.kind === "key")) continue;
      expect(modeReportsQuota(service.id, "key"), `${service.id}/key`).toBe(false);
      // A service with no `sub` mode has nothing to refresh either.
      if (!service.modes.some((mode) => mode.kind === "sub")) {
        expect(subQuotaRefreshable(service.id), service.id).toBe(false);
      }
    }
  });

  it("nothing is refreshable without also reporting", () => {
    // The narrower question cannot outrun the broader one: a refresh button on
    // a mode that renders no read-out has nothing to put its result into.
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
    // The three axes req 13 fixes: same service, same billing mode, and runnable
    // under the style the retired model was declared for. All three are checkable
    // from the row alone, which is the whole reason the record carries its own
    // styles rather than being a bare id→id map.
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
  // The shipped catalogue declares exactly one retirement, `gpt-5.6 →
  // gpt-5.6-sol` under both OpenAI modes. It is the worked example throughout;
  // the invariant tests above are what keep any future row resolvable.
  const RETIRED: ModelSelection = { serviceId: "openai", billingMode: "sub", modelId: "gpt-5.6" };

  it("moves a pinned selection onto the successor of its OWN service and mode", () => {
    expect(retirementSuccessor("codex", RETIRED)).toEqual({
      serviceId: "openai",
      billingMode: "sub",
      modelId: "gpt-5.6-sol",
    });
    // Same id under the key mode resolves through the key mode's own record —
    // which is why the map is keyed per mode and not per service: the two are
    // free to name different successors, and neither may answer for the other.
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
    // The third axis, and the one two earlier drafts of req 13 missed. Stated
    // over every harness × every declared retirement rather than over the one
    // row that exists today, so a future retirement declared under a style no
    // shipped harness speaks cannot pass by being unreachable.
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
    // Claude Code speaks `anthropic-messages`; OpenAI's retirement is declared
    // under `openai-responses`. Stranding a session there would be worse than
    // saying nothing, so the answer is nothing — and the caller leaves the
    // session where it is rather than moving it somewhere arbitrary.
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
    // The session-container turn boundary and any row written before the triple
    // existed. The vendor bias is the frozen fact for a legacy id: before this
    // feature a harness could reach nothing but its own vendor.
    expect(resolveRetiredModelId("codex", "gpt-5.6", "openai")).toEqual({
      serviceId: "openai",
      billingMode: "sub",
      modelId: "gpt-5.6-sol",
    });
    expect(resolveRetiredModelId("claude", "gpt-5.6", "openai")).toBeUndefined();
    expect(resolveRetiredModelId("codex", undefined)).toBeUndefined();
  });

  it("does not answer for a service other than the one asked about", () => {
    // Req 5 lets two services offer the same model id, so a lookup that knows
    // only the id cannot say whose retirement applies. This is why the bare-id
    // form takes a preferred service and why no spawn boundary calls it: an id
    // one service retired while another still offers it must not be rewritten
    // to the first service's successor at the second service's endpoint.
    // **This shape now exists in the shipped catalogue**, so the assertion is no
    // longer hypothetical. Fable 5.1 (2026-09-01) replaced Fable 5 at Anthropic,
    // which retired the bare id `claude-fable-5` — while OpenCode Zen, which
    // does not serve 5.1, still offers that exact string as a current model.
    // Zen using Anthropic's own ids rather than a `provider/` namespace is what
    // makes the collision possible at all.
    const CONTESTED = "claude-fable-5";
    expect(
      CATALOGUE.find((s) => s.id === "anthropic")!
        .modes.some((m) => m.retired.some((r) => r.id === CONTESTED)),
    ).toBe(true);
    expect(
      CATALOGUE.find((s) => s.id === "opencode")!
        .modes.some((m) => m.models.some((model) => model.id === CONTESTED)),
    ).toBe(true);

    // Asked about Zen, the id is current there and there is nothing to move:
    // Anthropic's successor must NOT leak across, because `claude-fable-5-1` is
    // a row Zen answers with `Model ... is not supported`.
    expect(
      retirementSuccessor("claude", { serviceId: "opencode", billingMode: "key", modelId: CONTESTED }),
    ).toBeUndefined();
    // Asked about Anthropic, the same id does move — the lookup consults only
    // the mode it was handed.
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
  // Phase 1 narrowed these lists to the harness's own vendor because nothing
  // could yet credential a custom service; phase 3 removes the narrowing, so
  // what is pinned now is the ORDER — `models[0]` is the default a fresh install
  // runs with, and the first-party services still sort first.
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
    // Grok does not send a reasoning level for key-billed turns. A model row
    // may therefore name levels outside Grok's unused vocabulary without
    // making those levels available on Grok.
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

    // This equality IS the documented provisional-rate relationship. If
    // GPT-5.3-Codex's rate moves, re-check whether it remains Spark's proxy.
    expect(sub?.price).toEqual(proxy?.price);
    expect(key).toBeUndefined();
  });

  it("reaches services the harness shares a style with, and no others", () => {
    // DeepSeek serves Anthropic-Messages, OpenAI chat-completions AND the
    // Responses API natively (confirmed 2026-08-13), and Codex 0.146.0 speaks
    // ONLY the Responses API (a provider declaring `wire_api = "chat"` is
    // rejected outright — phase 3 measured this). So DeepSeek now reaches both
    // harnesses. Vercel documents a Responses surface, so it reaches Codex too;
    // OpenRouter's was verified 2026-08-15 (planning#391) and reaches Codex for
    // the rows that declare the style.
    expect(catalogueModelIdsForHarness("claude")).toContain("deepseek-v4-flash");
    expect(catalogueModelIdsForHarness("codex")).toContain("deepseek-v4-flash");
    expect(catalogueModelIdsForHarness("codex")).toContain("deepseek-v4-pro");
    expect(catalogueModelIdsForHarness("codex")).toContain("openai/gpt-5.6-sol");
    expect(catalogueModelIdsForHarness("claude")).toContain("anthropic/claude-opus-5");
    // The style is declared per ROW, not per service: OpenRouter's verified
    // Responses run was a DeepSeek model, and Anthropic serves no Responses API
    // for the gateway to pass through, so the `anthropic/*` rows stay off it.
    // A blanket-add to the service would break exactly this assertion.
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
    // The bug this exists to prevent: Anthropic's subscription accepts BOTH an
    // account and a string, so testing "the mode has a credential" and "the
    // harness supports one of the mode's shapes" independently both pass for a
    // key-only harness holding only an account — and the model is offered and
    // cannot authenticate. Asked over the route, the account is not carryable by
    // a harness with no account target.
    expect(harnessCanCarry("claude", anthropicAccount)).toBe(true);
    expect(
      harnessCanCarry("claude", { serviceId: "deepseek", billingMode: "key", via: "account" }),
    ).toBe(false);
  });
});

describe("support before a credential exists (the add-service table)", () => {
  it("answers per service what the join and the credential shapes allow", () => {
    // GLM serves Anthropic Messages only, so Codex — which speaks Responses and
    // nothing else — cannot reach it however it is paid for. OpenRouter used to
    // be in the same position and no longer is: its Responses surface was
    // verified 2026-08-15 (planning#391), and one row declaring the style is
    // enough for the service to be supported.
    expect(harnessSupportsService("claude", "zai")).toBe(true);
    expect(harnessSupportsService("codex", "zai")).toBe(false);
    expect(harnessSupportsService("claude", "openrouter")).toBe(true);
    expect(harnessSupportsService("codex", "openrouter")).toBe(true);
    // …and the mirror image: OpenAI is Responses only.
    expect(harnessSupportsService("codex", "openai")).toBe(true);
    expect(harnessSupportsService("claude", "openai")).toBe(false);
    // Services that serve both styles reach both harnesses.
    expect(harnessSupportsService("claude", "deepseek")).toBe(true);
    expect(harnessSupportsService("codex", "deepseek")).toBe(true);
  });

  it("is the SAME answer eligibility gives once that credential is added", () => {
    // The point of deriving it from `eligibleEntriesForHarness` rather than
    // re-stating the rule: the table cannot promise a pairing the picker then
    // refuses, or refuse one it would have offered.
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
    // Since docs/268 the per-SERVICE cell is tri-state (`harnessServiceSupport`
    // — OpenCode runs Anthropic's key mode and never its subscription, so the
    // service-level collapse is honestly "some" rather than a flat tick). The
    // collapse that must still be safe is per MODE: `harnessSupportsMode` is a
    // tick when SOME accepted credential shape would work, the user supplies
    // ONE shape — so a mode whose answer differed between its shapes would be
    // ticked and then offer nothing. This fails the moment a shipped row does
    // that; the fix then is a per-shape cell, not a lie. (Originally found by
    // cross-backend review — plan.md, req 22.)
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
    // Pin the rows that motivated the tri-state: OpenCode reaches the key mode
    // of Anthropic and OpenAI but neither subscription (no account target, and
    // the env-OAuth token is carrier-restricted to Claude Code — docs/268 req 5).
    expect(harnessServiceSupport("opencode", "anthropic")).toBe("some");
    expect(harnessServiceSupport("opencode", "openai")).toBe("some");
    expect(harnessSupportsMode("opencode", "anthropic", "sub")).toBe(false);
    expect(harnessSupportsMode("opencode", "anthropic", "key")).toBe(true);
    // GLM's coding plan delivers a BEARER token (ANTHROPIC_AUTH_TOKEN);
    // OpenCode's anthropic-messages path sends x-api-key, so the sub mode is
    // carrier-restricted to Claude Code (docs/268 review finding) while the
    // ordinary key mode still joins.
    expect(harnessSupportsMode("opencode", "zai", "sub")).toBe(false);
    expect(harnessSupportsMode("opencode", "zai", "key")).toBe(true);
    expect(harnessServiceSupport("opencode", "zai")).toBe("some");
    // Claude Code keeps its full ticks — the tri-state changed nothing for it.
    expect(harnessServiceSupport("claude", "anthropic")).toBe("all");
  });

  it("a harness that cannot override its endpoint joins only its own vendor", () => {
    // Eligibility tests styles and credentials, NOT whether the harness can be
    // pointed at the service's endpoint — so a harness declaring
    // `endpoint: { kind: "none" }` would be offered a foreign service it can
    // never route to, in the picker as much as in this table.
    //
    // **Vacuous today, deliberately**: neither shipped harness declares `none`.
    // It is the guard that fires on the day one is added, which is the day
    // eligibility itself has to grow the third clause.
    for (const harness of allHarnesses()) {
      if (harness.spawn.endpoint.kind !== "none") continue;
      for (const entry of catalogueEntriesForHarness(harness.id)) {
        expect(entry.selection.serviceId).toBe(harness.nativeService);
      }
    }
  });

  it("never overrides a credential destination for a harness that has no default one", () => {
    // `harnessCanCarry` refuses a string credential when the harness declares no
    // string destination, while `spawnCredentialTarget` would have honoured a
    // service's per-harness override — so such a row would be called
    // unsupported here and be perfectly spawnable. GLM's override is the live
    // case and its harness does have a default, which is what keeps the two
    // answers together. Also found by review.
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
    // A cell for a row that is gone must read as unsupported, never throw and
    // never quietly claim support.
    expect(harnessSupportsService("claude", "not-a-service")).toBe(false);
    expect(harnessSupportsMode("claude", "deepseek", "sub")).toBe(false);
  });
});

describe("spawn shaping", () => {
  it("materializes DeepSeek's key into Claude Code's own variable, at DeepSeek's endpoint", () => {
    const shaping = resolveSpawnShaping("claude", {
      serviceId: "deepseek",
      billingMode: "key",
      modelId: "deepseek-v4-flash",
    });
    expect(shaping?.style).toBe("anthropic-messages");
    expect(shaping?.endpoint.url).toBe("https://api.deepseek.com/anthropic");
    expect(shaping?.credential).toEqual({
      sourceEnv: "DEEPSEEK_API_KEY",
      target: { kind: "env", name: "ANTHROPIC_API_KEY" },
    });
  });

  it("materializes DeepSeek's key into Codex's own variable, at its Responses endpoint", () => {
    // docs/252 phase 3 + 2026-08-13: DeepSeek serves the Responses API, so the
    // same key lands in `OPENAI_API_KEY` and `codexProviderArgs` writes a block
    // pointing Codex at `https://api.deepseek.com/v1` (`/responses` appended).
    const shaping = resolveSpawnShaping("codex", {
      serviceId: "deepseek",
      billingMode: "key",
      modelId: "deepseek-v4-flash",
    });
    expect(shaping?.style).toBe("openai-responses");
    expect(shaping?.endpoint.url).toBe("https://api.deepseek.com/v1");
    expect(shaping?.credential).toEqual({
      sourceEnv: "DEEPSEEK_API_KEY",
      target: { kind: "env", name: "OPENAI_API_KEY" },
    });
  });

  it("points Codex at OpenRouter's Responses base, which is NOT its Anthropic one", () => {
    // 2026-08-15 (planning#391). The literal URL is pinned because the row
    // carries two different base URLs for one host on purpose — `/api/v1` for
    // Responses (Codex appends `/responses`) and `/api` for Anthropic Messages
    // (Claude Code appends `/v1/messages`). A `/v1` dropped from either would
    // still satisfy the generic "every joined entry has an endpoint" guard and
    // fail only at turn time, against the real gateway.
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
    // `ANTHROPIC_AUTH_TOKEN` is an OAuth artifact with Bearer semantics; without
    // a `targetOverride` it inherited Claude's string target `ANTHROPIC_API_KEY`
    // and the CLI would deliver it as an `x-api-key` header (harnesses.ts,
    // measured at the wire). Same shape as GLM's override above.
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
    // Fable 5.1 (2026-09-01) reads the same window as the model it succeeds, and
    // both ids are live: Anthropic offers 5.1, Zen still offers 5.0.
    expect(windows["claude-fable-5-1"]).toBe(1_000_000);
    expect(windows.haiku).toBe(200_000);
    // Codex's assignment, deliberately not OpenAI's advertised maximum.
    expect(windows["gpt-6-astra"]).toBe(272_000);
    expect(windows["gpt-5.6-sol"]).toBe(272_000);
    expect(windows["gpt-5.2"]).toBe(272_000);
  });

  it("keeps EVERY display label the client's hand-kept record reported", () => {
    // Exhaustive on purpose. A spot-check of a few labels stays green while a
    // regression to any of the others ships a wrong name into the picker, the
    // usage modal and the session header — so this asserts the whole set the
    // pre-catalogue record covered, not a sample of it.
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
      // …and through the client helper that actually renders it, since that is
      // where the legacy-vs-catalogue merge happens.
      expect(formatModelName(id), id).toBe(label);
    }
  });

  it("keeps the labels for ids the catalogue has no row for", () => {
    // Aliases and retired slugs still appear in old sessions and history. They
    // live in the client's legacy record, and the merge must not shadow them.
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
    // The NAME is "OpenCode", never "OpenCode Zen": one row carries both
    // products, so a label naming the metered one would mislabel every Go row.
    expect(opencode?.name).toBe("OpenCode");
    expect(opencode?.modes.map((m) => m.kind).sort()).toEqual(["key", "sub"]);
    // Each product at its own base, and the Anthropic-style base deliberately
    // WITHOUT the `/v1` its consumers append.
    expect(resolveEndpoint("opencode", { serviceId: "opencode", billingMode: "key", modelId: "claude-opus-5" }))
      .toBe("https://opencode.ai/zen");
    expect(resolveEndpoint("opencode", { serviceId: "opencode", billingMode: "key", modelId: "glm-5.2" }))
      .toBe("https://opencode.ai/zen/v1");
    expect(resolveEndpoint("opencode", { serviceId: "opencode", billingMode: "sub", modelId: "glm-5.3" }))
      .toBe("https://opencode.ai/zen/go/v1");
    // The `openai-responses` half: same `/v1`-carrying base per product,
    // because Codex appends only `/responses`.
    expect(resolveEndpoint("codex", { serviceId: "opencode", billingMode: "key", modelId: "gpt-5.6-sol" }))
      .toBe("https://opencode.ai/zen/v1");
    expect(resolveEndpoint("codex", { serviceId: "opencode", billingMode: "sub", modelId: "gpt-5.6-luna" }))
      .toBe("https://opencode.ai/zen/go/v1");
  });

  it("serves Codex only the models each OpenCode product actually has (docs/272 §7)", () => {
    // Verified live by no-key registry probe on both `/responses` bases: Zen
    // serves the whole GPT-5.6 family and Grok 4.6, while Go serves Luna ALONE
    // — `gpt-5.6-sol` answers `ModelError` there. A row claiming otherwise
    // would 400 on its first turn, so the asymmetry is asserted rather than
    // smoothed over.
    const idsFor = (billingMode: "key" | "sub") =>
      catalogueEntriesForHarness("codex")
        .filter((e) => e.service.id === "opencode" && e.mode.kind === billingMode)
        .map((e) => e.model.id);
    expect(idsFor("key").sort()).toEqual(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "grok-4.6"]);
    expect(idsFor("sub")).toEqual(["gpt-5.6-luna"]);
    // Every one of them is responses-only here: Zen does not translate between
    // styles, so a second style on these rows would be a wrong claim.
    for (const entry of catalogueEntriesForHarness("codex").filter((e) => e.service.id === "opencode")) {
      expect(entry.model.styles, entry.model.id).toEqual(["openai-responses"]);
    }
  });

  it("prices OpenCode's models as OpenCode, not as the vendors that make them", () => {
    // Zen is sold "at cost" and is still not a pass-through — the same
    // correction the two gateways forced. Naming the pairs is the only check
    // that can see it.
    const zen = (modelId: string) => getModel({ serviceId: "opencode", billingMode: "key", modelId });
    const go = (modelId: string) => getModel({ serviceId: "opencode", billingMode: "sub", modelId });
    // Sonnet 5 undercuts Anthropic's own published rate.
    expect(zen("claude-sonnet-5")!.price.input).toBeLessThan(
      getModel({ serviceId: "anthropic", billingMode: "key", modelId: "claude-sonnet-5" })!.price.input,
    );
    // DeepSeek V4 Pro is marked up over DeepSeek's own.
    expect(zen("deepseek-v4-pro")!.price.input).toBeGreaterThan(
      getModel({ serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4-pro" })!.price.input,
    );
    // And the two products disagree with each other: Go publishes its own
    // per-model rate for the usage-cap arithmetic.
    expect(go("deepseek-v4-pro")!.price.input).not.toBe(zen("deepseek-v4-pro")!.price.input);
    // The same holds on the `openai-responses` rows, in both directions:
    // Terra costs more at Zen than at OpenAI, and Luna costs half as much on
    // the Go plan as on Zen credits.
    expect(zen("gpt-5.6-terra")!.price.input).toBeGreaterThan(
      getModel({ serviceId: "openai", billingMode: "key", modelId: "gpt-5.6-terra" })!.price.input,
    );
    expect(go("gpt-5.6-luna")!.price.input).toBeLessThan(zen("gpt-5.6-luna")!.price.input);
  });

  it("names OpenCode's own inference as its harness's native service (docs/272)", () => {
    // …and the thing that makes that safe: three readers used "native" to mean
    // "the vendor's account machinery owns this", which is false here. The
    // question they ask now is the login integration, and this service has
    // none — a pasted key with no sign-in flow.
    expect(HARNESSES.find((h) => h.id === "opencode")?.nativeService).toBe("opencode");
    expect(loginIntegrationForService("opencode")).toBeUndefined();
    expect(harnessForNativeService("opencode")).toBe("opencode");
  });

  // Go's "declares a quota integration and reports nothing" is NOT asserted
  // here: it is a row of the `subQuotaRefreshable` matrix above
  // (`["opencode", false, false]`), which is where every service's answer to
  // that pair of questions lives. Two places would be two answers to drift.

  it("offers OpenCode's inference to the harnesses whose pair was measured, and to no others", () => {
    // docs/272 req 5 — cross-harness routing is in scope and each pair ships
    // only after a live turn proves it. All three pairs were run on
    // 2026-08-17 (§7) and they did not agree, so `carriers` is now a record of
    // measurements rather than a blanket launch gate:
    //
    //  - OpenCode ✅ and Codex ✅ real paid turns on both products.
    //  - Claude Code ❌ Zen refuses the CLI's request body outright — `400
    //    [invalid_request_error] context_management: Extra inputs are not
    //    permitted` — so the pair is excluded by evidence. Adding "claude"
    //    would offer a pairing that fails on its first turn.
    const zenKey = { serviceId: "opencode", billingMode: "key" as const, via: "string" as const };
    const goKey = { serviceId: "opencode", billingMode: "sub" as const, via: "string" as const };
    for (const harness of ["opencode", "codex"] as const) {
      expect(eligibleEntriesForHarness(harness, [zenKey]).length, harness).toBeGreaterThan(0);
      expect(eligibleEntriesForHarness(harness, [goKey]).length, harness).toBeGreaterThan(0);
      expect(harnessSupportsService(harness, "opencode"), harness).toBe(true);
    }
    expect(eligibleEntriesForHarness("claude", [zenKey, goKey])).toEqual([]);
    expect(harnessSupportsService("claude", "opencode")).toBe(false);
    // The style join alone WOULD have offered Zen's Claude rows to Claude Code
    // — so the exclusion is doing real work rather than restating the join.
    expect(
      catalogueEntriesForHarness("claude").some((e) => e.service.id === "opencode"),
    ).toBe(true);
  });

  it("lets a gateway offer a vendor's models to someone with no account there", () => {
    // Reqs 2 and 6 behaving as specified, not a bug: OpenRouter's key reaches
    // Anthropic's models, and it reaches them under Claude Code.
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
    // `deepseek-v4-flash` is offered by DeepSeek directly; the gateways carry it
    // under a namespaced id, so the bare id resolves to DeepSeek either way.
    expect(resolveModelSelection("deepseek-v4-flash", "deepseek")?.serviceId).toBe("deepseek");
    // A preference the id is not offered under falls back rather than failing.
    expect(resolveModelSelection("claude-opus-5", "openrouter")?.serviceId).toBe("anthropic");
  });

  it("returns undefined for an id the catalogue does not carry", () => {
    // A real case — a versioned id the picker never surfaced — and one every
    // caller must handle rather than fabricate a triple for.
    expect(resolveModelSelection("claude-sonnet-4-20250514")).toBeUndefined();
    expect(resolveModelSelection(undefined)).toBeUndefined();
    expect(resolveModelSelection("")).toBeUndefined();
  });

  it("reports every mode offering an id, so a migration can prefer one", () => {
    // Three, and the third is the case this list exists for: OpenCode Zen
    // (docs/272) serves Anthropic's models under **Anthropic's own ids**, not
    // under a `provider/` namespace like the two gateways — so one bare id now
    // names rows at two services. Catalogue order keeps Anthropic first, which
    // is what makes a legacy bare id still resolve where it came from.
    expect(modesOfferingModel("claude-fable-5-1")).toEqual([
      { serviceId: "anthropic", billingMode: "sub" },
      { serviceId: "anthropic", billingMode: "key" },
    ]);
    expect(resolveModelSelection("claude-fable-5-1")?.serviceId).toBe("anthropic");
    // The predecessor is the third case, and Zen is now its ONLY offerer:
    // Anthropic retired the bare id when 5.1 replaced it (2026-09-01) while Zen,
    // which does not serve 5.1, still carries it. So a bare `claude-fable-5`
    // resolves to Zen and not to the vendor it came from — the one id where
    // "Anthropic first" no longer applies, because Anthropic no longer offers it.
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
    // The two ids most likely to break a naive parse.
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

/**
 * docs/252 phase 2 — the credential invariants the type system cannot carry.
 */
describe("credentials", () => {
  it("never reuses one storageEnv name across two modes", () => {
    // The same variable meaning two different credentials is the single-slot
    // collision phase 2 exists to remove, one level up: delivery materializes
    // by name, so two modes sharing a name means one silently wins.
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
    // `ANTHROPIC_AUTH_TOKEN` is the only storage name in the catalogue from
    // which Bearer semantics can be READ OFF THE NAME — `ZAI_CODING_PLAN_KEY`
    // is bearer-delivered too, but its row's override states that explicitly,
    // and a future bearer credential named `*_API_KEY` gets no coverage here.
    // This key exists for the silent kind: a credential stored under it must
    // never land in `ANTHROPIC_API_KEY` (Claude's harness default), because
    // the CLI sends that variable as an `x-api-key` header and the turn 401s
    // with an error that looks like a bad key. The negative form is
    // harness-general: a second carrier whose string target is a different
    // api-key variable (OpenCode's `OPENCODE_PROVIDER_API_KEY`) is correct.
    let checked = 0;
    for (const service of allServices()) {
      for (const mode of service.modes) {
        for (const credential of mode.credentials) {
          if (credential.via !== "string" || credential.storageEnv !== "ANTHROPIC_AUTH_TOKEN") continue;
          const where = `${service.id}:${mode.kind}`;
          for (const harness of allHarnesses()) {
            // `carriers` already gates who may authenticate with this token;
            // the invariant binds the harnesses that can actually carry it.
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
    // A mode with no way in is a row that can never be selected (req 8) — it
    // would appear in the add-flow and reject every credential offered to it.
    for (const service of allServices()) {
      for (const mode of service.modes) {
        expect(mode.credentials.length, `${service.id}:${mode.kind}`).toBeGreaterThan(0);
      }
    }
  });

  it("gives every harness somewhere to put a credential", () => {
    // `CredentialTargets` has both halves optional so a key-only CLI need not
    // invent an account destination — but a harness with neither can
    // authenticate nothing at all.
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
      // DeepSeek and the gateways take an API key and have no sign-in. The
      // absence is what tells `requireAuthManager` to refuse rather than guess.
      expect(loginIntegrationForService("deepseek")).toBeUndefined();
      expect(loginIntegrationForService("openrouter")).toBeUndefined();
    });

    it("names the harness whose home directory each login writes into", () => {
      // The deliberate harness-keyed side: credential ROOTS stay
      // `provider-accounts/<harness>/…` because their contents are that CLI's
      // own home. Re-keying them would orphan every connected account.
      expect(credentialHarnessForLogin("anthropic-oauth")).toBe("claude");
      expect(credentialHarnessForLogin("openai-chatgpt")).toBe("codex");
      expect(credentialHarnessForLogin("xai-oauth")).toBe("grok");
    });

    it("fans a completed sign-in out to every harness that can use the credential", () => {
      // Pinned deliberately. Today each login serves exactly ONE harness, which
      // is why `refreshAuth(agentId)` looked correct for years. The first
      // provider-neutral harness (an OpenCode speaking `anthropic-messages`)
      // widens the Anthropic row on its own — and this assertion is what makes
      // that widening show up as a failing test to be reviewed, rather than a
      // silent behaviour change. If you are here because this broke: confirm
      // the new harness really should re-evaluate on this sign-in, then update
      // the expectation.
      expect(harnessesForLoginIntegration("anthropic-oauth")).toEqual(["claude"]);
      expect(harnessesForLoginIntegration("openai-chatgpt")).toEqual(["codex"]);
      expect(harnessesForLoginIntegration("xai-oauth")).toEqual(["grok"]);
    });

    it("restricts an account credential to the harnesses that can present it", () => {
      // planning#435. `carriers` used to be read for `via: "string"` only, which
      // was safe only while every account-bearing service had exactly ONE
      // harness speaking its style. Grok breaks that: it speaks
      // `openai-responses`, so the moment it carries an `account` target the
      // style join alone would offer it a ChatGPT subscription — a guaranteed
      // 401, the same class as docs/268's Anthropic-on-OpenCode hole.
      //
      // The declaration pin is still load-bearing (dropping `carriers` from
      // the row while leaving the harnessCanCarry clause would also pass a
      // refusal-only test). The refusal is no longer vacuous: Grok now has
      // an `account` target, so without the clause it WOULD join ChatGPT.
      const chatgpt = getService("openai")?.modes
        .find((m) => m.kind === "sub")
        ?.credentials.find((c) => c.via === "account");
      expect(chatgpt?.carriers).toEqual(["codex"]);
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
      // The other direction — a SuperGrok login is not a Codex credential.
      // `shipit agent params` listing only `xai --billing-mode key` on Codex
      // is this clause, not a missing account row. OpenCode is excluded
      // earlier (no `account` target at all, docs/268) and is not asserted
      // here: that refusal would still pass with the clause deleted.
      expect(harnessCanCarry("codex", {
        serviceId: "xai", billingMode: "sub", via: "account",
      })).toBe(false);
      expect(harnessCanCarry("grok", {
        serviceId: "xai", billingMode: "sub", via: "account",
      })).toBe(true);

      // Anthropic deliberately has NONE — see the row's comment. Adding one
      // deletes the only real-catalogue pair where "selected service" and
      // "harness vendor" differ, which `service-routing.test.ts` exists to pin.
      const anthropic = getService("anthropic")?.modes
        .find((m) => m.kind === "sub")
        ?.credentials.find((c) => c.via === "account");
      expect(anthropic?.carriers).toBeUndefined();
    });

    it("an xAI account makes subscription models eligible on Grok only", () => {
      // The join `listSpawnParameters` reads: grok's eligibleModels, given
      // this credential. An xAI account credential produces `--billing-mode
      // sub` rows on Grok (grok-4.6 and grok-4.5). A params dump that only
      // looked at Codex's xAI rows would read as "key only" — that is the
      // carriers refusal below, not a missing account. The listing is
      // install-wide; docs/138's worker mount is a different layer.
      const xaiAccount = { serviceId: "xai", billingMode: "sub" as const, via: "account" as const };
      const xaiKey = { serviceId: "xai", billingMode: "key" as const, via: "string" as const };

      const grokSub = eligibleEntriesForHarness("grok", [xaiAccount]);
      expect(grokSub.map((e) => e.model.id).sort()).toEqual(["grok-4.5", "grok-4.6"]);
      expect(grokSub.every((e) => e.selection.billingMode === "sub")).toBe(true);
      // Codex is the load-bearing refusal (it has an `account` target and
      // speaks `openai-responses`). Claude and OpenCode also get nothing, but
      // from earlier clauses (style join / no account target) and are not
      // what pins `carriers`.
      expect(eligibleEntriesForHarness("codex", [xaiAccount])).toEqual([]);

      // Key mode is unchanged — every harness that speaks xAI's key style
      // still gets the metered rows from a stored key.
      expect(eligibleEntriesForHarness("grok", [xaiKey]).some((e) => e.model.id === "grok-4.6")).toBe(true);
      expect(eligibleEntriesForHarness("codex", [xaiKey]).some((e) => e.model.id === "grok-4.6")).toBe(true);

      expect(harnessServiceSupport("grok", "xai")).toBe("all");
      expect(harnessServiceSupport("codex", "xai")).toBe("some");
      expect(harnessServiceSupport("opencode", "xai")).toBe("some");
      expect(harnessSupportsMode("grok", "xai", "sub")).toBe(true);
      expect(harnessSupportsMode("codex", "xai", "sub")).toBe(false);
    });

    /**
     * Every declared login is BACKED, and this asks the runtime table rather
     * than a hand-kept list.
     *
     * The list version described this invariant and never checked it: it would
     * have passed for a catalogue declaring `xai-oauth` with no manager anywhere,
     * as long as somebody edited the literal — which is precisely the state it
     * exists to prevent, because a `LoginIntegrationId` the map has no entry for
     * is a sign-in the UI offers and nothing can run. Building the real map costs
     * three constructors, none of which touches the filesystem or spawns anything
     * until a flow is started.
     */
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
      // And the reverse, so a manager built for a login the catalogue dropped is
      // visible rather than dead weight.
      expect([...authManagers.keys()].sort()).toEqual(allLoginIntegrations().sort());
    });
  });

  describe("reasoning levels per selection (docs/274 req 14)", () => {
    // The requirement is "levels are offered where they exist and never where
    // they are silently dropped". Grok is the harness that forced it: the CLI
    // accepts `--reasoning-effort` under an API key and discards it before the
    // wire, so the harness-level list over-promises on its own.
    it("distinguishes an empty list from an absent one", () => {
      // The distinction the field exists for: `[]` hides the control, absent
      // inherits the harness's list. Claude declares no per-model narrowing, so
      // its rows must still offer the harness's full set — a truthiness check
      // in the resolver would collapse these two and silently strip them.
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
      // The INVARIANT `reasoningOptionsFor` relies on: a row may only narrow the
      // harness's list, never add to it. A typo here would otherwise vanish
      // silently (intersected away) instead of failing the build.
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

/**
 * planning#460 — image input, resolved per model.
 *
 * The table itself (`model-vision.ts`) is exhaustive by construction: it is a
 * `Record<CanonicalModelKey, …>`, so a model without a verdict is a compile
 * error and needs no test. What does need one is the RESOLUTION — a row's id and
 * its canonical key are deliberately allowed to differ, in three separate ways,
 * and each one is a way for a verdict to reach the wrong model or no model.
 */
describe("per-model image input (planning#460)", () => {
  it("resolves a verdict through every spelling a row id can take", () => {
    // A vendor's own short id, resolved by `MODEL_ID_ALIASES`.
    expect(visionSupportFor({ serviceId: "anthropic", billingMode: "sub", modelId: "haiku" })).toBe("yes");
    // Claude Code's long-context suffix, stripped by `normalizeModelIdForIdentity`.
    expect(visionSupportFor({ serviceId: "zai", billingMode: "sub", modelId: "glm-5.2[1m]" })).toBe("no");
    // A gateway's namespace prefix.
    expect(
      visionSupportFor({ serviceId: "openrouter", billingMode: "key", modelId: "deepseek/deepseek-v4-flash" }),
    ).toBe("no");
    // And the plain case, at the vendor.
    expect(visionSupportFor({ serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4-flash" })).toBe("no");
  });

  it("answers unverified — never no — for a selection it cannot resolve", () => {
    // The fail-open the whole design rests on: a refusal may only follow a
    // catalogue verdict, so anything unknown has to land on the state that keeps
    // pre-planning#460 behaviour. A `"no"` here would block attachments on a
    // session whose pin ShipIt simply does not recognise.
    expect(visionSupportFor(undefined)).toBe("unverified");
    expect(visionSupportFor({ serviceId: "deepseek", billingMode: "key", modelId: "no-such-model" })).toBe(
      "unverified",
    );
    expect(visionSupportFor({ serviceId: "no-such-service", billingMode: "key", modelId: "haiku" })).toBe(
      "unverified",
    );
  });
});
