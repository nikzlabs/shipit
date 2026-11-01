import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionInfo } from "../shared/types.js";
import type { SessionRunnerInterface } from "./session-runner.js";

const prepare = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("./session-agent-env.js", () => ({ prepareSessionAgentEnvironment: prepare }));

const { wakeSessionWithTurn } = await import("./wake-session.js");
type WakeSessionDeps = Parameters<typeof wakeSessionWithTurn>[0];

const SESSION = { id: "s1", workspaceDir: "/tmp/s1" } as SessionInfo;

function setup(resident: { alive: boolean; streaming: boolean }) {
  const runner = {
    agentId: "claude",
    running: false,
    disposed: false,
    isStreamingActive: resident.streaming,
    getAgent: () => (resident.alive ? {} : null),
    dispatch: vi.fn(() => ({ admitted: "started", settled: new Promise(() => {}) })),
  } as unknown as SessionRunnerInterface;
  const deps = {
    sessionManager: {},
    runnerRegistry: { get: () => runner, getOrCreate: () => runner, dispose: vi.fn() },
    defaultAgentId: "claude",
    credentialsDir: "/tmp/creds",
    credentialStore: {},
  } as unknown as WakeSessionDeps;
  return deps;
}

// docs/329-user-steers-every-turn — a wake reuses the resident process, which can reread what a repair removes.
describe("wakeSessionWithTurn — the environment it prepares", () => {
  beforeEach(() => prepare.mockClear());

  it("says that a resident process is reused when one is alive", async () => {
    await wakeSessionWithTurn(setup({ alive: true, streaming: true }), SESSION, { text: "continue" });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]).toEqual([expect.anything(), expect.objectContaining({ reusingResidentAgent: true })]);
  });

  it("does not say so when no resident process is alive", async () => {
    await wakeSessionWithTurn(setup({ alive: false, streaming: false }), SESSION, { text: "continue" });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]).toEqual([expect.anything(), expect.not.objectContaining({ reusingResidentAgent: true })]);
  });
});
