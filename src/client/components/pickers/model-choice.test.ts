import { describe, it, expect } from "vitest";
import {
  eligibleModelsOf,
  modelAfterServiceChange,
  modelsOfService,
  servicesOf,
  serviceKeyOf,
} from "./model-choice.js";
import type { AgentOption, EligibleModelOption } from "../../agent-types.js";

/**
 * docs/261 phase 6 (reqs 11, 12) — the rules behind the two Settings controls,
 * as pure functions.
 *
 * The one worth reading is {@link modelAfterServiceChange}: it is the only place
 * in the client that asks "are these the same model", and the answer is the
 * catalogue's authored key rather than a string comparison of ids.
 */

const opusAnthropic: EligibleModelOption = {
  serviceId: "anthropic",
  serviceName: "Anthropic",
  billingMode: "sub",
  modelId: "claude-opus-5",
  label: "Opus 5",
  canonicalModelKey: "claude-opus-5",
};
const opusGateway: EligibleModelOption = {
  serviceId: "openrouter",
  serviceName: "OpenRouter",
  billingMode: "key",
  // A different STRING for the same weights — the pair the key exists for.
  modelId: "anthropic/claude-opus-5",
  label: "Opus 5",
  canonicalModelKey: "claude-opus-5",
};
const sonnetGateway: EligibleModelOption = {
  serviceId: "openrouter",
  serviceName: "OpenRouter",
  billingMode: "key",
  modelId: "anthropic/claude-sonnet-5",
  label: "Sonnet 5",
  canonicalModelKey: "claude-sonnet-5",
};
const deepseek: EligibleModelOption = {
  serviceId: "deepseek",
  serviceName: "DeepSeek",
  billingMode: "key",
  modelId: "deepseek-v4",
  label: "V4",
  canonicalModelKey: "deepseek-v4",
};

function agent(id: string, eligibleModels: EligibleModelOption[], installed = true): AgentOption {
  return {
    id,
    name: id,
    installed,
    hasRunnableModels: true,
    models: eligibleModels.map((m) => m.modelId),
    eligibleModels,
    supportsReview: true,
  };
}

describe("serviceKeyOf", () => {
  it("keys on the PAIR, so two modes of one service are two choices", () => {
    // docs/252 req 5: a subscription and a key are not interchangeable, and a
    // subscription may offer fewer models. Keying on the service alone would
    // merge them and lose the answer to "who is paying".
    expect(serviceKeyOf({ serviceId: "glm", billingMode: "sub" })).not.toBe(
      serviceKeyOf({ serviceId: "glm", billingMode: "key" }),
    );
  });
});

describe("eligibleModelsOf", () => {
  it("counts a model reachable on two harnesses once", () => {
    // The harness is derived (req 3), so it is not a second decision — and the
    // model must not appear twice as though it were.
    const models = eligibleModelsOf([agent("claude", [deepseek]), agent("codex", [deepseek])]);
    expect(models).toHaveLength(1);
  });

  it("ignores a harness this deployment did not install", () => {
    // docs/252 req 14 — an uninstalled harness offers no models anywhere.
    const models = eligibleModelsOf([agent("codex", [deepseek], false)]);
    expect(models).toEqual([]);
  });
});

describe("servicesOf", () => {
  it("lists each pair once, in catalogue order", () => {
    const services = servicesOf([opusAnthropic, opusGateway, sonnetGateway, deepseek]);
    expect(services.map((s) => serviceKeyOf(s))).toEqual([
      "anthropic:sub",
      "openrouter:key",
      "deepseek:key",
    ]);
  });
});

describe("modelsOfService", () => {
  it("bounds the list by the chosen pair (req 12)", () => {
    const models = modelsOfService([opusAnthropic, opusGateway, sonnetGateway, deepseek], {
      serviceId: "openrouter",
      billingMode: "key",
    });
    expect(models.map((m) => m.modelId)).toEqual([
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
    ]);
  });

  it("offers nothing when no service is chosen yet", () => {
    expect(modelsOfService([opusAnthropic], undefined)).toEqual([]);
  });
});

describe("modelAfterServiceChange", () => {
  /**
   * The whole reason this function is not a one-liner. An id comparison gets
   * this exact pair wrong, and the pair is the one docs/252 built the catalogue
   * around: a user changing only who pays would silently lose their model.
   */
  it("keeps the same model across services that spell its id differently", () => {
    expect(modelAfterServiceChange(opusAnthropic, [sonnetGateway, opusGateway])).toBe(opusGateway);
  });

  it("takes the service's first model when it does not offer the same one", () => {
    expect(modelAfterServiceChange(opusAnthropic, [deepseek])).toBe(deepseek);
  });

  it("takes the first model when nothing is currently chosen", () => {
    expect(modelAfterServiceChange(undefined, [deepseek, opusGateway])).toBe(deepseek);
  });

  it("does not match two different models that both lack a key", () => {
    // An older wire payload or a fixture. Falling back to the first model is
    // right; treating two unknowns as equal would pin a model the user never
    // chose, which is worse than the fallback it is trying to avoid.
    const { canonicalModelKey: _a, ...currentNoKey } = opusAnthropic;
    const { canonicalModelKey: _b, ...candidateNoKey } = deepseek;
    expect(modelAfterServiceChange(currentNoKey, [candidateNoKey])).toBe(candidateNoKey);
  });

  it("returns nothing when the service offers no models at all", () => {
    expect(modelAfterServiceChange(opusAnthropic, [])).toBeUndefined();
  });
});
