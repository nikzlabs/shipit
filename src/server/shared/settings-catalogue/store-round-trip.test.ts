import { describe, it, expect } from "vitest";
import { allServices } from "../catalogue/index.js";
import type { BillingMode, ModelSelection } from "../catalogue/index.js";
import { ALL_SETTINGS } from "./registry.js";
import type { AnySettingDeclaration } from "./types.js";

/**
 * `validate` returns the value the store will hold
 * (docs/299-agent-settings-access req 4, `value-types.ts` → the contract).
 *
 * Every caller treats the validated value as the change it is making: a
 * proposal card renders it as `to` before the click, and the apply then writes
 * it through `serialize` and reads it back through `read`. Where those two
 * disagree with what `validate` answered, the card names one change and the
 * store holds another — which is how a memory budget of `0` showed as `0` and
 * stored as unset.
 *
 * Over the WHOLE registry rather than the types in isolation, because a
 * declaration is where a normalising option is switched on: `unsetBelow` and
 * `trim` are harmless on a type nobody instantiates that way. A setting added
 * tomorrow is covered the same day, which is req 7 holding here too.
 */

function liveSelection(): ModelSelection | undefined {
  for (const service of allServices()) {
    for (const mode of service.modes) {
      const model = mode.models[0];
      if (model) return { serviceId: service.id, billingMode: mode.kind as BillingMode, modelId: model.id };
    }
  }
  return undefined;
}

/**
 * Values worth offering a declaration, from what its own `shape` says it takes.
 * The boundaries are the point — a normalising declaration normalises at one,
 * and a candidate set of "the default and one ordinary value" would never meet
 * it.
 */
function candidates(declaration: AnySettingDeclaration): unknown[] {
  const { kind, shape, defaultValue } = declaration.type;
  const bounded = shape as { min?: number; max?: number; options?: { value: string }[] };
  switch (kind) {
    case "bool":
      return [true, false];
    case "enum":
      return (bounded.options ?? []).map((option) => option.value);
    case "number":
      return [defaultValue, null, 0, 1, -1, bounded.min, bounded.max].filter(
        (value) => value !== undefined,
      );
    case "text":
      return ["", "a value", "  padded  ", "line\nline"];
    case "gitIdentity":
      return [{ name: "Ada Lovelace", email: "ada@example.com" }];
    case "modelSelection":
      return [null, liveSelection()].filter((value) => value !== undefined);
    default:
      // A collection and a secret bag refuse every write by type, so there is
      // no validated value for the store to disagree with.
      return [];
  }
}

describe("a declared type answers with the value the store will hold", () => {
  for (const declaration of ALL_SETTINGS) {
    const values = candidates(declaration);
    if (values.length === 0) continue;

    it(`${declaration.key} reads back what validating returned`, () => {
      let checkedAny = false;
      for (const candidate of values) {
        const checked = declaration.type.validate(candidate, declaration.label);
        // A refusal is an answer: the value never reaches the store, so there
        // is nothing for it to hold differently.
        if (!checked.ok) continue;
        checkedAny = true;
        const readBack = declaration.type.read(declaration.type.serialize(checked.value));
        const why = `${declaration.key} validated ${JSON.stringify(candidate)} as `
          + `${JSON.stringify(checked.value)}, and the store reads that back as `
          + `${JSON.stringify(readBack)} instead`;
        expect(readBack, why).toEqual(checked.value);
      }
      // Otherwise a declaration that refuses every candidate would pass this
      // test by never running an assertion.
      expect(checkedAny).toBe(true);
    });
  }
});
