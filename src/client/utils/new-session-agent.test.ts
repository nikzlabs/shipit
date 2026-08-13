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

  it("lets the saved harness break the tie on a model both can run", () => {
    // docs/252 ended "each model belongs to exactly one agent": a model with
    // both an Anthropic-messages and an OpenAI style — DeepSeek V4, GLM,
    // anything through OpenRouter — is runnable on either harness, and deriving
    // an owner then just returns whichever sorts first. That out-voted the
    // user's own harness pick, so picking Codex on such a model did nothing.
    const shared = [agent("claude", ["deepseek-v4-pro"]), agent("codex", ["deepseek-v4-pro"])];
    localStorage.setItem("vibe-model-id", "deepseek-v4-pro");
    localStorage.setItem("vibe-agent-id", "codex");
    expect(newSessionAgentId(shared)).toBe("codex");
    localStorage.setItem("vibe-agent-id", "claude");
    expect(newSessionAgentId(shared)).toBe("claude");
  });

  it("does not let an uninstalled or credential-less harness win the tie", () => {
    // The saved key outlives the install: a deployment that dropped the harness
    // (req 14), or a credential that went away, would otherwise seed a session
    // whose very first turn cannot start.
    const shared = (codex: Partial<AgentOption>) => [
      agent("claude", ["deepseek-v4-pro"]),
      { ...agent("codex", ["deepseek-v4-pro"]), ...codex },
    ];
    localStorage.setItem("vibe-model-id", "deepseek-v4-pro");
    localStorage.setItem("vibe-agent-id", "codex");
    expect(newSessionAgentId(shared({ installed: false }))).toBe("claude");
    expect(newSessionAgentId(shared({ hasRunnableModels: false }))).toBe("claude");
    // …and it does win once the harness is actually there.
    expect(newSessionAgentId(shared({}))).toBe("codex");
  });

  it("still lets the model override a saved harness that cannot run it", () => {
    // The tie-break is only a tie-break — docs/142 Problem C is unchanged.
    localStorage.setItem("vibe-agent-id", "claude");
    localStorage.setItem("vibe-model-id", "gpt-5.6-sol");
    expect(newSessionAgentId(agents)).toBe("codex");
  });
});
