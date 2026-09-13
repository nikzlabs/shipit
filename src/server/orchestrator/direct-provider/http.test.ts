import { describe, it, expect } from "vitest";
import { maxOutputTokens, requireText, uncachedInput } from "./http.js";
import { DirectCallError } from "./types.js";

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

  it("adds the reasoning allowance on top of the text budget", () => {
    expect(maxOutputTokens(1200, 4096)).toBe(maxOutputTokens(1200) + 4096);
  });

  it("is always a whole number of tokens", () => {
    expect(Number.isInteger(maxOutputTokens(1001))).toBe(true);
  });
});

describe("uncachedInput", () => {
  it("removes both cache portions from an inclusive total", () => {
    expect(uncachedInput(100, 60, 20)).toBe(20);
  });

  it("stays undefined when the provider reported no total", () => {
    // A zero would assert a free run, which is not what silence means.
    expect(uncachedInput(undefined, 60, 20)).toBeUndefined();
  });

  it("never goes negative on an inconsistent report", () => {
    expect(uncachedInput(10, 60, 20)).toBe(0);
  });
});

describe("requireText", () => {
  it("passes text through", () => {
    expect(requireText("answer", "Style")).toBe("answer");
  });

  it("turns an empty answer into an error naming why it stopped", () => {
    expect(() => requireText("", "Style", "max_tokens")).toThrow(DirectCallError);
    expect(() => requireText("", "Style", "max_tokens")).toThrow(/max_tokens/);
  });
});
