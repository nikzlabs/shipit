import { describe, it, expect } from "vitest";
import { codexTurnTokens, disjointCodexTokens } from "./codex-token-usage.js";

describe("disjointCodexTokens", () => {
  it("subtracts both cache details out of the input total", () => {
    expect(disjointCodexTokens({
      inputTokens: 1000,
      cachedInputTokens: 800,
      outputTokens: 42,
      cacheWriteInputTokens: 50,
    })).toEqual({ input: 150, output: 42, cacheRead: 800, cacheWrite: 50 });
  });

  it("never leaves a cache-written token inside the ordinary input class", () => {
    const tokens = disjointCodexTokens({
      inputTokens: 1000,
      cachedInputTokens: 800,
      cacheWriteInputTokens: 50,
    });
    expect((tokens?.input ?? 0) + (tokens?.cacheRead ?? 0) + (tokens?.cacheWrite ?? 0)).toBe(1000);
  });

  it("keeps the input whole when nothing was cached", () => {
    expect(disjointCodexTokens({ inputTokens: 120, outputTokens: 7 }))
      .toEqual({ input: 120, output: 7, cacheRead: undefined });
  });

  it("floors at zero rather than going negative", () => {
    expect(disjointCodexTokens({ inputTokens: 100, cachedInputTokens: 400 })?.input).toBe(0);
  });

  it("reports nothing for a run that reported nothing", () => {
    expect(disjointCodexTokens(undefined)).toBeUndefined();
  });

  it("reports nothing for a usage block with no numbers in it", () => {
    expect(disjointCodexTokens({})).toBeUndefined();
    expect(disjointCodexTokens({ inputTokens: undefined })).toBeUndefined();
  });

  it("keeps an explicitly reported zero", () => {
    expect(disjointCodexTokens({ inputTokens: 0, outputTokens: 0 }))
      .toEqual({ input: 0, output: 0, cacheRead: undefined });
  });

  it("omits cacheWrite when the harness did not report one", () => {
    const tokens = disjointCodexTokens({ inputTokens: 10, outputTokens: 1 });
    expect(tokens).not.toHaveProperty("cacheWrite");
  });
});

describe("codexTurnTokens", () => {
  const TURN = { inputTokens: 1000, outputTokens: 10, cachedInputTokens: 800, cacheWriteInputTokens: 0 };
  const AFTER_ONE = { inputTokens: 1000, outputTokens: 10, cachedInputTokens: 800, cacheWriteInputTokens: 0 };
  const AFTER_TWO = { inputTokens: 2000, outputTokens: 20, cachedInputTokens: 1600, cacheWriteInputTokens: 0 };
  const AFTER_THREE = { inputTokens: 3000, outputTokens: 30, cachedInputTokens: 2400, cacheWriteInputTokens: 0 };

  it("subtracts the previous turn's rollup", () => {
    const expected = { input: 200, output: 10, cacheRead: 800, cacheWrite: 0 };
    expect(codexTurnTokens(AFTER_ONE, undefined)).toEqual(expected);
    expect(codexTurnTokens(AFTER_TWO, AFTER_ONE)).toEqual(expected);
    expect(codexTurnTokens(AFTER_THREE, AFTER_TWO)).toEqual(expected);
  });

  it("is the rollup itself on the first turn of a thread", () => {
    expect(codexTurnTokens(TURN, undefined)).toEqual(disjointCodexTokens(TURN));
  });

  it("passes an empty baseline through untouched", () => {
    expect(codexTurnTokens(TURN, {})).toEqual(disjointCodexTokens(TURN));
  });

  it("treats a shrunken rollup as a new baseline, not a negative turn", () => {
    expect(codexTurnTokens(AFTER_ONE, AFTER_THREE)).toEqual(disjointCodexTokens(AFTER_ONE));
  });

  it("floors each class at zero", () => {
    expect(codexTurnTokens(
      { inputTokens: 5000, outputTokens: 5, cachedInputTokens: 100 },
      { inputTokens: 1000, outputTokens: 10, cachedInputTokens: 800 },
    )).toEqual({ input: 4700, output: 0, cacheRead: 0 });
  });

  it("reports nothing when the turn reported nothing", () => {
    expect(codexTurnTokens(undefined, AFTER_TWO)).toBeUndefined();
    expect(codexTurnTokens({}, AFTER_TWO)).toBeUndefined();
  });
});
