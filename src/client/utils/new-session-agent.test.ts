import { describe, it, expect, beforeEach } from "vitest";
import { newSessionAgentId } from "./new-session-agent.js";
import type { AgentOption } from "../agent-types.js";

function agent(id: string, models: string[]): AgentOption {
  return {
    id,
    name: id,
    installed: true,
    hasRunnableModels: true,
    models,
    supportsReview: false,
  };
}

const agents = [agent("claude", ["claude-sonnet-5"]), agent("codex", ["gpt-5.6-sol"])];

beforeEach(() => {
  localStorage.removeItem("vibe-agent-id");
  localStorage.removeItem("vibe-model-id");
});

describe("newSessionAgentId", () => {
  it("derives the harness from the saved model, not the saved agent", () => {
    // The model is the single source of truth (docs/142 Problem C): a stale
    // `vibe-agent-id` must not out-vote it, or the server rewrites the model to
    // one the named harness owns.
    localStorage.setItem("vibe-agent-id", "claude");
    localStorage.setItem("vibe-model-id", "gpt-5.6-sol");
    expect(newSessionAgentId(agents)).toBe("codex");
  });

  it("falls back to the saved agent when the model is unknown", () => {
    localStorage.setItem("vibe-agent-id", "codex");
    localStorage.setItem("vibe-model-id", "some-model-no-harness-lists");
    expect(newSessionAgentId(agents)).toBe("codex");
  });

  it("falls back to the saved agent when the agent list has not loaded", () => {
    localStorage.setItem("vibe-agent-id", "codex");
    localStorage.setItem("vibe-model-id", "gpt-5.6-sol");
    expect(newSessionAgentId([])).toBe("codex");
  });

  it("defaults to claude with nothing saved", () => {
    expect(newSessionAgentId(agents)).toBe("claude");
  });
});
