import { describe, it, expect } from "vitest";
import {
  resolveCollapseStage,
  MAX_COLLAPSE_STAGE,
  ADDRESS_MIN_PX,
} from "./usePreviewToolbarCollapse.js";

/**
 * A toy layout model of the toolbar, enough to exercise the priority rule.
 *
 * Fixed content is the icons and whatever labels are still shown; the address
 * gets whatever is left over, capped at the width of the full URL. That is the
 * real bar's behaviour reduced to arithmetic: the address is the only flexible
 * item, so it absorbs every pixel the labels give up.
 */
function layout({
  panel,
  iconsWidth = 240,
  labelWidths = [60, 55, 90], // viewport, auto-fix, service — dropped in this order
  addressNatural = 140,
}: {
  panel: number;
  iconsWidth?: number;
  labelWidths?: number[];
  /**
   * Width the URL wants. Vary this — a short path is narrow however much room
   * it is given, and treating that as pressure is a defect the default value
   * cannot expose.
   */
  addressNatural?: number;
}) {
  let stage = 0;
  const apply = (next: number) => { stage = next; };
  const probe = () => {
    const labels = labelWidths.slice(stage).reduce((a, b) => a + b, 0);
    const fixed = iconsWidth + labels;
    // The address takes the remainder, never more than the full URL and never
    // less than zero. The row overflows only once even a zero-width address
    // cannot save it.
    const addressWidth = Math.max(0, Math.min(addressNatural, panel - fixed));
    return {
      overflows: fixed > panel,
      addressWidth,
      // Cut short exactly when it got less than it wanted.
      addressTruncated: addressWidth < addressNatural,
    };
  };
  return { apply, probe, getStage: () => stage };
}

function stageAt(panel: number, addressMin = ADDRESS_MIN_PX, opts = {}) {
  const { apply, probe } = layout({ panel, ...opts });
  return resolveCollapseStage(addressMin, apply, probe);
}

describe("resolveCollapseStage", () => {
  it("keeps every label while the address has its minimum", () => {
    // 240 icons + 205 labels + 140 address = 585
    expect(stageAt(600)).toBe(0);
  });

  it("drops labels one at a time as the panel narrows", () => {
    const wide = stageAt(600);
    const mid = stageAt(520);
    const narrow = stageAt(460);
    expect(wide).toBeLessThan(mid);
    expect(mid).toBeLessThan(narrow);
  });

  it("never spends more stages than there are labels", () => {
    expect(stageAt(120)).toBe(MAX_COLLAPSE_STAGE);
    expect(stageAt(0)).toBe(MAX_COLLAPSE_STAGE);
  });

  it("gives up EVERY label before letting the address go under its minimum", () => {
    // The address is the priority: at any width where a label is still shown,
    // the address must be at or above its minimum. This is the rule the whole
    // feature exists for, so assert it across the range rather than at a point.
    for (let panel = 700; panel >= 300; panel -= 5) {
      const { apply, probe } = layout({ panel });
      const stage = resolveCollapseStage(ADDRESS_MIN_PX, apply, probe);
      if (stage < MAX_COLLAPSE_STAGE) {
        const { addressWidth } = probe();
        expect(addressWidth).toBeGreaterThanOrEqual(ADDRESS_MIN_PX - 0.5);
      }
    }
  });

  it("collapse is monotonic — a narrower panel never restores a label", () => {
    let previous = 0;
    for (let panel = 800; panel >= 200; panel -= 5) {
      const stage = stageAt(panel);
      expect(stage).toBeGreaterThanOrEqual(previous);
      previous = stage;
    }
  });

  it("only shrinks the address once no labels are left to give", () => {
    // Note this is one-directional: reaching the last stage does NOT imply a
    // squeezed address, because dropping the final label frees more width than
    // the deficit that dropped it. The invariant is the other way round — a
    // squeezed address proves there was nothing left to give.
    for (let panel = 800; panel >= 200; panel -= 5) {
      const { apply, probe } = layout({ panel });
      const stage = resolveCollapseStage(ADDRESS_MIN_PX, apply, probe);
      const { addressWidth } = probe();
      if (addressWidth !== null && addressWidth < ADDRESS_MIN_PX - 0.5) {
        expect(stage).toBe(MAX_COLLAPSE_STAGE);
      }
    }
  });

  it("shrinks the address rather than hiding it once the labels are gone", () => {
    // 240 of icons leaves 60 for the address at 300px wide: well under the
    // minimum, every label already spent, and still a positive width — the
    // address degrades by getting shorter, never by disappearing.
    const { apply, probe } = layout({ panel: 300 });
    const stage = resolveCollapseStage(ADDRESS_MIN_PX, apply, probe);
    expect(stage).toBe(MAX_COLLAPSE_STAGE);
    const { addressWidth } = probe();
    expect(addressWidth).toBeLessThan(ADDRESS_MIN_PX);
    expect(addressWidth).toBeGreaterThan(0);
  });

  it("does not collapse a roomy toolbar just because the URL is short", () => {
    // The regression that shipped in the first cut of this hook. The measured
    // element is content-sized, so "/" is ~8px wide in a 1200px toolbar exactly
    // as in a 320px one. Testing width alone read that as starvation and hid
    // every label at every width — on the most ordinary path there is.
    for (const natural of [8, 40, 90, 129]) {
      expect(stageAt(1200, ADDRESS_MIN_PX, { addressNatural: natural })).toBe(0);
    }
  });

  it("still protects a long URL that is genuinely being squeezed", () => {
    // The other side of the same rule: being under the minimum counts when the
    // address is cut short, or the protection would never fire at all.
    expect(stageAt(520, ADDRESS_MIN_PX, { addressNatural: 400 })).toBeGreaterThan(0);
  });

  it("does not spend stages on a long URL that already has its minimum", () => {
    // A very long URL stays truncated no matter how much room it is given, so
    // truncation alone must not buy a stage — only truncation *below* the
    // minimum does.
    const { apply, probe } = layout({ panel: 1200, addressNatural: 5000 });
    expect(resolveCollapseStage(ADDRESS_MIN_PX, apply, probe)).toBe(0);
    expect(probe().addressTruncated).toBe(true);
  });

  it("does not collapse for a starved address when there is no address at all", () => {
    // PreviewPath renders no address until the page reports a path. A null
    // width must not read as "starved" — that would collapse a bar that fits.
    const probe = () => ({ overflows: false, addressWidth: null, addressTruncated: false });
    expect(resolveCollapseStage(ADDRESS_MIN_PX, () => {}, probe)).toBe(0);
  });

  it("still collapses on real overflow when no address is shown", () => {
    let stage = 0;
    const probe = () => ({ overflows: stage < 2, addressWidth: null, addressTruncated: false });
    const result = resolveCollapseStage(ADDRESS_MIN_PX, (s) => { stage = s; }, probe);
    expect(result).toBe(2);
  });

  it("a bigger address minimum makes labels give way sooner", () => {
    const panel = 540;
    expect(stageAt(panel, 60)).toBeLessThan(stageAt(panel, 200));
  });

  it("treats an address sitting exactly on the minimum as satisfied", () => {
    // Sub-pixel widths would otherwise spend a stage that buys nothing.
    const probe = () => ({ overflows: false, addressWidth: ADDRESS_MIN_PX, addressTruncated: true });
    expect(resolveCollapseStage(ADDRESS_MIN_PX, () => {}, probe)).toBe(0);
  });
});
