import { describe, it, expect } from "vitest";
import { maxOutputTokens, requireCompleteText, uncachedInput } from "./http.js";
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

describe("requireCompleteText", () => {
  it("passes text through", () => {
    expect(requireCompleteText("answer", "Style")).toBe("answer");
  });

  it("turns an empty answer into an error naming why it stopped", () => {
    expect(() => requireCompleteText("", "Style", "max_tokens")).toThrow(DirectCallError);
    expect(() => requireCompleteText("", "Style", "max_tokens")).toThrow(/max_tokens/);
  });

  // A partial answer reads exactly like a complete one, so accepting it would
  // replace a dictation with its own opening clause and say nothing.
  it("rejects a partial answer the provider stopped on its output limit", () => {
    expect(() => requireCompleteText("Rename the file", "Style", "max_tokens"))
      .toThrow(/output budget/);
    expect(() => requireCompleteText("Rename the file", "Style", "length"))
      .toThrow(/output budget/);
  });

  it("keeps the counts on the error, because the partial answer was billed", () => {
    try {
      requireCompleteText("Rename the file", "Style", "length", { inputTokens: 90, outputTokens: 12 });
      throw new Error("expected a failure");
    } catch (err) {
      expect((err as DirectCallError).usage).toEqual({ inputTokens: 90, outputTokens: 12 });
    }
  });

  it("passes an ordinary stop reason through", () => {
    expect(requireCompleteText("answer", "Style", "stop")).toBe("answer");
    expect(requireCompleteText("answer", "Style", "end_turn")).toBe("answer");
    expect(requireCompleteText("answer", "Style", "completed")).toBe("answer");
  });
});
