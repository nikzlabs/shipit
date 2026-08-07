/**
 * SHI-247 — a SELF-WOKEN turn must auto-commit, push and run the PR flow.
 *
 * The Claude CLI starts a turn on its own when a `Bash(run_in_background)` job
 * finishes. For a resident streaming process that turn runs through the listener
 * closure the *previous* (orchestrator-initiated) turn left attached — and every
 * post-turn guard in `turn-executor.ts` is first-wins and scoped to one
 * `executeAgentTurn` call. So `tokenSyncFired` / `drainFired` /
 * `streamingPostTurnFired` were already set, the wake turn's `agent_result`
 * returned early, and its edits got no commit, no push and no PR card until some
 * later user turn happened to sweep them up with `git add -A`.
 *
 * Production hit this twice in one hour on the same host, both times via a
 * backgrounded `shipit agent run --agent codex` consult — which ShipIt's own
 * guidance tells agents to background, because the consult routinely outruns the
 * 10-minute foreground Bash cap. So the self-wake path is the ordinary shape of
 * cross-agent review, not a corner case.
 *
 * These tests drive the real executor in-process (no Docker) against a REAL git
 * repo in a temp dir, with fake agents standing in for the CLI. Same harness as
 * `turn-crash-commit.test.ts`.
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

interface FakeAgent extends EventEmitter {
  run: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
}

function makeFakeAgent(onRun?: () => void): FakeAgent {
  const agent = new EventEmitter() as FakeAgent;
  agent.run = vi.fn(() => onRun?.());
  agent.kill = vi.fn();
  agent.setPermissionMode = vi.fn();
  agent.sendUserMessage = vi.fn();
  return agent;
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * Emit the wake edge and let the executor's re-arm settle before the wake turn's
 * own events follow. On the wire the CLI's `task_notification` and the wake
 * turn's `init` / `result` are separate frames seconds apart (docs/235's trace);
 * in-process they would otherwise land in the same tick, ahead of the re-arm's
 * microtask.
 */
async function selfWake(agent: FakeAgent, taskId = "bg-1"): Promise<void> {
  agent.emit("event", { type: "agent_self_wake", taskId, status: "completed" });
  await flush();
  await flush();
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

describe("post-turn flow for a self-woken turn", () => {
  let repoDir: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  const gitOut = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
  const commitSubjects = (): string[] =>
    gitOut("log", "--format=%s").split("\n").filter(Boolean);

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "shi247-"));
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
   * Set up the production shape: one streaming WS turn that ends normally on
   * `agent_result` (running the whole post-turn flow), leaving its listeners
   * attached to the resident process. Returns the handles a wake test needs.
   */
  async function runFirstStreamingTurn(opts?: { onRun?: () => void }) {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(opts?.onRun);
    const scheduleAutoPush = vi.fn();
    const postTurnPrFlow = vi.fn(async () => {});
    const finalizeAgentEnv = vi.fn();
    const drainNext = vi.fn(async () => {});
    const autoCommit = vi.fn(realAutoCommit);
    // The runner's "idle" event is the LAST step of the post-turn sequence, so
    // counting it is the deterministic "this turn's flow has fully settled"
    // signal the wake edge has to be ordered against.
    let settledTurns = 0;
    runner.on("idle", () => { settledTurns += 1; });

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit,
      scheduleAutoPush,
      postTurnPrFlow,
      finalizeAgentEnv,
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "kick off a background job",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext,
      emit: () => {},
      useStreaming: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    return {
      runner, agent, scheduleAutoPush, postTurnPrFlow, finalizeAgentEnv, drainNext, autoCommit,
      settledTurns: () => settledTurns,
    };
  }

  /** The whole point: a self-woken turn's edits reach git on their own. */
  it("commits, pushes and runs the PR flow for a turn the agent started itself", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const h = await runFirstStreamingTurn({
      onRun: () => fs.writeFileSync(filePath, "turn-1 work\n"),
    });

    // Turn 1 ends normally. Its whole post-turn flow fires and trips every guard.
    h.agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Backgrounding the consult" }],
    });
    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.settledTurns() === 1, "turn 1 post-turn flow settled");
    expect(h.postTurnPrFlow).toHaveBeenCalledTimes(1);
    expect(commitSubjects()).toHaveLength(2);

    // The backgrounded job finishes and the CLI wakes itself. The resident
    // process is the same one, so the wake turn runs through turn 1's listeners.
    await selfWake(h.agent);
    expect(h.runner.running).toBe(true);

    // The wake turn edits the tree and ends.
    fs.writeFileSync(filePath, "self-woken work\n");
    h.agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Applied the consult's fix" }],
    });
    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });

    await waitFor(() => h.postTurnPrFlow.mock.calls.length === 2, "wake turn post-turn flow ran");

    // A second commit, holding the wake turn's work — with the wake turn's own
    // summary, not turn 1's.
    const subjects = commitSubjects();
    expect(subjects).toHaveLength(3);
    expect(subjects[0]).toBe("Applied the consult's fix");
    expect(gitOut("show", "HEAD:file.txt")).toBe("self-woken work\n");
    // Nothing left behind for a later turn to sweep up (or reset away).
    expect(gitOut("status", "--porcelain")).toBe("");
    expect(h.scheduleAutoPush).toHaveBeenCalledTimes(2);
    expect(h.finalizeAgentEnv).toHaveBeenCalledTimes(2);
    expect(h.runner.running).toBe(false);

    h.runner.dispose({ force: true });
  });

  /**
   * The wake turn's queue drain has to be re-armed too: a user message typed
   * while the self-woken turn is running is queued behind it (`send-message.ts`
   * branches on `runner.running`, which the wake edge sets), and with
   * `drainFired` still latched from turn 1 it would sit there forever.
   */
  it("drains a message queued during the self-woken turn", async () => {
    const h = await runFirstStreamingTurn();

    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.settledTurns() === 1, "turn 1 post-turn flow settled");
    expect(h.drainNext).toHaveBeenCalledTimes(1);

    await selfWake(h.agent);
    expect(h.runner.running).toBe(true);

    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.drainNext.mock.calls.length === 2, "wake turn drained");

    h.runner.dispose({ force: true });
  });

  /**
   * docs/237's trap, from the executor's side. `agent_self_wake` rides the CLI's
   * `task_notification`, which ALSO fires for a background job started earlier in
   * the CURRENT turn and reporting back mid-stream. Re-arming there would let the
   * running turn's `agent_result` run the post-turn flow a second time — a
   * duplicate commit attempt and a duplicate PR round-trip.
   */
  it("ignores a mid-turn task notification and runs the post-turn flow exactly once", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const h = await runFirstStreamingTurn({
      onRun: () => fs.writeFileSync(filePath, "mid-turn work\n"),
    });

    // The job reports back while the turn is still streaming — not a wake.
    await selfWake(h.agent);

    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.settledTurns() === 1, "post-turn flow settled");
    await flush();
    await flush();

    expect(h.postTurnPrFlow).toHaveBeenCalledTimes(1);
    expect(h.autoCommit).toHaveBeenCalledTimes(1);
    expect(h.drainNext).toHaveBeenCalledTimes(1);
    expect(commitSubjects()).toHaveLength(2);

    h.runner.dispose({ force: true });
  });

  /**
   * The wake can land in the window between `streamingPostTurnFired = true` and
   * the finished turn's `runCommitAndPr` — a job backgrounded just before the
   * turn ended, reporting back while the queue drain is still in flight, is an
   * ordinary shape. Clearing the memoized commit promises there naively would
   * let the finished turn's flow re-memoize them a moment later, and the wake
   * turn's `runCommitAndPr` would then get that already-settled flow back and
   * commit nothing — the same bug, one window narrower. The re-arm waits the
   * in-flight sequence out before clearing anything.
   */
  it("still commits the wake turn when the wake lands mid post-turn flow", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "turn-1 work\n"));

    // A slow drain holds turn 1's post-turn sequence open BEFORE it reaches
    // `runCommitAndPr`, which is the window that matters. (The runner's "idle"
    // event is no use as the settle signal here: the wake has already flipped
    // `running` back to true by the time the sequence reaches it, so it is
    // correctly suppressed.)
    let releaseDrain: () => void = () => {};
    let signalDrainEntered: () => void = () => {};
    const parked = new Promise<void>((r) => { releaseDrain = r; });
    const drainEntered = new Promise<void>((r) => { signalDrainEntered = r; });
    let drainCalls = 0;
    const drainNext = vi.fn(async () => {
      drainCalls += 1;
      if (drainCalls === 1) {
        signalDrainEntered();
        await parked;
      }
    });
    const postTurnPrFlow = vi.fn(async () => {});

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
      userText: "kick off a background job",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext,
      emit: () => {},
      useStreaming: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await drainEntered;

    // Wake arrives with turn 1's flow parked in the drain — before it has even
    // called `runCommitAndPr`, so nulling the memo now would be undone by the
    // resumed sequence.
    agent.emit("event", { type: "agent_self_wake", taskId: "bg-1" });
    await flush();
    expect(runner.running).toBe(true);
    releaseDrain();
    // Turn 1's sequence finishes (committing its own work); only then does the
    // re-arm clear the guards.
    await waitFor(() => postTurnPrFlow.mock.calls.length === 1, "turn 1 committed");
    await flush();
    await flush();

    fs.writeFileSync(filePath, "self-woken work\n");
    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Wake turn edit" }],
    });
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });

    await waitFor(() => postTurnPrFlow.mock.calls.length === 2, "wake turn post-turn flow ran");
    expect(commitSubjects()).toHaveLength(3);
    expect(gitOut("show", "HEAD:file.txt")).toBe("self-woken work\n");

    runner.dispose({ force: true });
  });

  /**
   * Non-streaming turns cannot be woken — the CLI is a one-shot PTY that reaps
   * its background tasks at turn end (docs/235 probe A). Re-arming there would
   * be actively wrong: that path drains at `agent_result` and commits later in
   * `done`, so clearing `drainFired` between the two would drain the queue twice.
   */
  it("does not re-arm a non-streaming turn", async () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent();
    const drainNext = vi.fn(async () => {});
    const autoCommit = vi.fn(realAutoCommit);

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit,
      scheduleAutoPush: vi.fn(),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "one-shot",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext,
      emit: () => {},
      useStreaming: false,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn started");

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => drainNext.mock.calls.length === 1, "drained at agent_result");

    // A stray notification between `agent_result` and `done` must not re-arm.
    await selfWake(agent);
    agent.emit("done", 0);
    await flush();
    await flush();

    expect(drainNext).toHaveBeenCalledTimes(1);
    expect(autoCommit).toHaveBeenCalledTimes(1);

    runner.dispose({ force: true });
  });
});
