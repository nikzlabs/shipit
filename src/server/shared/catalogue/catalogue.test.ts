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
  catalogueContextWindows,
  catalogueModelLabels,
  contextWindowFor,
  credentialModeForStorageEnv,
  credentialStorageEnvNames,
  getMode,
  getModel,
  isContextSentinel,
  isPriceSentinel,
  MODEL_FAMILY_IDS,
  MODEL_ID_ALIASES,
  MODEL_IDENTITIES,
  MODEL_IDENTITY_BY_KEY,
  modelIdentityFor,
  normalizeModelIdForIdentity,
  modesOfferingModel,
  modelsNamed,
  catalogueModelIdsForHarness,
  eligibleEntriesForHarness,
  harnessCanCarry,
  isSelectionEligible,
  resolveSpawnShaping,
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
} from "./index.js";
import type { ApiStyle, BillingModeDef, ModelDef, ModelSelection, ServiceDef } from "./index.js";
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
      expect(model.price.input, where).toBeGreaterThan(0.001);
      expect(model.price.input, where).toBeLessThan(1000);
      expect(model.price.output, where).toBeGreaterThanOrEqual(model.price.input);
      expect(model.price.cacheRead, where).toBeLessThanOrEqual(model.price.input);
      // `cacheWrite` MAY be zero — that is "the vendor charges nothing", not a
      // missing value — but it may never be negative.
      expect(model.price.cacheWrite, where).toBeGreaterThanOrEqual(0);
    }
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

  it("a subscription mode names a quota integration", () => {
    for (const service of CATALOGUE) {
      for (const mode of service.modes) {
        if (mode.kind === "sub") expect(mode.quota, `${service.id}/sub`).toBeTruthy();
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
    const anyRetiredElsewhere = CATALOGUE.some((service) =>
      service.modes.some((mode) =>
        mode.retired.some((retired) =>
          CATALOGUE.some(
            (other) =>
              other.id !== service.id &&
              other.modes.some((m) => m.models.some((model) => model.id === retired.id)),
          ),
        ),
      ),
    );
    // Not true of the shipped catalogue today; the assertion is that when it
    // becomes true, `retirementSuccessor` still consults only the mode it was
    // handed — which the "never crosses" test above already pins.
    expect(anyRetiredElsewhere).toBe(false);
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
      "claude-fable-5",
    ]);
    expect(catalogueModelIdsForHarness("codex").slice(0, 8)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.5",
      "gpt-5.3-codex",
      "gpt-5.2",
    ]);
  });

  it("reaches services the harness shares a style with, and no others", () => {
    // DeepSeek serves Anthropic-Messages and OpenAI chat-completions, and Codex
    // 0.146.0 speaks ONLY the Responses API (a provider declaring
    // `wire_api = "chat"` is rejected outright — phase 3 measured this), so
    // DeepSeek reaches Claude Code and not Codex. Vercel documents a Responses
    // surface, so it is what reaches Codex today.
    expect(catalogueModelIdsForHarness("claude")).toContain("deepseek-v4-flash");
    expect(catalogueModelIdsForHarness("codex")).not.toContain("deepseek-v4-flash");
    expect(catalogueModelIdsForHarness("codex")).toContain("openai/gpt-5.6-sol");
    expect(catalogueModelIdsForHarness("claude")).toContain("anthropic/claude-opus-5");
    expect(catalogueModelIdsForHarness("codex")).not.toContain("anthropic/claude-opus-5");
  });
});

describe("eligibility (req 8)", () => {
  const deepseekKey = { serviceId: "deepseek", billingMode: "key" as const, via: "string" as const };
  const anthropicAccount = {
    serviceId: "anthropic",
    billingMode: "sub" as const,
    via: "account" as const,
  };

  it("offers nothing at all when no credential is configured", () => {
    expect(eligibleEntriesForHarness("claude", [])).toEqual([]);
    expect(eligibleEntriesForHarness("codex", [])).toEqual([]);
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
    expect(windows.haiku).toBe(200_000);
    // Codex's assignment, deliberately not OpenAI's advertised maximum.
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
    expect(modesOfferingModel("claude-fable-5")).toEqual([
      { serviceId: "anthropic", billingMode: "sub" },
      { serviceId: "anthropic", billingMode: "key" },
    ]);
    expect(modesOfferingModel("nope")).toEqual([]);
  });
});

describe("modelsNamed — docs/263's human-word-to-catalogue matching", () => {
  it("matches an exact id first", () => {
    expect(modelsNamed("glm-5.2").map((m) => m.id)).toContain("glm-5.2");
  });

  it("matches an exact label, case-insensitively", () => {
    const ids = modelsNamed("gpt-5.6 sol").map((m) => m.id);
    expect(ids).toContain("gpt-5.6-sol");
  });

  it("matches by substring when neither id nor label is exact", () => {
    const matches = modelsNamed("terra");
    // One canonical model under its vendor and gateway spellings — the caller
    // disambiguates by canonical key, which is what makes this a single model.
    expect(new Set(matches.map((m) => m.canonicalModelKey)).size).toBe(1);
    expect(matches.map((m) => m.id)).toContain("gpt-5.6-terra");
  });

  it("deduplicates one model offered by several services", () => {
    // "Opus 5" is offered by anthropic and by the gateways — one model.
    const matches = modelsNamed("Opus 5");
    const ids = new Set(matches.map((m) => m.id));
    expect(ids.size).toBe(matches.length);
    expect(new Set(matches.map((m) => m.canonicalModelKey)).size).toBe(1);
  });

  it("spans several canonical models for a name that substrings several", () => {
    expect(new Set(modelsNamed("GPT-5.6").map((m) => m.canonicalModelKey)).size).toBeGreaterThan(1);
  });

  it("returns nothing for a blank or unmatched name", () => {
    expect(modelsNamed("")).toEqual([]);
    expect(modelsNamed("   ")).toEqual([]);
    expect(modelsNamed("Fictional Model X")).toEqual([]);
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
});
