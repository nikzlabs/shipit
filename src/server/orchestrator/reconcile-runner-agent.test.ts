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
    // The shape this exists for: container rescue / the warm pool seeded the
    // runner with `claude` because they had no session agent to hand, and the
    // session is actually a Codex one.
    const runner = fakeRunner("claude");

    expect(reconcileRunnerAgent(runner, "codex")).toBe("codex");
    expect(runner.agentId).toBe("codex");
  });

  it("returns the runner's agent unchanged when the session has none", () => {
    // A never-run session has no persisted agent yet; the seed is all there is,
    // and overwriting it with a nullish value would be worse than leaving it.
    const runner = fakeRunner("codex");

    expect(reconcileRunnerAgent(runner, null)).toBe("codex");
    expect(runner.agentId).toBe("codex");
    expect(reconcileRunnerAgent(runner, undefined)).toBe("codex");
    expect(runner.agentId).toBe("codex");
  });

  it("does not disturb a running turn, and reports the id that turn is using", () => {
    // The agent PROCESS is already spawned under the old id. Reassigning would
    // desynchronize the runner from its own process mid-turn, so the stale id
    // is deliberately returned — the caller must act on what is actually
    // running, not on what the session says.
    const runner = fakeRunner("claude", true);

    expect(reconcileRunnerAgent(runner, "codex")).toBe("claude");
    expect(runner.agentId).toBe("claude");
  });

  it("is a no-op when the runner already matches", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const runner = fakeRunner("codex");

    expect(reconcileRunnerAgent(runner, "codex")).toBe("codex");
    expect(runner.agentId).toBe("codex");
    // No reconciliation happened, so nothing should be logged — the log line is
    // meant to mark a real correction, not every turn.
    expect(logSpy).not.toHaveBeenCalled();
  });
});
