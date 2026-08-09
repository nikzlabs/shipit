import { describe, it, expect } from "vitest";
import { disjointCodexTokens } from "./codex-token-usage.js";

describe("disjointCodexTokens", () => {
  // The measurement this module exists for: codex-cli 0.146.0, fed a Responses
  // reply carrying `input_tokens: 1000` with `input_tokens_details:
  // {cached_tokens: 800, cache_write_tokens: 50}`, passes the 1000 through
  // untouched and reports both details beside it. `costFromRates` charges each
  // class a REPLACEMENT rate, so both details come out of the total: 1000 − 800
  // − 50 = 150.
  it("subtracts both cache details out of the input total", () => {
    expect(disjointCodexTokens({
      inputTokens: 1000,
      cachedInputTokens: 800,
      outputTokens: 42,
      cacheWriteInputTokens: 50,
    })).toEqual({ input: 150, output: 42, cacheRead: 800, cacheWrite: 50 });
  });

  // Cross-backend review caught this one. Subtracting only the cached portion
  // leaves the written tokens inside `input` as well as in `cacheWrite`, so
  // `costFromRates` bills them at the ordinary rate AND again at the write rate
  // — on OpenAI's GPT-5.6 family that second rate is 1.25× input, and Codex
  // reports no dollar figure that would mask the error.
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

  // A provider reporting the details as additions rather than as portions of
  // the total would otherwise go negative — a credit on the bill, which is
  // worse than the double-count the subtraction guards against.
  it("floors at zero rather than going negative", () => {
    expect(disjointCodexTokens({ inputTokens: 100, cachedInputTokens: 400 })?.input).toBe(0);
  });

  // No telemetry and zero telemetry are different facts: an all-zero row prices
  // to $0 through the catalogue's rates and asserts the run was free.
  it("reports nothing for a run that reported nothing", () => {
    expect(disjointCodexTokens(undefined)).toBeUndefined();
  });

  // Same fact arriving as a present-but-empty block, which is the shape that
  // slips past an `if (usage)` guard at the call site.
  it("reports nothing for a usage block with no numbers in it", () => {
    expect(disjointCodexTokens({})).toBeUndefined();
    expect(disjointCodexTokens({ inputTokens: undefined })).toBeUndefined();
  });

  // A genuine zero IS a report — it is only the absence that must stay absent.
  it("keeps an explicitly reported zero", () => {
    expect(disjointCodexTokens({ inputTokens: 0, outputTokens: 0 }))
      .toEqual({ input: 0, output: 0, cacheRead: undefined });
  });

  it("omits cacheWrite when the harness did not report one", () => {
    const tokens = disjointCodexTokens({ inputTokens: 10, outputTokens: 1 });
    expect(tokens).not.toHaveProperty("cacheWrite");
  });
});
