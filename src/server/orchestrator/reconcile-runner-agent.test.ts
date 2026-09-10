import { describe, it, expect, vi, afterEach } from "vitest";
import { reconcileRunnerAgent } from "./reconcile-runner-agent.js";
import type { AgentId } from "../shared/types.js";

function fakeRunner(agentId: AgentId, running = false) {
  return { agentId, running };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reconcileRunnerAgent", () => {
  it("corrects a runner seeded with the global default to the session's agent", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const runner = fakeRunner("claude");

    expect(reconcileRunnerAgent(runner, "codex")).toBe("codex");
    expect(runner.agentId).toBe("codex");
  });

  it("returns the runner's agent unchanged when the session has none", () => {
    const runner = fakeRunner("codex");

    expect(reconcileRunnerAgent(runner, null)).toBe("codex");
    expect(runner.agentId).toBe("codex");
    expect(reconcileRunnerAgent(runner, undefined)).toBe("codex");
    expect(runner.agentId).toBe("codex");
  });

  it("does not disturb a running turn, and reports the id that turn is using", () => {
    const runner = fakeRunner("claude", true);

    expect(reconcileRunnerAgent(runner, "codex")).toBe("claude");
    expect(runner.agentId).toBe("claude");
  });

  it("is a no-op when the runner already matches", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const runner = fakeRunner("codex");

    expect(reconcileRunnerAgent(runner, "codex")).toBe("codex");
    expect(runner.agentId).toBe("codex");
    expect(logSpy).not.toHaveBeenCalled();
  });
});
