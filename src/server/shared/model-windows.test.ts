/**
 * docs/252 phase 1 — the context-window table is now the union of a small legacy
 * map (CLI aliases, family prefixes, retired ids) and the service catalogue's
 * `ModelDef.contextWindow`. Phase 1's review criterion is that nothing
 * user-visible moves, and this table drives the context dial's first frame.
 *
 * The trap the test exists for is the **substring fallback**: `getContextWindowForModel`
 * matches exact first, then by longest containing key. Adding a key can therefore
 * change the answer for a model string that was already resolving — silently, and
 * in a number a user reads off the dial.
 */

import { describe, it, expect } from "vitest";
import { getContextWindowForModel, MODEL_CONTEXT_WINDOWS } from "./model-windows.js";

/**
 * The literal map exactly as it shipped before the catalogue existed. Frozen on
 * purpose: it is the "before" side of a parity check, so it must NOT be updated
 * when a model is added — a new model belongs in the catalogue, and this table
 * only answers "did anything that already worked change".
 */
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

/** The old lookup, reproduced so the comparison is against behaviour, not data. */
function preCatalogueLookup(model: string): number {
  const exact = PRE_CATALOGUE_WINDOWS[model];
  if (exact) return exact;
  let bestKey: string | null = null;
  for (const key of Object.keys(PRE_CATALOGUE_WINDOWS)) {
    if (model.includes(key) && (bestKey === null || key.length > bestKey.length)) bestKey = key;
  }
  return bestKey ? PRE_CATALOGUE_WINDOWS[bestKey] : 200_000;
}

/**
 * Model strings a user could actually be running today: every pre-catalogue key,
 * plus versioned ids and aliases the CLI reports verbatim. Deliberately does NOT
 * include DeepSeek / GLM / gateway ids — no install can run those until phase 2
 * stores a credential and phase 3 routes a turn, so a changed answer for them is
 * not user-visible. The separate test below pins that they moved, and why.
 */
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
    // The whole (and only) movement: models the catalogue now declares that the
    // old table had never heard of, so they fell to the 200K default. They are
    // unreachable until phase 2 gives them a credential — which is why adding
    // them is not a user-visible change.
    for (const model of ["deepseek-v4-flash", "deepseek-v4-pro", "glm-5.2"]) {
      expect(preCatalogueLookup(model)).toBe(200_000);
      expect(getContextWindowForModel(model)).toBe(1_000_000);
    }
  });

  it("keeps Codex's assigned window for the GPT family, not OpenAI's advertised maximum", () => {
    // ShipIt runs these through Codex, whose app-server assigns 272K. The vendor
    // advertises 400K/1.05M; using that would move the dial on every Codex
    // session's first frame.
    expect(getContextWindowForModel("gpt-5.6-sol")).toBe(272_000);
    expect(getContextWindowForModel("gpt-5.2")).toBe(272_000);
  });
});
