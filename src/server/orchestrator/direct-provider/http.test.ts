import { describe, it, expect } from "vitest";
import { maxOutputTokens } from "./http.js";

describe("maxOutputTokens", () => {
  it("leaves room for the whole character budget", () => {
    // Four characters per token is the pessimistic end of the usual range, so a
    // cap below chars/4 could truncate an answer the caller would have accepted.
    for (const chars of [500, 1200, 4000, 120_000]) {
      expect(maxOutputTokens(chars)).toBeGreaterThanOrEqual(chars / 4);
    }
  });

  it("keeps a floor under a tiny budget", () => {
    expect(maxOutputTokens(1)).toBeGreaterThanOrEqual(64);
  });

  it("is always a whole number of tokens", () => {
    expect(Number.isInteger(maxOutputTokens(1001))).toBe(true);
  });
});
