import { describe, it, expect } from "vitest";

import { claudeModelArg, unshapeClaudeModelId } from "./spawn-routing.js";
import { MODEL_CONTEXT_WINDOWS } from "./model-windows.js";

describe("claudeModelArg", () => {
  it("appends [1m] to a 1M model the CLI does not recognize", () => {
    expect(MODEL_CONTEXT_WINDOWS["claude-fable-5-1"]).toBe(1_000_000);
    expect(claudeModelArg("claude-fable-5-1")).toBe("claude-fable-5-1[1m]");
  });

  it("appends [1m] to every other 1M model on this harness, not just Anthropic's", () => {
    expect(claudeModelArg("deepseek-v4-flash")).toBe("deepseek-v4-flash[1m]");
    expect(claudeModelArg("anthropic/claude-fable-5.1")).toBe("anthropic/claude-fable-5.1[1m]");
  });

  it("leaves a 200K model alone", () => {
    expect(claudeModelArg("haiku")).toBe("haiku");
  });

  it("leaves an id the catalogue has no window for alone", () => {
    expect(MODEL_CONTEXT_WINDOWS["totally-made-up-model"]).toBeUndefined();
    expect(claudeModelArg("totally-made-up-model")).toBe("totally-made-up-model");
  });

  it("does not double-suffix a catalogue id that already carries one", () => {
    expect(claudeModelArg("glm-5.3[1m]")).toBe("glm-5.3[1m]");
  });
});

describe("unshapeClaudeModelId", () => {
  it("undoes the suffix this module appended", () => {
    expect(unshapeClaudeModelId("claude-fable-5-1[1m]", "claude-fable-5-1")).toBe("claude-fable-5-1");
    expect(unshapeClaudeModelId("deepseek-v4-flash[1m]", "deepseek-v4-flash")).toBe("deepseek-v4-flash");
  });

  it("tells the two GLM rows apart, which the reported string alone cannot", () => {
    expect(unshapeClaudeModelId("glm-5.3[1m]", "glm-5.3[1m]")).toBe("glm-5.3[1m]");
    expect(unshapeClaudeModelId("glm-5.3[1m]", "glm-5.3")).toBe("glm-5.3");
    expect(unshapeClaudeModelId("glm-5.2[1m]", "glm-5.2")).toBe("glm-5.2");
  });

  it("passes an unsuffixed id through untouched", () => {
    expect(unshapeClaudeModelId("claude-opus-5", "claude-opus-5")).toBe("claude-opus-5");
  });

  it("passes through a model this spawn did not select", () => {
    expect(unshapeClaudeModelId("claude-sonnet-5", "claude-fable-5-1")).toBe("claude-sonnet-5");
    expect(unshapeClaudeModelId("haiku[1m]", "haiku")).toBe("haiku[1m]");
    expect(unshapeClaudeModelId("claude-fable-5-1[500k]", "claude-fable-5-1")).toBe("claude-fable-5-1[500k]");
  });

  it("passes through when the spawn selected no model", () => {
    expect(unshapeClaudeModelId("claude-opus-5", undefined)).toBe("claude-opus-5");
  });
});
