import { describe, it, expect } from "vitest";
import { disjointCodexTokens } from "./codex-token-usage.js";

describe("disjointCodexTokens", () => {
  // The measurement this module exists for: codex-cli 0.146.0, fed a response
  // reporting `input_tokens: 1000` with `cached_tokens: 800`, reports both
  // figures unchanged on both of its surfaces. ShipIt's pricing code assumes
  // the classes are disjoint, so the cached portion comes out of the input.
  it("subtracts the cached portion out of the input total", () => {
    expect(disjointCodexTokens({
      inputTokens: 1000,
      cachedInputTokens: 800,
      outputTokens: 42,
      cacheWriteInputTokens: 5,
    })).toEqual({ input: 200, output: 42, cacheRead: 800, cacheWrite: 5 });
  });

  it("keeps the input whole when nothing was cached", () => {
    expect(disjointCodexTokens({ inputTokens: 120, outputTokens: 7 }))
      .toEqual({ input: 120, output: 7, cacheRead: undefined });
  });

  // A future app server reporting the classes disjointly would otherwise go
  // negative, which prices as a credit rather than merely double-counting.
  it("floors at zero rather than going negative", () => {
    expect(disjointCodexTokens({ inputTokens: 100, cachedInputTokens: 400 })?.input).toBe(0);
  });

  // No telemetry and zero telemetry are different facts: an all-zero row prices
  // to $0 through the catalogue's rates and asserts the run was free.
  it("reports nothing for a run that reported nothing", () => {
    expect(disjointCodexTokens(undefined)).toBeUndefined();
  });

  it("omits cacheWrite when the harness did not report one", () => {
    const tokens = disjointCodexTokens({ inputTokens: 10, outputTokens: 1 });
    expect(tokens).not.toHaveProperty("cacheWrite");
  });
});
