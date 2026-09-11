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
    // A shared model must not override the user's saved harness.
    const shared = [agent("claude", ["deepseek-v4-flash"]), agent("codex", ["deepseek-v4-flash"])];
    localStorage.setItem("vibe-model-id", "deepseek-v4-flash");
    localStorage.setItem("vibe-agent-id", "codex");
    expect(newSessionAgentId(shared)).toBe("codex");
    localStorage.setItem("vibe-agent-id", "claude");
    expect(newSessionAgentId(shared)).toBe("claude");
  });

  it("does not let an uninstalled or credential-less harness win the tie", () => {
    const shared = (codex: Partial<AgentOption>) => [
      agent("claude", ["deepseek-v4-flash"]),
      { ...agent("codex", ["deepseek-v4-flash"]), ...codex },
    ];
    localStorage.setItem("vibe-model-id", "deepseek-v4-flash");
    localStorage.setItem("vibe-agent-id", "codex");
    expect(newSessionAgentId(shared({ installed: false }))).toBe("claude");
    expect(newSessionAgentId(shared({ hasRunnableModels: false }))).toBe("claude");

    expect(newSessionAgentId(shared({}))).toBe("codex");
  });

  it("still lets the model override a saved harness that cannot run it", () => {
    localStorage.setItem("vibe-agent-id", "claude");
    localStorage.setItem("vibe-model-id", "gpt-5.6-sol");
    expect(newSessionAgentId(agents)).toBe("codex");
  });
});
