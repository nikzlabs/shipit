/**
 * A turn whose agent process DIES must still auto-commit.
 *
 * `turn-executor.ts` ran the post-turn commit/PR flow from exactly two places:
 * the streaming `agent_result` handler and the non-streaming `done` handler.
 * Neither fires when a streaming process exits abnormally (crash, OOM kill,
 * SIGTERM from a container restart) — that path ended at
 *
 *     runner.running = false; await tryDrain(); emitFinishedIfIdle(); finishTurn();
 *
 * and `tryDrain` commits ONLY when a turn is queued behind this one (the planning#264
 * guarantee). With an empty queue — the ordinary shape of "the agent died" —
 * nothing committed at all: everything the turn wrote sat uncommitted and
 * unpushed until some later turn happened to sweep it up with `git add -A`, and
 * was lost outright if the next turn began by discarding working-tree state.
 * Streaming is the default whenever live steering is on, so this was the common
 * case. The adapter-level `error` path (`onError`) had the same gap, and it is
 * the one a DISPATCHED crash lands on: `onNoResultExit` re-routes a partial-work
 * exit through `agent.emit("error")`.
 *
 * These tests drive the real executor in-process (no Docker) against a REAL git
 * repo in a temp dir, with fake agents standing in for the CLI. Reverting either
 * half of the fix makes the corresponding test read "base\n" — the work is gone.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SessionRunner } from "./session-runner.js";
import type { SystemTurnDeps } from "./session-runner.js";
import { executeAgentTurn } from "./turn-executor.js";
import type { AgentId } from "../shared/types.js";
import { GitManager } from "../shared/git.js";
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

function makeListenerDeps(sseBroadcast = vi.fn()): SystemTurnDeps["listenerDeps"] {
  return {
    sessionManager: {
      setAgentSessionId: vi.fn(),
      setLastTurnErrored: vi.fn(),
      get: vi.fn(),
      track: vi.fn(),
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
    sseBroadcast,
    broadcastLog: vi.fn(),
    getSelectedModel: () => undefined,
  };
}

/** The real commit, via `turn-executor`'s `autoCommit` fallback path. */
const realAutoCommit = async (sessionDir: string, summary: string) => {
  const git = new GitManager(sessionDir);
  const parentHash = await git.getHeadHash();
  const r = await git.autoCommit(summary);
  return { ...r, parentHash };
};

describe("post-turn commit when the agent process dies", () => {
  let repoDir: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "shi274-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(repoDir, "file.txt"), "base\n");
    git("add", "-A");
    git("commit", "-qm", "initial");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  /**
   * The WS shape: `executeAgentTurn` directly, streaming, no `onNoResultExit`
   * (that hook is dispatch-only), nothing queued. The process exits 143 without
   * ever emitting `agent_result` — an idle-kill / container restart mid-turn.
   */
  it("commits a streaming turn's edits when the process exits with no result and nothing is queued", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const filePath = path.join(repoDir, "file.txt");
    const scheduleAutoPush = vi.fn();
    const postTurnPrFlow = vi.fn(async () => {});

    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "work the agent did before dying\n"));
    const listenerDeps = makeListenerDeps();
    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: realAutoCommit,
      scheduleAutoPush,
      postTurnPrFlow,
      listenerDeps,
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "make an edit",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext: async () => {},
      emit: () => {},
      useStreaming: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn started");
    expect(listenerDeps.sessionManager.track).toHaveBeenCalledWith("s1");
    expect(runner.queueLength).toBe(0);

    // The process dies. No `agent_result` ever arrived, so nothing has run the
    // post-turn flow — this `done` is the turn's only remaining chance.
    agent.emit("done", 143);
    await waitFor(() => !runner.running, "turn settled");
    await waitFor(() => postTurnPrFlow.mock.calls.length === 1, "post-turn flow ran");

    const log = execFileSync("git", ["log", "--oneline"], { cwd: repoDir, encoding: "utf8" });
    expect(log.split("\n").filter(Boolean)).toHaveLength(2);
    expect(
      execFileSync("git", ["show", "--stat", "--format=", "HEAD"], { cwd: repoDir, encoding: "utf8" }),
    ).toContain("file.txt");
    // The tree is clean: the dead turn's work is fully in git, not left staged
    // or unstaged for some later turn to sweep up (or throw away).
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" })).toBe("");
    expect(scheduleAutoPush).toHaveBeenCalled();

    runner.dispose({ force: true });
  });

  /**
   * The 2026-08-10 push-drop incident, at the turn-executor level: a crashed
   * turn's post-turn flow must hold the runner against lifecycle-driven
   * teardown for its whole duration.
   *
   * `running` is already false by the time the flow starts, so the runner's
   * existing running-guard says nothing here — and an idle-enforcer pass landing
   * mid-flow used to dispose the runner while its commit was still being
   * written, taking the debounced push and the PR card with it.
   */
  it("declines a non-forced dispose while the crashed turn's post-turn flow runs", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const filePath = path.join(repoDir, "file.txt");
    let disposedDuringFlow: boolean | null = null;
    // Stand in for the idle enforcer arriving mid-flow — same call it makes.
    const postTurnPrFlow = vi.fn(async () => {
      runner.dispose();
      disposedDuringFlow = runner.disposed;
    });

    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "work before dying\n"));
    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: realAutoCommit,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow,
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "make an edit",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext: async () => {},
      emit: () => {},
      useStreaming: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn started");

    agent.emit("done", 143);
    await waitFor(() => postTurnPrFlow.mock.calls.length === 1, "post-turn flow ran");

    expect(disposedDuringFlow).toBe(false);
    // ...and the hold is released, so the runner is reclaimable straight after.
    await waitFor(() => !runner.postTurnWorkInFlight, "post-turn hold released");
    runner.dispose();
    expect(runner.disposed).toBe(true);
  });

  /**
   * The same crash, but a queued turn drains behind it and starts by discarding
   * working-tree state. The planning#264 commit-before-drain covers this one; the
   * test pins that the crash-path change did not disturb it (and, via the
   * `autoCommit` call count, that the two paths share one commit rather than
   * staging twice).
   */
  it("does not commit twice when a queued turn drains behind the crashed turn", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const filePath = path.join(repoDir, "file.txt");
    const autoCommit = vi.fn(realAutoCommit);
    const onRunByTurn = [
      () => fs.writeFileSync(filePath, "turn-1 work\n"),
      () => execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: repoDir, stdio: "pipe" }),
    ];

    const deps: SystemTurnDeps = {
      agentFactory: () => {
        const idx = agents.length;
        const a = makeFakeAgent(() => onRunByTurn[idx]?.());
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      autoCommit,
      scheduleAutoPush: vi.fn(),
      steerInputs: () => ({ liveSteering: true, steeringCapable: true }),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "make an edit" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "turn 1 started");
    runner.dispatch(testDispatch({ text: "reset the tree", systemTurn: true }));
    expect(runner.queueLength).toBe(1);

    // Turn 1 streamed visible work, so the dispatch no-result hook treats this
    // as a partial-work exit and surfaces it rather than retrying the prompt.
    agents[0]!.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "editing file.txt" }] });
    agents[0]!.emit("done", 137);

    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "turn 2 started");
    expect(fs.readFileSync(filePath, "utf8")).toBe("turn-1 work\n");
    expect(autoCommit).toHaveBeenCalledTimes(1);

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn 2 finished");
    runner.dispose({ force: true });
  });

  /**
   * The dispatched crash lands on the agent `error` path, not on the streaming
   * `done` branch: `onNoResultExit` sees partial work and re-routes it through
   * `agent.emit("error")`. That path committed nothing either.
   */
  it("commits when a dispatched turn dies and surfaces via the agent error path", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const filePath = path.join(repoDir, "file.txt");
    const postTurnPrFlow = vi.fn(async () => {});

    const deps: SystemTurnDeps = {
      agentFactory: () => {
        const a = makeFakeAgent(() => fs.writeFileSync(filePath, "dispatched work\n"));
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      autoCommit: realAutoCommit,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow,
      steerInputs: () => ({ liveSteering: true, steeringCapable: true }),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "make an edit" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "turn started");
    expect(runner.queueLength).toBe(0);

    agents[0]!.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "editing file.txt" }] });
    agents[0]!.emit("done", 137);

    await waitFor(() => !runner.running, "turn settled");
    await waitFor(() => postTurnPrFlow.mock.calls.length === 1, "post-turn flow ran");

    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" })).toBe("");
    const log = execFileSync("git", ["log", "--oneline"], { cwd: repoDir, encoding: "utf8" });
    expect(log.split("\n").filter(Boolean)).toHaveLength(2);

    runner.dispose({ force: true });
  });

  /**
   * Prod incident 2026-08-09 (session 468191f5): a dispatched turn's process
   * was SIGTERMed mid-turn while `wasInterrupted` was true, so the dispatch
   * no-result hook stood down — and NOTHING finalized the streamed rows
   * (`onInterruptedTurn` is WS-only). They stayed `in_progress=1`, and the next
   * turn's `replaceInProgress()` deleted them: the user watched the turn's
   * messages vanish on reload. The executor now finalizes structurally when no
   * caller-supplied hook does.
   */
  it("finalizes a dispatched turn's streamed rows when the process dies and the no-result hook stands down", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const listenerDeps = makeListenerDeps();
    const chm = listenerDeps.chatHistoryManager as unknown as {
      replaceInProgress: ReturnType<typeof vi.fn>;
      finalizeInProgress: ReturnType<typeof vi.fn>;
    };

    const deps: SystemTurnDeps = {
      agentFactory: () => {
        const a = makeFakeAgent();
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      autoCommit: realAutoCommit,
      scheduleAutoPush: vi.fn(),
      steerInputs: () => ({ liveSteering: true, steeringCapable: true }),
      listenerDeps,
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "long-running work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "turn started");

    // The turn streams visible work…
    agents[0]!.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "streamed partial work" }] });
    // …an interrupt lands but the process outlives it (`wasInterrupted` stays
    // set)…
    runner.wasInterrupted = true;
    // …and the process then dies without an `agent_result`.
    agents[0]!.emit("done", 143);

    await waitFor(() => !runner.running, "turn settled");
    await waitFor(() => chm.finalizeInProgress.mock.calls.length > 0, "streamed rows finalized");

    // The finalized history carries the streamed partial work — rebuilt from
    // the accumulator, not wiped.
    const lastReplace = chm.replaceInProgress.mock.calls.at(-1) as [string, unknown[]];
    expect(lastReplace[0]).toBe("s1");
    expect(JSON.stringify(lastReplace[1])).toContain("streamed partial work");

    runner.dispose({ force: true });
  });

  /**
   * The fallback must stand down after the ERROR path already finalized the
   * turn: an adapter can emit `error` and then `done`, the error listener
   * finalizes the rows but leaves the accumulator populated, and a second
   * `replaceInProgress` from the fallback would append a duplicate copy of the
   * turn (the finalized rows are no longer `in_progress`, so nothing is
   * replaced — only added).
   */
  it("does not re-finalize (duplicate) a turn the error path already finalized when done follows error", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const listenerDeps = makeListenerDeps();
    const chm = listenerDeps.chatHistoryManager as unknown as {
      replaceInProgress: ReturnType<typeof vi.fn>;
    };

    const deps: SystemTurnDeps = {
      agentFactory: () => {
        const a = makeFakeAgent();
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      autoCommit: realAutoCommit,
      scheduleAutoPush: vi.fn(),
      steerInputs: () => ({ liveSteering: true, steeringCapable: true }),
      listenerDeps,
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "long-running work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "turn started");

    agents[0]!.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "streamed partial work" }] });
    agents[0]!.emit("error", new Error("adapter blew up"));
    await waitFor(() => chm.replaceInProgress.mock.calls.length > 0, "error path finalized the turn");
    const callsAfterError = chm.replaceInProgress.mock.calls.length;

    // The process exit trails the error; `wasInterrupted` keeps the dispatch
    // no-result hook out of the way so the fallback's own guard is what's
    // under test.
    runner.wasInterrupted = true;
    agents[0]!.emit("done", 1);
    await waitFor(() => !runner.running, "turn settled");
    await flush();
    await flush();

    expect(chm.replaceInProgress.mock.calls.length).toBe(callsAfterError);

    runner.dispose({ force: true });
  });

  /**
   * The normal streaming turn end is unchanged: `agent_result` runs the whole
   * post-turn flow, and the resident process's later `done` must not re-run it
   * (a second `postTurnPrFlow` means a duplicate PR round-trip and card).
   */
  it("does not re-run the post-turn flow when a resident streaming process exits after a clean turn", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const autoCommit = vi.fn(async () => ({
      commitHash: "abc1234", parentHash: "def5678", conflictedFiles: [], rebaseInProgress: false, secretFindings: [],
    }));
    const postTurnPrFlow = vi.fn(async () => {});

    const deps: SystemTurnDeps = {
      agentFactory: () => {
        const a = makeFakeAgent();
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      autoCommit: autoCommit as never,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow,
      steerInputs: () => ({ liveSteering: true, steeringCapable: true }),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "only turn" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "turn started");

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => postTurnPrFlow.mock.calls.length === 1, "post-turn flow ran on agent_result");

    // The resident process exits later (idle kill / session teardown).
    agents[0]!.emit("done", 0);
    await flush();
    await flush();

    expect(autoCommit).toHaveBeenCalledTimes(1);
    expect(postTurnPrFlow).toHaveBeenCalledTimes(1);

    runner.dispose({ force: true });
  });

  /**
   * docs/128 / docs/211 — the executor's `autoCommit` fallback is the OTHER way
   * a turn reaches `git.autoCommit`: `postTurnCommit` (which carries the
   * auto-commit gate) is only used when `commitTurn` is wired, and this path
   * bypasses it entirely. Left ungated it would be the hole around the
   * invariant, and this crash path is exactly where it fires. Gated at the one
   * call site in `turn-executor.ts`, so both `SystemTurnDeps.autoCommit`
   * wirings inherit it.
   */
  for (const kind of ["ops", "sandbox"] as const) {
    it(`makes no fallback commit for a ${kind} session, even when the process dies`, async () => {
      const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
      const filePath = path.join(repoDir, "file.txt");
      const autoCommit = vi.fn(realAutoCommit);
      const scheduleAutoPush = vi.fn();
      const listenerDeps = makeListenerDeps();
      (listenerDeps.sessionManager as unknown as { get: ReturnType<typeof vi.fn> }).get =
        vi.fn(() => ({ id: "s1", kind }));

      const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "ops scratch the agent wrote\n"));
      const deps: SystemTurnDeps = {
        agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
        autoCommit,
        scheduleAutoPush,
        postTurnPrFlow: vi.fn(async () => {}),
        listenerDeps,
        buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
      };

      await executeAgentTurn(runner, deps, agent as never, {
        agentId: "claude" as AgentId,
        sessionId: "s1",
        prompt: "p",
        userText: "look at something",
        emitUserEcho: false,
        persistUserMessage: vi.fn(),
        isNewSession: false,
        fallbackTitle: "t",
        turnStartHeadHash: null,
        drainNext: async () => {},
        emit: () => {},
        useStreaming: true,
        emitErrorOnNoResult: true,
      });
      await waitFor(() => agent.run.mock.calls.length === 1, "turn started");
      agent.emit("done", 143);
      await waitFor(() => !runner.running, "turn settled");
      await flush();
      await flush();

      // The gate short-circuits before the dep is even called…
      expect(autoCommit).not.toHaveBeenCalled();
      expect(scheduleAutoPush).not.toHaveBeenCalled();
      // …so history is untouched and the agent's edit is still in the tree,
      // where the agent (which owns git in these kinds) can commit it itself.
      expect(
        execFileSync("git", ["log", "--oneline"], { cwd: repoDir, encoding: "utf8" }).split("\n").filter(Boolean),
      ).toHaveLength(1);
      expect(
        execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" }),
      ).toContain("file.txt");

      runner.dispose({ force: true });
    });
  }
});
