import { describe, it, expect } from "vitest";
import { getContextWindowForModel, MODEL_CONTEXT_WINDOWS } from "./model-windows.js";

// Frozen compatibility baseline; add new models to the catalogue, not this map.
const PRE_CATALOGUE_WINDOWS: Record<string, number> = {
  "sonnet": 1_000_000,
  "claude-sonnet": 200_000,
  "claude-sonnet-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-fable-5": 1_000_000,
  "haiku": 200_000,
  "claude-haiku": 200_000,
  "opus-1m": 1_000_000,
  "gpt-5": 272_000,
  "gpt-5.6": 272_000,
  "gpt-5.6-sol": 272_000,
  "gpt-5.6-terra": 272_000,
  "gpt-5.6-luna": 272_000,
  "gpt-5.5": 272_000,
  "gpt-5.4": 272_000,
  "gpt-5.4-mini": 272_000,
  "gpt-5.3-codex": 272_000,
  "gpt-5.2": 272_000,
};

function preCatalogueLookup(model: string): number {
  const exact = PRE_CATALOGUE_WINDOWS[model];
  if (exact) return exact;
  let bestKey: string | null = null;
  for (const key of Object.keys(PRE_CATALOGUE_WINDOWS)) {
    if (model.includes(key) && (bestKey === null || key.length > bestKey.length)) bestKey = key;
  }
  return bestKey ? PRE_CATALOGUE_WINDOWS[bestKey] : 200_000;
}

const REACHABLE_TODAY = [
  ...Object.keys(PRE_CATALOGUE_WINDOWS),
  "claude-sonnet-4-20250514",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-1",
  "claude-sonnet-5-20260101",
  "opus",
  "gpt-5.1",
  "gpt-4o",
  "unknown-model",
  "",
];

describe("context windows survive the catalogue derivation unchanged", () => {
  it.each(REACHABLE_TODAY)("resolves %j exactly as it did before", (model) => {
    expect(getContextWindowForModel(model)).toBe(preCatalogueLookup(model));
  });

  it("only ADDS keys — never changes one that already existed", () => {
    for (const [key, value] of Object.entries(PRE_CATALOGUE_WINDOWS)) {
      expect(MODEL_CONTEXT_WINDOWS[key], key).toBe(value);
    }
  });

  it("newly-known models are ones no install can run yet", () => {
    for (const model of ["deepseek-flash", "deepseek-v4-pro", "glm-5.2"]) {
      expect(preCatalogueLookup(model)).toBe(200_000);
      expect(getContextWindowForModel(model)).toBe(1_000_000);
    }
  });

  it("keeps Codex's assigned window for the GPT family, not OpenAI's advertised maximum", () => {
    expect(getContextWindowForModel("gpt-6-astra")).toBe(272_000);
    expect(getContextWindowForModel("gpt-5.6-sol")).toBe(272_000);
    expect(getContextWindowForModel("gpt-5.3-codex-spark")).toBe(272_000);
    expect(getContextWindowForModel("gpt-5.2")).toBe(272_000);
  });
});
