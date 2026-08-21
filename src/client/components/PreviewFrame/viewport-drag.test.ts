import { describe, it, expect } from "vitest";
import {
  KEYBOARD_RESIZE_STEP,
  sizeFromArrowKey,
  sizeFromDrag,
  toStoredSize,
} from "./viewport-drag.js";
import { VIEWPORT_SIZE_MAX, VIEWPORT_SIZE_MIN } from "../device-presets.js";

const anchor = (over: Partial<{ width: number; height: number; scale: number }> = {}) => ({
  width: 400,
  height: 800,
  scale: 1,
  ...over,
});

describe("sizeFromDrag", () => {
  it("keeps the dragged edge under the pointer, which is twice the delta on a centred frame", () => {
    // The frame grows from its middle, so each edge only travels half as far as
    // the size changes. 30px of pointer travel therefore has to buy 60px.
    expect(sizeFromDrag("right", anchor(), 30, 0)).toEqual({ width: 460, height: 800 });
  });

  it("shrinks when dragged inward", () => {
    expect(sizeFromDrag("right", anchor(), -50, 0)).toEqual({ width: 300, height: 800 });
  });

  it("converts pointer travel into more viewport px when the frame is scaled down", () => {
    // At 50% a pixel on screen is two viewport px, on top of the centred
    // doubling: 30 → 30 × 2 / 0.5 = 120.
    expect(sizeFromDrag("right", anchor({ scale: 0.5 }), 30, 0)).toEqual({ width: 520, height: 800 });
  });

  it("moves only the axis its edge owns", () => {
    expect(sizeFromDrag("right", anchor(), 30, 90)).toEqual({ width: 460, height: 800 });
    expect(sizeFromDrag("bottom", anchor(), 30, 90)).toEqual({ width: 400, height: 980 });
  });

  it("moves both axes from the corner", () => {
    expect(sizeFromDrag("corner", anchor(), 30, 90)).toEqual({ width: 460, height: 980 });
  });

  it("holds the size inside the allowed range however far the pointer goes", () => {
    expect(sizeFromDrag("corner", anchor(), -9999, -9999)).toEqual({
      width: VIEWPORT_SIZE_MIN,
      height: VIEWPORT_SIZE_MIN,
    });
    expect(sizeFromDrag("corner", anchor(), 9999, 9999)).toEqual({
      width: VIEWPORT_SIZE_MAX,
      height: VIEWPORT_SIZE_MAX,
    });
  });

  it("produces whole pixels", () => {
    expect(sizeFromDrag("right", anchor({ scale: 0.37 }), 7, 0).width % 1).toBe(0);
  });

  it("still resizes when the panel has not been measured yet", () => {
    // scale 0 would divide the drag by nothing and yield NaN, leaving a handle
    // that silently does nothing on the first drag after a mount.
    expect(sizeFromDrag("right", anchor({ scale: 0 }), 30, 0)).toEqual({ width: 460, height: 800 });
  });
});

describe("toStoredSize", () => {
  it("stores a portrait drag as dragged", () => {
    expect(toStoredSize({ width: 500, height: 900 }, false)).toEqual({ width: 500, height: 900 });
  });

  it("swaps a landscape drag back, so rotating afterwards does not transpose it", () => {
    expect(toStoredSize({ width: 900, height: 500 }, true)).toEqual({ width: 500, height: 900 });
  });

  it("round-trips: what is stored renders back at the size that was dragged", () => {
    const dragged = { width: 900, height: 500 };
    const stored = toStoredSize(dragged, true);
    // `useDeviceFrame` renders a landscape size by swapping the stored one.
    expect({ width: stored.height, height: stored.width }).toEqual(dragged);
  });
});

describe("sizeFromArrowKey", () => {
  it("steps the width by one step per press, without the centred doubling", () => {
    // A key press asks for a number of viewport px; there is no pointer to keep
    // under an edge, so the step is the step.
    expect(sizeFromArrowKey("right", { width: 400, height: 800 }, "ArrowRight")).toEqual({
      width: 400 + KEYBOARD_RESIZE_STEP,
      height: 800,
    });
    expect(sizeFromArrowKey("right", { width: 400, height: 800 }, "ArrowLeft")).toEqual({
      width: 400 - KEYBOARD_RESIZE_STEP,
      height: 800,
    });
  });

  it("steps the height from the bottom edge", () => {
    expect(sizeFromArrowKey("bottom", { width: 400, height: 800 }, "ArrowDown")).toEqual({
      width: 400,
      height: 800 + KEYBOARD_RESIZE_STEP,
    });
  });

  it("takes both axes at the corner", () => {
    expect(sizeFromArrowKey("corner", { width: 400, height: 800 }, "ArrowRight")?.width).toBe(410);
    expect(sizeFromArrowKey("corner", { width: 400, height: 800 }, "ArrowUp")?.height).toBe(790);
  });

  it("ignores a key that is not this handle's axis, so the panel keeps its own scrolling", () => {
    expect(sizeFromArrowKey("right", { width: 400, height: 800 }, "ArrowUp")).toBeNull();
    expect(sizeFromArrowKey("bottom", { width: 400, height: 800 }, "ArrowLeft")).toBeNull();
    expect(sizeFromArrowKey("corner", { width: 400, height: 800 }, "Enter")).toBeNull();
  });

  it("stops at the bounds rather than stepping past them", () => {
    expect(sizeFromArrowKey("right", { width: VIEWPORT_SIZE_MIN, height: 800 }, "ArrowLeft")).toEqual({
      width: VIEWPORT_SIZE_MIN,
      height: 800,
    });
    expect(sizeFromArrowKey("right", { width: VIEWPORT_SIZE_MAX, height: 800 }, "ArrowRight")).toEqual({
      width: VIEWPORT_SIZE_MAX,
      height: 800,
    });
  });
});
