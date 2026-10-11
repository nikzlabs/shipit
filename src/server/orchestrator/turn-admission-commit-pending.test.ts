import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SessionRunner } from "./session-runner.js";
import type { SystemTurnDeps } from "./session-runner.js";
import type { AgentId } from "../shared/types.js";
import { GitManager } from "../shared/git.js";
import { POST_TURN_HOLD_MAX_MS } from "./post-turn-hold.js";
import { testDispatch } from "./integration_tests/dispatch-test-helpers.js";

interface FakeAgent extends EventEmitter {
  run: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
}

function makeFakeAgent(onRun?: () => void): FakeAgent {
  const agent = new EventEmitter() as FakeAgent;
  agent.run = vi.fn(() => onRun?.());
  agent.kill = vi.fn();
  agent.setPermissionMode = vi.fn();
  return agent;
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 0));
}

async function waitFor(fn: () => boolean, label = "condition", timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await flush();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function makeListenerDeps(): SystemTurnDeps["listenerDeps"] {
  return {
    sessionManager: {
      setAgentSessionId: vi.fn(),
      setLastTurnErrored: vi.fn(),
      get: vi.fn(),
      track: vi.fn(),
      touchUnlessResolved: vi.fn(),
      setMuted: vi.fn(),
      list: vi.fn().mockReturnValue([]),
    } as never,
    chatHistoryManager: {
      replaceInProgress: vi.fn(),
      finalizeInProgress: vi.fn(),
      append: vi.fn(),
      updateLastMessage: vi.fn().mockReturnValue(null),
      indexOfMessageId: vi.fn().mockReturnValue(-1),
    } as never,
    usageManager: { record: vi.fn(), getSessionUsage: vi.fn(), getSessionTokenTotals: vi.fn() } as never,
    sseBroadcast: vi.fn(),
    broadcastLog: vi.fn(),
    getSelectedModel: () => undefined,
  };
}

const RESULT = { type: "agent_result", status: "success", sessionId: "agent-sid" };
const STREAMING = { steerInputs: () => ({ liveSteering: true, steeringCapable: true }) };

// Invariant 1 for a turn that arrives from OUTSIDE the queue: a wake, a delivery, a report.
describe("turn admission while the finished turn's commit is pending", () => {
  let repoDir: string;
  let filePath: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "commit-pending-"));
    filePath = path.join(repoDir, "file.txt");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    fs.writeFileSync(filePath, "base\n");
    git("add", "-A");
    git("commit", "-qm", "initial");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  const commitCount = (): number =>
    execFileSync("git", ["log", "--oneline"], { cwd: repoDir, encoding: "utf8" }).split("\n").filter(Boolean).length;

  /** Turn 1 edits the file; every later turn begins by discarding the working tree. */
  function setup(extra: Partial<SystemTurnDeps> = {}) {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const commit = { started: 0, landed: 0, land: (): void => {} };
    const held = new Promise<void>((resolve) => { commit.land = resolve; });
    const postTurnPrFlow = vi.fn(async () => {});
    runner.setSystemTurnDeps({
      agentFactory: () => {
        const first = agents.length === 0;
        const a = makeFakeAgent(() => {
          if (first) fs.writeFileSync(filePath, "turn-1 work\n");
          else execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: repoDir, stdio: "pipe" });
        });
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      // Only the first turn's commit is held open.
      autoCommit: async (sessionDir: string, summary: string) => {
        commit.started += 1;
        if (commit.started === 1) await held;
        const git = new GitManager(sessionDir);
        const parentHash = await git.getHeadHash();
        const r = await git.autoCommit(summary);
        commit.landed += 1;
        return { ...r, parentHash };
      },
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow,
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
      ...extra,
    });
    const started = (n: number): boolean => agents.length === n && agents[n - 1]!.run.mock.calls.length === 1;
    const finish = async (): Promise<void> => {
      for (const a of agents) {
        a.emit("event", RESULT);
        a.emit("done", 0);
      }
      await waitFor(() => !runner.running && !runner.postTurnWorkInFlight, "turns finished");
      runner.dispose({ force: true });
    };
    return { runner, agents, commit, postTurnPrFlow, started, finish };
  }

  const wake = () => testDispatch({ text: "reset the tree", systemTurn: true, automatic: true });

  it("queues a dispatch that arrives during a streaming turn's commit, and starts it after the commit", async () => {
    const { runner, agents, commit, started, finish } = setup(STREAMING);
    runner.dispatch(testDispatch({ text: "make an edit" }));
    await waitFor(() => started(1), "turn 1 started");
    expect(runner.queueLength).toBe(0);

    agents[0]!.emit("event", RESULT);
    await waitFor(() => commit.started === 1, "commit started");
    expect([runner.running, runner.turnCommitPending]).toEqual([false, true]);

    const handle = runner.dispatch(wake());
    await flush();
    await flush();
    expect(handle.admitted).toBe("queued");
    expect(agents).toHaveLength(1);
    expect(runner.queueLength).toBe(1);

    commit.land();
    await waitFor(() => started(2), "the dispatched turn started");
    expect(fs.readFileSync(filePath, "utf8")).toBe("turn-1 work\n");
    expect(commitCount()).toBe(2);
    await finish();
  });

  // A one-shot turn commits in `done`, so the interval opens at the result, before any commit runs.
  it("queues a dispatch that arrives between a one-shot turn's result and its exit", async () => {
    const { runner, agents, commit, started, finish } = setup();
    runner.dispatch(testDispatch({ text: "make an edit" }));
    await waitFor(() => started(1), "turn 1 started");

    agents[0]!.emit("event", RESULT);
    await flush();
    expect([runner.running, runner.turnCommitPending, commit.started]).toEqual([false, true, 0]);

    const handle = runner.dispatch(wake());
    expect(handle.admitted).toBe("queued");

    agents[0]!.emit("done", 0);
    await waitFor(() => commit.started === 1, "commit started");
    await flush();
    expect(agents).toHaveLength(1);

    commit.land();
    await waitFor(() => started(2), "the dispatched turn started");
    expect(fs.readFileSync(filePath, "utf8")).toBe("turn-1 work\n");
    expect(commitCount()).toBe(2);
    await finish();
  });

  it("queues a dispatch that arrives while a turn that ended on an adapter error commits", async () => {
    const { runner, agents, commit, started, finish } = setup();
    runner.dispatch(testDispatch({ text: "make an edit" }));
    await waitFor(() => started(1), "turn 1 started");

    agents[0]!.emit("error", new Error("the CLI fell over"));
    await waitFor(() => commit.started === 1, "commit started");
    expect([runner.running, runner.turnCommitPending]).toEqual([false, true]);

    const handle = runner.dispatch(wake());
    await flush();
    await flush();
    expect(handle.admitted).toBe("queued");
    expect(agents).toHaveLength(1);

    commit.land();
    await waitFor(() => started(2), "the dispatched turn started");
    expect(fs.readFileSync(filePath, "utf8")).toBe("turn-1 work\n");
    expect(commitCount()).toBe(2);
    await finish();
  });

  // A dispatched crash reaches its commit through the no-result hook, which ends the turn on
  // the error path while the `done` handler that called it is still unwinding.
  it("queues a dispatch that arrives while a turn that died with partial work commits", async () => {
    const { runner, agents, commit, started, finish } = setup();
    runner.dispatch(testDispatch({ text: "make an edit" }));
    await waitFor(() => started(1), "turn 1 started");

    agents[0]!.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "editing file.txt" }] });
    agents[0]!.emit("done", 137);
    await waitFor(() => commit.started === 1, "commit started");
    expect([runner.running, runner.turnCommitPending, runner.postTurnWorkInFlight]).toEqual([false, true, true]);

    const handle = runner.dispatch(wake());
    await flush();
    await flush();
    expect(handle.admitted).toBe("queued");
    expect(agents).toHaveLength(1);

    commit.land();
    await waitFor(() => started(2), "the dispatched turn started");
    expect(fs.readFileSync(filePath, "utf8")).toBe("turn-1 work\n");
    expect(commitCount()).toBe(2);
    await finish();
  });

  it("commits once and starts one successor when two dispatches arrive during the commit", async () => {
    const { runner, agents, commit, postTurnPrFlow, started, finish } = setup(STREAMING);
    runner.dispatch(testDispatch({ text: "make an edit" }));
    await waitFor(() => started(1), "turn 1 started");
    agents[0]!.emit("event", RESULT);
    await waitFor(() => commit.started === 1, "commit started");

    runner.dispatch(testDispatch({ text: "first wake", systemTurn: true, automatic: true }));
    runner.dispatch(testDispatch({ text: "second wake", systemTurn: true, automatic: true }));
    expect(runner.messageQueue.map((m) => m.text)).toEqual(["first wake", "second wake"]);

    commit.land();
    await waitFor(() => started(2), "a successor started");
    await flush();
    await flush();
    expect(agents).toHaveLength(2);
    expect(runner.messageQueue.map((m) => m.text)).toEqual(["second wake"]);
    await waitFor(() => postTurnPrFlow.mock.calls.length === 1, "turn 1's PR flow ran");
    expect(commit.started).toBe(1);

    agents[1]!.emit("event", RESULT);
    agents[1]!.emit("done", 0);
    await waitFor(() => started(3), "the second entry follows in order");
    await finish();
  });

  it("refuses a refusing caller, and names the commit as the reason", async () => {
    const { runner, finish } = setup();
    runner.beginTurnCommit();
    const outcomes: unknown[] = [];
    const handle = runner.dispatch(
      testDispatch({ text: "its own turn or nothing", onTurnComplete: (o) => outcomes.push(o) }),
      { whenBusy: "refuse" },
    );
    expect(handle.admitted).toBe("refused");
    expect(outcomes).toEqual([expect.objectContaining({ status: "refused", detail: expect.stringContaining("not committed") })]);
    expect([runner.running, runner.queueLength]).toEqual([false, 0]);
    runner.endTurnCommit();
    await finish();
  });

  // The rebase driver's resolution turn (`postTurn: "none"`) runs inside the driver's own hold
  // and never commits, so the hold its previous step still has open must not refuse the next.
  it("admits a driver-owned turn while a commit hold is open", async () => {
    const { runner, started, finish } = setup();
    runner.beginTurnCommit();
    const handle = runner.dispatch(
      testDispatch({ text: "resolve the conflicts", systemTurn: true, postTurn: "none" }),
      { whenBusy: "refuse" },
    );
    expect(handle.admitted).toBe("started");
    await waitFor(() => started(1), "the resolution turn started");
    runner.endTurnCommit();
    await finish();
  });

  // The hold is deadline-bounded and expires without an event. Setup only needs microtasks, so
  // these two run on fake timers and step with `setImmediate`.
  describe("when the commit hold expires unreleased", () => {
    const step = async (until: () => boolean): Promise<void> => {
      const deadline = performance.now() + 5000;
      while (!until() && performance.now() < deadline) await new Promise((r) => setImmediate(r));
    };

    it("starts a dispatch queued behind a one-shot turn whose exit never arrives", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const { runner, agents, started } = setup();
      runner.dispatch(testDispatch({ text: "make an edit" }));
      await step(() => started(1));
      agents[0]!.emit("event", RESULT);
      await step(() => !runner.running);
      expect(runner.turnCommitPending).toBe(true);

      expect(runner.dispatch(wake()).admitted).toBe("queued");
      await vi.advanceTimersByTimeAsync(POST_TURN_HOLD_MAX_MS - 1000);
      expect(agents).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(5000);
      await step(() => started(2));
      expect(started(2)).toBe(true);
      expect(runner.queueLength).toBe(0);
      runner.dispose({ force: true });
    });

    // The deadline belongs to the runner, not to one hold: a second hold moves it, and that
    // hold's own timer goes when it is released.
    it("comes back for the entry when another hold extended the deadline and was released", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const { runner, agents, started } = setup();
      runner.dispatch(testDispatch({ text: "make an edit" }));
      await step(() => started(1));
      agents[0]!.emit("event", RESULT);
      await step(() => !runner.running);
      expect(runner.dispatch(wake()).admitted).toBe("queued");

      await vi.advanceTimersByTimeAsync(POST_TURN_HOLD_MAX_MS / 2);
      runner.beginTurnCommit();
      runner.endTurnCommit();
      await vi.advanceTimersByTimeAsync(POST_TURN_HOLD_MAX_MS / 2 + 5000);
      expect([agents.length, runner.turnCommitPending]).toEqual([1, true]);

      await vi.advanceTimersByTimeAsync(POST_TURN_HOLD_MAX_MS + 5000);
      await step(() => started(2));
      expect(started(2)).toBe(true);
      runner.dispose({ force: true });
    });

    // The drain of the finished turn is still parked on the commit, and it starts a successor
    // when the commit settles. The turn the expiry started is still in setup then, so the turn
    // epoch has not moved and only the hand-over tells the drain to stand down.
    it("starts one successor when the commit of a draining turn settles after the expiry", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      let resets = 0;
      let finishSetup = (): void => {};
      const inSetup = new Promise<void>((resolve) => { finishSetup = resolve; });
      const { runner, agents, commit, started } = setup({
        preTurnReset: async () => {
          resets += 1;
          if (resets > 1) await inSetup;
          return { agentPrefix: "" };
        },
      });
      runner.dispatch(testDispatch({ text: "make an edit" }));
      await step(() => started(1));
      runner.dispatch(testDispatch({ text: "queued by the user" }));
      agents[0]!.emit("event", RESULT);
      await step(() => commit.started === 1);
      runner.dispatch(testDispatch({ text: "wake", systemTurn: true, automatic: true }));
      expect(runner.messageQueue.map((m) => m.text)).toEqual(["queued by the user", "wake"]);

      await vi.advanceTimersByTimeAsync(POST_TURN_HOLD_MAX_MS + 5000);
      await step(() => resets === 2);
      expect([resets, runner.running]).toEqual([2, true]);

      // The real commit needs real timers.
      vi.useRealTimers();
      commit.land();
      await step(() => commit.landed === 1);
      for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
      expect([commit.landed, resets]).toEqual([1, 2]);
      expect(runner.messageQueue.map((m) => m.text)).toEqual(["wake"]);

      finishSetup();
      await step(() => started(2));
      expect(agents).toHaveLength(2);
      runner.dispose({ force: true });
    });
  });
});
