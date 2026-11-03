import { describe, it, expect } from "vitest";
import { agentIdForModel } from "./agent-for-model.js";
import type { AgentOption } from "../agent-types.js";

const AGENTS: AgentOption[] = [
  { id: "claude", name: "Claude Code", installed: true, hasRunnableModels: true, models: ["sonnet", "opus", "haiku"], supportsReview: true },
  { id: "codex", name: "Codex", installed: true, hasRunnableModels: true, models: ["gpt-5.5", "gpt-5.3-codex"], supportsReview: true },
];

describe("agentIdForModel", () => {
  it("derives the agent that owns the model", () => {
    expect(agentIdForModel("opus", AGENTS)).toBe("claude");
    expect(agentIdForModel("gpt-5.5", AGENTS)).toBe("codex");
    expect(agentIdForModel("gpt-5.3-codex", AGENTS)).toBe("codex");
  });

  it("prefers an installed harness over an uninstalled one listed first (docs/269 req 5)", () => {
    const shared: AgentOption[] = [
      { id: "opencode2", name: "OpenCode 2", installed: false, hasRunnableModels: false, models: ["kimi-k3"], supportsReview: true },
      { id: "opencode", name: "OpenCode", installed: true, hasRunnableModels: true, models: ["kimi-k3"], supportsReview: true },
    ];
    expect(agentIdForModel("kimi-k3", shared)).toBe("opencode");
    expect(agentIdForModel("kimi-k3", shared.map((a) => ({ ...a, installed: true })))).toBe("opencode2");
  });

  it("returns undefined for an unknown model so callers can fall back", () => {
    expect(agentIdForModel("gpt-9", AGENTS)).toBeUndefined();
  });

  it("returns undefined when the model is empty or the agent list is empty", () => {
    expect(agentIdForModel(undefined, AGENTS)).toBeUndefined();
    expect(agentIdForModel("", AGENTS)).toBeUndefined();
    expect(agentIdForModel("opus", [])).toBeUndefined();
  });
});
