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
  catalogueEntriesForHarness,
  catalogueContextWindows,
  catalogueModelLabels,
  contextWindowFor,
  getMode,
  getModel,
  isContextSentinel,
  isPriceSentinel,
  modesOfferingModel,
  nativeModelIdsForHarness,
  parseSelection,
  effectiveModelIdForHarness,
  resolveEndpoint,
  resolveModelSelection,
  resolveRetiredModelId,
  resolveStyle,
  retirementSuccessor,
  sameCredentialOwner,
  sameSelection,
  selectionExists,
  serializeSelection,
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

  it("passes a current or unknown id through untouched at the boundary", () => {
    // `effectiveModelIdForHarness` replaces the old `normalizeCodexModelId`
    // shim, so it must keep that shim's contract exactly: undefined in,
    // undefined out; anything it cannot place is returned as it arrived.
    expect(effectiveModelIdForHarness("codex", "gpt-5.6")).toBe("gpt-5.6-sol");
    expect(effectiveModelIdForHarness("codex", "gpt-5.4")).toBe("gpt-5.4");
    expect(effectiveModelIdForHarness("codex", "claude-opus-5")).toBe("claude-opus-5");
    expect(effectiveModelIdForHarness("codex", undefined)).toBeUndefined();
    expect(effectiveModelIdForHarness("claude", "gpt-5.6")).toBe("gpt-5.6");
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

describe("phase-1 parity: the picker offers exactly what it offers today", () => {
  // This is phase 1's stated review criterion. These two lists are what
  // `AGENT_DEFS[].capabilities.models` held as hand-kept constants before the
  // catalogue existed; if either moves, something user-visible moved.
  it("Claude Code's native model list is unchanged", () => {
    expect(nativeModelIdsForHarness("claude")).toEqual([
      "claude-opus-5",
      "claude-sonnet-5",
      "haiku",
      "claude-fable-5",
    ]);
  });

  it("Codex's native model list is unchanged", () => {
    expect(nativeModelIdsForHarness("codex")).toEqual([
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
