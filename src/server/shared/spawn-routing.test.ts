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
    expect(unshapeClaudeModelId("claude-fable-5-1[1m]", "claude-fable-5-1")).toBe("claude-fable-5-1");
    expect(unshapeClaudeModelId("deepseek-v4-pro[1m]", "deepseek-v4-pro")).toBe("deepseek-v4-pro");
  });

  it("tells the two GLM rows apart, which the reported string alone cannot", () => {
    // Z.ai declares `glm-5.3[1m]` in subscription mode and `glm-5.3` in key
    // mode, so ONE reported string has two right answers. This is the case a
    // context-free inverse got wrong.
    expect(unshapeClaudeModelId("glm-5.3[1m]", "glm-5.3[1m]")).toBe("glm-5.3[1m]");
    expect(unshapeClaudeModelId("glm-5.3[1m]", "glm-5.3")).toBe("glm-5.3");
    expect(unshapeClaudeModelId("glm-5.2[1m]", "glm-5.2")).toBe("glm-5.2");
  });

  it("passes an unsuffixed id through untouched", () => {
    expect(unshapeClaudeModelId("claude-opus-5", "claude-opus-5")).toBe("claude-opus-5");
  });

  it("passes through a model this spawn did not select", () => {
    // A mid-session `/model` switch: not the id this spawn shaped, so there is
    // nothing to undo and the CLI's answer stands.
    expect(unshapeClaudeModelId("claude-sonnet-5", "claude-fable-5-1")).toBe("claude-sonnet-5");
    expect(unshapeClaudeModelId("haiku[1m]", "haiku")).toBe("haiku[1m]");
    expect(unshapeClaudeModelId("claude-fable-5-1[500k]", "claude-fable-5-1")).toBe("claude-fable-5-1[500k]");
  });

  it("passes through when the spawn selected no model", () => {
    expect(unshapeClaudeModelId("claude-opus-5", undefined)).toBe("claude-opus-5");
  });
});
