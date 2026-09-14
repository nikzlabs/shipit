import { describe, it, expect } from "vitest";
import { APPLIED, applyFailed, applyPartial, applyUncertain, combineOutcomes, isApplied } from "./apply-outcome.js";

/**
 * One outcome for an operation made of several writes
 * (docs/299-agent-settings-access, plan.md → "Saved" has to mean saved). The
 * two that are easy to get backwards each claim more than the parts support, so
 * both have a case of their own.
 */
describe("combineOutcomes", () => {
  it("is applied only when every part is", () => {
    expect(combineOutcomes([APPLIED, APPLIED])).toEqual(APPLIED);
    expect(isApplied(combineOutcomes([APPLIED, applyUncertain("could not say")]))).toBe(false);
  });

  it("calls a failure beside something that landed a `partial`", () => {
    // "Nothing changed" is untrue of the operation as a whole.
    expect(combineOutcomes([APPLIED, applyFailed("disk full")]).status).toBe("partial");
    expect(combineOutcomes([applyPartial("half"), APPLIED]).status).toBe("partial");
  });

  it("calls a failure beside an UNCERTAIN an `uncertain`, never a `failed`", () => {
    // `failed` means verified nothing changed, and a write that could not say
    // whether it landed leaves nothing to verify.
    expect(combineOutcomes([applyFailed("disk full"), applyUncertain("could not say")]).status)
      .toBe("uncertain");
  });

  it("is applied for an empty group, which a caller with no writes must not fold in", () => {
    // The trap: an `applied` standing for no write makes a lone `failed` read as
    // a `partial`, which is why `saveGlobalSettings` folds this in only when
    // there is bespoke work.
    expect(combineOutcomes([])).toEqual(APPLIED);
    expect(combineOutcomes([applyFailed("disk full"), combineOutcomes([])]).status).toBe("partial");
  });

  it("carries every part's detail, so the caller can say which half landed", () => {
    const combined = combineOutcomes([applyFailed("the email did not save"), APPLIED]);
    expect(combined.detail).toContain("the email did not save");
  });
});
