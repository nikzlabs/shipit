import { describe, it, expect } from "vitest";
import { agentIdForModel } from "./agent-for-model.js";
import type { AgentOption } from "../agent-types.js";

const AGENTS: AgentOption[] = [
  { id: "claude", name: "Claude Code", installed: true, authConfigured: true, models: ["sonnet", "opus", "haiku"], supportsReview: true },
  { id: "codex", name: "Codex", installed: true, authConfigured: true, models: ["gpt-5.5", "gpt-5.3-codex"], supportsReview: true },
];

describe("agentIdForModel", () => {
  it("derives the agent that owns the model", () => {
    expect(agentIdForModel("opus", AGENTS)).toBe("claude");
    expect(agentIdForModel("gpt-5.5", AGENTS)).toBe("codex");
    expect(agentIdForModel("gpt-5.3-codex", AGENTS)).toBe("codex");
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
