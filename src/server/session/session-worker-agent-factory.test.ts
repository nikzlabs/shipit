import { describe, it, expect } from "vitest";
import { createWorkerAgent } from "./session-worker.js";

describe("createWorkerAgent", () => {
  it("builds a Codex adapter for agentId 'codex'", () => {
    const agent = createWorkerAgent("codex");
    expect(agent.agentId).toBe("codex");
  });

  it("builds a Claude adapter for agentId 'claude'", () => {
    const agent = createWorkerAgent("claude");
    expect(agent.agentId).toBe("claude");
  });

  it("builds an OpenCode adapter for agentId 'opencode'", () => {
    const agent = createWorkerAgent("opencode");
    expect(agent.agentId).toBe("opencode");
  });

  it("builds an OpenCode 2 adapter for agentId 'opencode2', not the v1 one", () => {
    const agent = createWorkerAgent("opencode2");
    expect(agent.agentId).toBe("opencode2");
  });
});
