import { describe, it, expect } from "vitest";

import { claudeModelArg, unshapeClaudeModelId } from "./spawn-routing.js";
import { MODEL_CONTEXT_WINDOWS } from "./model-windows.js";

/**
 * These pin the shaping rule against MEASURED CLI behaviour (2.1.251): an id
 * Claude Code does not recognize runs at the 200K window it assumes unless
 * `[1m]` tells it otherwise, and the suffix must not survive back into any
 * catalogue lookup.
 */
describe("claudeModelArg", () => {
  it("appends [1m] to a 1M model the CLI does not recognize", () => {
    // The id from the report that started this: Anthropic's Fable 5.1, which
    // the pinned CLI predates.
    expect(MODEL_CONTEXT_WINDOWS["claude-fable-5-1"]).toBe(1_000_000);
    expect(claudeModelArg("claude-fable-5-1")).toBe("claude-fable-5-1[1m]");
  });

  it("appends [1m] to every other 1M model on this harness, not just Anthropic's", () => {
    // A gateway row and a vendor row: both are unrecognized ids to the CLI, so
    // both were silently running at 200K.
    expect(claudeModelArg("deepseek-v4-pro")).toBe("deepseek-v4-pro[1m]");
    expect(claudeModelArg("anthropic/claude-fable-5.1")).toBe("anthropic/claude-fable-5.1[1m]");
  });

  it("leaves a 200K model alone", () => {
    expect(claudeModelArg("haiku")).toBe("haiku");
  });

  it("leaves an id the catalogue has no window for alone", () => {
    // Guessing HIGH here would tell the CLI not to compact a session that
    // really is 200K, so an unknown id gets no suffix rather than a substring
    // match's guess.
    expect(MODEL_CONTEXT_WINDOWS["totally-made-up-model"]).toBeUndefined();
    expect(claudeModelArg("totally-made-up-model")).toBe("totally-made-up-model");
  });

  it("does not double-suffix a catalogue id that already carries one", () => {
    expect(claudeModelArg("glm-5.3[1m]")).toBe("glm-5.3[1m]");
  });
});

describe("unshapeClaudeModelId", () => {
  it("undoes the suffix this module appended", () => {
    // The literal string, not `unshape(shape(x))` — a round trip through two
    // identity functions would pass with the shaping removed entirely.
    expect(unshapeClaudeModelId("claude-fable-5-1[1m]")).toBe("claude-fable-5-1");
    expect(unshapeClaudeModelId("deepseek-v4-pro[1m]")).toBe("deepseek-v4-pro");
  });

  it("keeps a suffix that is part of the catalogue id itself", () => {
    // `glm-5.3[1m]` IS the row id — stripping it would break every lookup keyed
    // on it, which is why this is the inverse of `claudeModelArg` and not a
    // blanket strip.
    expect(unshapeClaudeModelId("glm-5.3[1m]")).toBe("glm-5.3[1m]");
  });

  it("passes an unsuffixed id through untouched", () => {
    expect(unshapeClaudeModelId("claude-opus-5")).toBe("claude-opus-5");
  });

  it("keeps a suffix ShipIt would not have produced", () => {
    expect(unshapeClaudeModelId("haiku[1m]")).toBe("haiku[1m]");
    expect(unshapeClaudeModelId("claude-fable-5-1[500k]")).toBe("claude-fable-5-1[500k]");
  });
});
