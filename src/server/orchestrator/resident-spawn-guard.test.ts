import { describe, it, expect, afterEach, vi } from "vitest";
import {
  releaseResidentOnSpawnChange,
  releaseResidentOnStatusCardChange,
  releaseResidentsOnStatusCardToggle,
} from "./resident-spawn-guard.js";
import {
  forgetStatusCardSpawn,
  recordStatusCardSpawn,
} from "./session-status-spawn-record.js";
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
    running: false,
    backgroundWorkDescriptions: [] as string[],
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

describe("releaseResidentOnStatusCardChange (docs/303 req 21)", () => {
  const note = (value: boolean): void => { recordStatusCardSpawn("s1", value); };
  afterEach(() => { forgetStatusCardSpawn("s1"); });

  it("ends a resident spawned with the other tool list, so the next turn spawns fresh", () => {
    const order: string[] = [];
    const runner = makeRunner({ appliedSpawnIdentity: "claude-opus-5", order });
    note(false);

    expect(releaseResidentOnStatusCardChange(asRunner(runner), true)).toBe(true);

    expect(order).toEqual(["emit:superseded", "removeAllListeners", "kill"]);
    expect(runner.getAgent()).toBeNull();
    expect(runner.isStreamingActive).toBe(false);
    expect(runner.appliedSpawnIdentity).toBeUndefined();
    expect(runner.clearBackgroundTasks).toHaveBeenCalledOnce();
  });

  it("reuses a resident spawned with the same value", () => {
    const runner = makeRunner({ appliedSpawnIdentity: "claude-opus-5" });
    const agent = runner.agent!;
    note(true);

    expect(releaseResidentOnStatusCardChange(asRunner(runner), true)).toBe(false);
    expect(agent.kill).not.toHaveBeenCalled();
    expect(runner.getAgent()).toBe(agent);
  });

  it("forgets the record when it releases, so a failed spawn does not retire the next process", () => {
    const runner = makeRunner({ appliedSpawnIdentity: "claude-opus-5" });
    note(false);
    expect(releaseResidentOnStatusCardChange(asRunner(runner), true)).toBe(true);

    runner.setAgent(makeAgent());
    expect(releaseResidentOnStatusCardChange(asRunner(runner), true)).toBe(false);
  });

  it("leaves an unrecorded session alone rather than respawning it every turn", () => {
    const runner = makeRunner({ appliedSpawnIdentity: "claude-opus-5" });
    const agent = runner.agent!;

    expect(releaseResidentOnStatusCardChange(asRunner(runner), true)).toBe(false);
    expect(agent.kill).not.toHaveBeenCalled();
  });

  it("does nothing without a runner or a resident", () => {
    expect(releaseResidentOnStatusCardChange(null, true)).toBe(false);
    expect(releaseResidentOnStatusCardChange(asRunner(makeRunner({ agent: null })), true)).toBe(false);
  });
});

describe("releaseResidentsOnStatusCardToggle (docs/303 req 21)", () => {
  const registryOf = (runners: Record<string, ReturnType<typeof makeRunner>>) => ({
    listActive: () => Object.keys(runners),
    get: (id: string) => (runners[id] ? asRunner(runners[id]) : undefined),
  });

  it("retires every idle resident, so the next turn spawns with the other tool list", () => {
    const idle = makeRunner({ appliedSpawnIdentity: "claude-opus-5" });
    const agent = idle.agent!;

    expect(releaseResidentsOnStatusCardToggle(registryOf({ s1: idle }), true)).toBe(1);

    expect(agent.kill).toHaveBeenCalledOnce();
    expect(idle.getAgent()).toBeNull();
    expect(idle.isStreamingActive).toBe(false);
  });

  it("leaves a session mid-turn alone: killing it would lose the turn", () => {
    const busy = makeRunner({ appliedSpawnIdentity: "claude-opus-5" });
    busy.running = true;
    const agent = busy.agent!;

    expect(releaseResidentsOnStatusCardToggle(registryOf({ s1: busy }), false)).toBe(0);

    expect(agent.kill).not.toHaveBeenCalled();
    expect(busy.getAgent()).toBe(agent);
  });

  it("retires a resident with no recorded spawn value — an adopted one after a restart", () => {
    const adopted = makeRunner({ appliedSpawnIdentity: undefined });
    const agent = adopted.agent!;

    expect(releaseResidentsOnStatusCardToggle(registryOf({ s1: adopted }), true)).toBe(1);
    expect(agent.kill).toHaveBeenCalledOnce();
  });

  it("does nothing when a session has background work in flight", () => {
    const working = makeRunner({ appliedSpawnIdentity: "claude-opus-5" });
    working.backgroundWorkDescriptions = ["a review"];

    expect(releaseResidentsOnStatusCardToggle(registryOf({ s1: working }), true)).toBe(0);
    expect(working.getAgent()).not.toBeNull();
  });
});
