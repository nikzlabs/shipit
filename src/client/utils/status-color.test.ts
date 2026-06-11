import { describe, expect, it } from "vitest";
import { adaptColorForSurface, luminanceOfCssColor } from "./status-color.js";

const LIGHT = luminanceOfCssColor("#ffffff"); // 1.0
const DARK = luminanceOfCssColor("#111827"); // ~0.01

function lum(hex: string): number {
  return luminanceOfCssColor(hex);
}

describe("luminanceOfCssColor", () => {
  it("ranks white > gray > black", () => {
    expect(luminanceOfCssColor("#ffffff")).toBeGreaterThan(luminanceOfCssColor("#808080"));
    expect(luminanceOfCssColor("#808080")).toBeGreaterThan(luminanceOfCssColor("#000000"));
  });

  it("parses rgb() and falls back to light (1) when unparseable", () => {
    expect(luminanceOfCssColor("rgb(255, 255, 255)")).toBeCloseTo(1, 5);
    expect(luminanceOfCssColor("not-a-color")).toBe(1);
  });
});

describe("adaptColorForSurface", () => {
  it("darkens a near-white status on a light surface", () => {
    const out = adaptColorForSurface("#e2e2e2", LIGHT);
    expect(out).not.toBe("#e2e2e2");
    expect(lum(out)).toBeLessThan(lum("#e2e2e2"));
  });

  it("darkens a light-yellow status a bit on a light surface", () => {
    const out = adaptColorForSurface("#f2c94c", LIGHT);
    expect(lum(out)).toBeLessThan(lum("#f2c94c"));
  });

  it("leaves an already-dark status unchanged on a light surface", () => {
    // Indigo "Done" already clears the contrast bar against white.
    expect(adaptColorForSurface("#5e6ad2", LIGHT)).toBe("#5e6ad2");
  });

  it("lightens a dark status on a dark surface", () => {
    const out = adaptColorForSurface("#1b2430", DARK);
    expect(lum(out)).toBeGreaterThan(lum("#1b2430"));
  });

  it("leaves a light status unchanged on a dark surface", () => {
    // A near-white gray already pops on dark.
    expect(adaptColorForSurface("#e2e2e2", DARK)).toBe("#e2e2e2");
  });

  it("passes non-hex (CSS-var token) colors through untouched", () => {
    expect(adaptColorForSurface("var(--color-text-tertiary)", LIGHT)).toBe("var(--color-text-tertiary)");
  });
});
