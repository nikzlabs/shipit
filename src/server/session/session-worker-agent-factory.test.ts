import { describe, it, expect } from "vitest";
import { createWorkerAgent } from "./session-worker.js";

/**
 * Regression guard: the container worker must build the agent the orchestrator
 * asked for. A hardcoded ClaudeAdapter here made every container-mode session
 * run Claude — so a Codex session (model gpt-5.5) spawned
 * `claude --model gpt-5.5` and the Claude CLI rejected the model.
 */
describe("createWorkerAgent", () => {
  it("builds a Codex adapter for agentId 'codex'", () => {
    const agent = createWorkerAgent("codex");
    expect(agent.agentId).toBe("codex");
  });

  it("builds a Claude adapter for agentId 'claude'", () => {
    const agent = createWorkerAgent("claude");
    expect(agent.agentId).toBe("claude");
  });
});
