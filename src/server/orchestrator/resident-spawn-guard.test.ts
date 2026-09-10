import { describe, it, expect, vi } from "vitest";
import { releaseResidentOnSpawnChange } from "./resident-spawn-guard.js";
import type { SessionRunnerInterface } from "./session-runner.js";

function makeAgent(order: string[] = []) {
  return {
    emit: vi.fn((event: string) => { order.push(`emit:${event}`); }),
    kill: vi.fn(() => { order.push("kill"); }),
    removeAllListeners: vi.fn(() => { order.push("removeAllListeners"); }),
  };
}

function makeRunner(opts: {
  appliedSpawnIdentity?: string;
  agent?: ReturnType<typeof makeAgent> | null;
  order?: string[];
}) {
  const state = {
    sessionId: "s1",
    appliedSpawnIdentity: opts.appliedSpawnIdentity,
    isStreamingActive: true,
    agent: opts.agent === undefined ? makeAgent(opts.order) : opts.agent,
    clearBackgroundTasks: vi.fn(),
    getAgent() { return state.agent; },
    setAgent(a: unknown) { state.agent = a as typeof state.agent; },
  };
  return state;
}

const asRunner = (r: ReturnType<typeof makeRunner>): SessionRunnerInterface =>
  r as unknown as SessionRunnerInterface;

describe("releaseResidentOnSpawnChange", () => {
  it("kills the resident process when the selected model no longer matches the spawn-time one", () => {
    const order: string[] = [];
    const runner = makeRunner({ appliedSpawnIdentity: "claude-fable-5", order });
    const agent = runner.agent!;

    expect(releaseResidentOnSpawnChange(asRunner(runner), "claude-opus-5")).toBe(true);

    expect(agent.kill).toHaveBeenCalledOnce();
    expect(agent.removeAllListeners).toHaveBeenCalledOnce();
    expect(order).toEqual(["emit:superseded", "removeAllListeners", "kill"]);
    expect(runner.getAgent()).toBeNull();
    expect(runner.isStreamingActive).toBe(false);
    expect(runner.appliedSpawnIdentity).toBeUndefined();
    expect(runner.clearBackgroundTasks).toHaveBeenCalledOnce();
  });

  it("leaves the resident process alone when the model is unchanged", () => {
    const runner = makeRunner({ appliedSpawnIdentity: "claude-opus-5" });
    const agent = runner.agent!;

    expect(releaseResidentOnSpawnChange(asRunner(runner), "claude-opus-5")).toBe(false);

    expect(agent.kill).not.toHaveBeenCalled();
    expect(runner.getAgent()).toBe(agent);
    expect(runner.isStreamingActive).toBe(true);
  });

  it("does not release on an unknown spawn-time model", () => {
    const runner = makeRunner({ appliedSpawnIdentity: undefined });
    const agent = runner.agent!;

    expect(releaseResidentOnSpawnChange(asRunner(runner), "claude-opus-5")).toBe(false);

    expect(agent.kill).not.toHaveBeenCalled();
    expect(runner.getAgent()).toBe(agent);
  });

  it("releases when the selection is cleared back to the agent default", () => {
    const runner = makeRunner({ appliedSpawnIdentity: "claude-fable-5" });
    expect(releaseResidentOnSpawnChange(asRunner(runner), undefined)).toBe(true);
    expect(runner.getAgent()).toBeNull();
  });

  it("is a no-op with no resident process or no runner", () => {
    const runner = makeRunner({ appliedSpawnIdentity: "claude-fable-5", agent: null });
    expect(releaseResidentOnSpawnChange(asRunner(runner), "claude-opus-5")).toBe(false);
    expect(releaseResidentOnSpawnChange(null, "claude-opus-5")).toBe(false);
    expect(releaseResidentOnSpawnChange(undefined, "claude-opus-5")).toBe(false);
  });

  it("survives an adapter that throws on teardown", () => {
    const runner = makeRunner({ appliedSpawnIdentity: "claude-fable-5" });
    const agent = runner.agent!;
    agent.removeAllListeners.mockImplementation(() => { throw new Error("gone"); });
    agent.kill.mockImplementation(() => { throw new Error("already dead"); });

    expect(releaseResidentOnSpawnChange(asRunner(runner), "claude-opus-5")).toBe(true);
    expect(runner.getAgent()).toBeNull();
    expect(runner.isStreamingActive).toBe(false);
  });
});
