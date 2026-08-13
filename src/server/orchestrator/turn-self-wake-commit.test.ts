/**
 * planning#249 — a SELF-WOKEN turn must auto-commit, push and run the PR flow.
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
      adoptsCliStartedTurns: true,
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
      adoptsCliStartedTurns: true,
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
   * docs/140 — the OTHER way the CLI starts a turn nobody asked for, and the one
   * production hit on 2026-08-13: a live steer that arrives as the turn is
   * wrapping up. The CLI acks it (`--replay-user-messages`), so it is correctly
   * NOT re-queued — but it had no decision point left to apply it at, so it runs
   * the message as its own turn once the current one ends. Nothing announces
   * that turn — there is no `task_notification`, and the CLI's `init` is not
   * proof of one — so the model producing top-level output is the adoption edge.
   * Before this the session read as idle for 5.5 minutes and the response's
   * edits reached git only because an unrelated self-wake happened to re-arm the
   * flow later.
   */
  it("commits a turn the CLI started on its own after acking a late live steer", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const h = await runFirstStreamingTurn({
      onRun: () => fs.writeFileSync(filePath, "turn-1 work\n"),
    });

    // The user steers while turn 1 is wrapping up, and the CLI echoes it back.
    h.runner.steeredMessages = [
      { afterGroupIndex: 1, text: "rename the folder too", assembledPrompt: "rename the folder too" },
    ];
    h.agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Both done." }],
    });
    h.agent.emit("event", { type: "agent_user_replay", text: "rename the folder too" });
    expect(h.runner.steeredMessages[0].delivered).toBe(true);

    // Turn 1 ends WITHOUT having applied the steer. Its own flow fires and trips
    // every guard; the acked steer is left alone (no re-queue).
    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.settledTurns() === 1, "turn 1 post-turn flow settled");
    expect(commitSubjects()).toHaveLength(2);
    expect(h.runner.running).toBe(false);
    expect(h.runner.queueLength).toBe(0);

    // The CLI now runs the acked steer as its own turn, with NO
    // `task_notification` anywhere. Its `init` alone changes nothing — see the
    // `set_permission_mode` test below for why that is deliberate.
    h.agent.emit("event", { type: "agent_init", agentId: "claude", sessionId: "agent-sid" });
    await flush();
    expect(h.runner.running).toBe(false);

    // The model talks: that is the turn, and the adoption edge.
    fs.writeFileSync(filePath, "steered work\n");
    h.agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Renamed the folder" }],
    });
    await flush();
    await flush();
    // The session reads as busy for the response…
    expect(h.runner.running).toBe(true);
    // …on a clean accumulator: turn 1's group is gone, so the adopted turn's
    // `agent_result` cannot re-persist it.
    expect(h.runner.chatMessageGroups.map((g) => g.text)).toEqual(["Renamed the folder"]);

    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });

    await waitFor(() => h.postTurnPrFlow.mock.calls.length === 2, "cli-started turn post-turn flow ran");
    const subjects = commitSubjects();
    expect(subjects).toHaveLength(3);
    expect(subjects[0]).toBe("Renamed the folder");
    expect(gitOut("show", "HEAD:file.txt")).toBe("steered work\n");
    expect(gitOut("status", "--porcelain")).toBe("");
    expect(h.scheduleAutoPush).toHaveBeenCalledTimes(2);
    expect(h.runner.running).toBe(false);

    h.runner.dispose({ force: true });
  });

  /**
   * Why the edge is the model TALKING and not the CLI's `init`, which looks like
   * the obvious announcement (docs/235's probe names it as one).
   * `StreamingClaudeProcess.setPermissionMode` pushes a `set_permission_mode`
   * control_request, and the CLI answers it with a fresh `init` — no turn, and
   * so no later `result` to clear `running` again. Steering pushes the mode
   * change and the message as two independent worker calls, so that init can
   * land after the finishing turn's `result`. Adopting it would wedge the
   * session as busy forever.
   */
  it("does not adopt a bare post-result init (the set_permission_mode control response)", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const h = await runFirstStreamingTurn({
      onRun: () => fs.writeFileSync(filePath, "turn-1 work\n"),
    });

    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.settledTurns() === 1, "turn 1 post-turn flow settled");
    expect(h.runner.running).toBe(false);

    // The control response's init arrives after the turn ended, and no turn follows.
    h.agent.emit("event", { type: "agent_init", agentId: "claude", sessionId: "agent-sid" });
    await flush();
    await flush();

    expect(h.runner.running).toBe(false);
    expect(h.postTurnPrFlow).toHaveBeenCalledTimes(1);

    h.runner.dispose({ force: true });
  });

  /**
   * docs/140 Phase 6.11 — the adoption is gated on a CAPABILITY
   * (`startsOwnTurns`), not on `useStreaming`, because on Codex the very shape
   * it keys on means the opposite. Codex steers (so it streams) but its
   * app-server is killed at `turn/completed`, and it routinely emits the turn's
   * FINAL assistant text AFTER that — including the synthetic
   * `isStreamCompletion` event that exists to fix the commit summary. Adopting
   * those would mark the session busy for a turn that will never produce
   * another `result`: a permanently busy session.
   */
  it("does not adopt a backend that cannot start its own turns (Codex's late final text)", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "turn-1 work\n"));
    const drainNext = vi.fn(async () => {});
    let settledTurns = 0;
    runner.on("idle", () => { settledTurns += 1; });

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: realAutoCommit,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow: vi.fn(async () => {}),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "codex" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "do the thing",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext,
      emit: () => {},
      // Codex: steering-capable (so streaming) but NOT resident across turns.
      useStreaming: true,
      adoptsCliStartedTurns: false,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "." }],
    });
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => settledTurns === 1, "turn 1 settled");

    // The turn's real final text arrives AFTER `turn/completed` — the documented
    // Codex ordering — as the stream-completion re-emit.
    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Renamed the folder" }],
      isStreamCompletion: true,
    });
    await flush();
    await flush();

    // Not a new turn: the session stays idle and nothing is re-armed.
    expect(runner.running).toBe(false);
    expect(settledTurns).toBe(1);
    expect(drainNext).toHaveBeenCalledTimes(1);
    expect(commitSubjects()).toHaveLength(2);

    runner.dispose({ force: true });
  });

  /**
   * The complement of the adoption edge: assistant output that is NOT a new
   * turn. Mid-turn output is just this turn talking, and a backgrounded
   * subagent keeps talking after the parent turn's `result` — adopting either
   * would let the running turn's `agent_result` run the post-turn flow twice.
   */
  it("ignores mid-turn output and a backgrounded subagent's output after the result", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const h = await runFirstStreamingTurn({
      onRun: () => fs.writeFileSync(filePath, "mid-turn work\n"),
    });

    h.agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Working on it" }],
    });
    await flush();
    expect(h.runner.running).toBe(true); // still turn 1, never interrupted

    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.settledTurns() === 1, "post-turn flow settled");

    // A backgrounded Task subagent reports after the parent turn ended. Its
    // events carry `parentToolUseId` — not a turn.
    h.agent.emit("event", {
      type: "agent_assistant",
      parentToolUseId: "task-1",
      content: [{ type: "text", text: "subagent still going" }],
    });
    await flush();
    await flush();

    expect(h.runner.running).toBe(false);
    expect(h.postTurnPrFlow).toHaveBeenCalledTimes(1);
    expect(h.autoCommit).toHaveBeenCalledTimes(1);
    expect(h.drainNext).toHaveBeenCalledTimes(1);
    expect(commitSubjects()).toHaveLength(2);

    h.runner.dispose({ force: true });
  });

  /**
   * docs/140 — the finished turn's own post-turn flow must not undo the
   * adoption. `tryDrain` runs a few awaits after `agent_result` and clears
   * `running`; a turn adopted inside that window would be put back to IDLE for
   * its whole response — the original symptom, restored by the fix's own
   * sequence — and the drain would start a queued turn CONCURRENTLY with the
   * turn the CLI is running.
   */
  it("does not clear running or drain when a CLI-started turn was adopted mid-sequence", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "turn-1 work\n"));

    // Park the token sync — the step BEFORE `tryDrain` — so the adoption lands
    // while the finished turn's sequence is still upstream of the drain.
    let releaseSync: () => void = () => {};
    let signalSyncEntered: () => void = () => {};
    const parked = new Promise<void>((r) => { releaseSync = r; });
    const syncEntered = new Promise<void>((r) => { signalSyncEntered = r; });
    const finalizeAgentEnv = vi.fn(async () => {
      signalSyncEntered();
      await parked;
    });
    const drainNext = vi.fn(async () => {});

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: realAutoCommit,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow: vi.fn(async () => {}),
      finalizeAgentEnv,
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "do the thing",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext,
      emit: () => {},
      useStreaming: true,
      adoptsCliStartedTurns: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await syncEntered;

    // The CLI-started turn begins while turn 1's sequence is parked before its drain.
    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Renamed the folder" }],
    });
    await flush();
    expect(runner.running).toBe(true);

    releaseSync();
    await flush();
    await flush();
    await flush();

    // The drain stood down: the session stays busy for the adopted turn, and no
    // queued turn was started alongside it.
    expect(runner.running).toBe(true);
    expect(drainNext).not.toHaveBeenCalled();

    // The adopted turn ends and drains for itself.
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => drainNext.mock.calls.length === 1, "adopted turn drained");
    expect(runner.running).toBe(false);

    runner.dispose({ force: true });
  });

  /**
   * docs/140 — the re-arm awaits the finished turn's whole post-turn sequence
   * (commit + PR round-trip), and the CLI is not paused by that await. A short
   * adopted turn — "rename the folder" is exactly that — can reach its `result`
   * first; reading the stale guard there would discard it and leave the turn
   * with no drain, no commit and no settlement: the same bug, one window
   * narrower. The adopted turn's `result` must therefore WAIT for the hand-over
   * rather than read a flag that is still the finished turn's.
   *
   * Two things overlap here on purpose, and the assertions distinguish them:
   *
   *   - The adopted turn's post-turn flow runs (a SECOND drain, and the session
   *     settles idle). Without the wait, `drainNext` stays at one call forever.
   *   - The finished turn commits under ITS OWN summary. Adoption clears
   *     `turnSummary` via `resetRunnerTurnState`, so a commit that read the live
   *     value here would label turn 1's work "Renamed the folder" — or, with no
   *     adopted text yet, the "Agent turn" fallback.
   *
   * Known residual, asserted rather than wished away: an adopted turn that edits
   * the tree BEFORE the finished turn's `git add -A` has those edits swept into
   * the finished turn's commit. The work reaches git (the tree ends clean and
   * the adopted turn's own commit is then a no-op) — only the attribution is the
   * previous turn's, for the sub-second window between `result` and the commit.
   * Fixing that would need per-turn path tracking through `git add -A`; the
   * outcome is a commit message, not lost work.
   */
  it("runs the post-turn flow for an adopted turn that finishes before the re-arm settles", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "turn-1 work\n"));

    // Turn 1's drain is slow (a queued-turn commit + a GitHub round-trip are
    // seconds of real work), so the re-arm behind it is still waiting.
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
    let settledTurns = 0;
    runner.on("idle", () => { settledTurns += 1; });

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: realAutoCommit,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow: vi.fn(async () => {}),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "do the thing",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext,
      emit: () => {},
      useStreaming: true,
      adoptsCliStartedTurns: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Both done." }],
    });
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await drainEntered;

    // The whole adopted turn — output AND result — lands while the re-arm is
    // still blocked on turn 1's parked sequence.
    fs.writeFileSync(filePath, "steered work\n");
    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Renamed the folder" }],
    });
    await flush();
    expect(runner.running).toBe(true);
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await flush();

    releaseDrain();

    // The adopted turn's result was not discarded: it drained for itself and
    // settled the session.
    await waitFor(() => drainCalls === 2, "adopted turn drained for itself");
    await waitFor(() => settledTurns === 2, "adopted turn settled");
    expect(runner.running).toBe(false);

    // Turn 1 committed under its own summary, snapshot at its `result` — not
    // under the adopted turn's text, and not under the "Agent turn" fallback.
    expect(commitSubjects()[0]).toBe("Both done.");
    // The work is in git either way, and nothing is left in the tree.
    expect(gitOut("show", "HEAD:file.txt")).toBe("steered work\n");
    expect(gitOut("status", "--porcelain")).toBe("");

    runner.dispose({ force: true });
  });

  /**
   * docs/140 — the hand-over is not only `agent_result`'s business. An adopted
   * turn can DIE (adapter error, crash, OOM) while its re-arm is still awaiting
   * the predecessor's post-turn sequence. Those terminal paths read the
   * predecessor's latched `drainFired` and already-settled commit memos, so
   * without waiting they no-op — and the re-arm then clears the memos with no
   * terminal event left to invoke them, leaving the adopted turn's edits in the
   * working tree.
   */
  it("commits an adopted turn that crashes while the re-arm is pending", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "turn-1 work\n"));

    // Park turn 1's sequence in its PR round-trip — AFTER its own commit, so
    // that commit cannot sweep up the adopted turn's edits and mask the bug.
    // This is the reviewer's exact scenario: "predecessor commit completes but
    // its PR round-trip keeps `streamingPostTurn` pending".
    let releasePr: () => void = () => {};
    let signalPrEntered: () => void = () => {};
    const parked = new Promise<void>((r) => { releasePr = r; });
    const prEntered = new Promise<void>((r) => { signalPrEntered = r; });
    let prCalls = 0;
    const postTurnPrFlow = vi.fn(async () => {
      prCalls += 1;
      if (prCalls === 1) {
        signalPrEntered();
        await parked;
      }
    });

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
      userText: "do the thing",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext: vi.fn(async () => {}),
      emit: () => {},
      useStreaming: true,
      adoptsCliStartedTurns: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Both done." }],
    });
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await prEntered;
    // Turn 1 has already committed its own work; the tree is clean.
    expect(gitOut("status", "--porcelain")).toBe("");

    // The adopted turn starts, edits the tree, and dies WITHOUT a result while
    // turn 1's PR round-trip — and so the re-arm behind it — is still pending.
    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Renaming the folder" }],
    });
    await flush();
    expect(runner.running).toBe(true);
    fs.writeFileSync(filePath, "steered work\n");
    agent.emit("done", 137);
    await flush();

    releasePr();

    // The crashed turn's edits are in git, not stranded in the working tree,
    // and under its own summary — its terminal path waited for the hand-over
    // instead of no-oping on the predecessor's settled commit memo.
    await waitFor(() => gitOut("status", "--porcelain") === "", "adopted turn's edits committed");
    expect(gitOut("show", "HEAD:file.txt")).toBe("steered work\n");
    expect(commitSubjects()[0]).toBe("Renaming the folder");
    // …and the session does not stay busy for a turn whose process is gone.
    await waitFor(() => !runner.running, "session settled after the crash");

    runner.dispose({ force: true });
  });

  /**
   * docs/140 — `tryDrain` checks ownership, then AWAITS the queued-turn commit
   * before draining. The check is stale by the time that await returns: a
   * CLI-started turn adopted during the commit would otherwise have a queued
   * turn started concurrently with it, which respawns the agent, removes the
   * adopted turn's listeners and resets its accumulator mid-response.
   */
  it("re-checks ownership after the queued-turn commit before draining", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "turn-1 work\n"));
    const drainNext = vi.fn(async () => {});

    // A message is queued behind turn 1, so `tryDrain` commits before draining.
    runner.enqueue({ text: "next please", execution: "interactive" });

    // Park inside that commit — the window between the ownership check and the
    // drain — and adopt a CLI-started turn there.
    let releaseCommit: () => void = () => {};
    let signalCommitEntered: () => void = () => {};
    const parked = new Promise<void>((r) => { releaseCommit = r; });
    const commitEntered = new Promise<void>((r) => { signalCommitEntered = r; });
    let commits = 0;
    const autoCommit = vi.fn(async (dir: string, summary: string) => {
      commits += 1;
      if (commits === 1) {
        signalCommitEntered();
        await parked;
      }
      return realAutoCommit(dir, summary);
    });

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow: vi.fn(async () => {}),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "do the thing",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext,
      emit: () => {},
      useStreaming: true,
      adoptsCliStartedTurns: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await commitEntered;

    // Adopted mid-commit — after `tryDrain` already passed its ownership check.
    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Renamed the folder" }],
    });
    await flush();
    expect(runner.running).toBe(true);

    releaseCommit();
    // Wait for the commit to actually land — `realAutoCommit` shells out to git,
    // so asserting a few microtasks later would pass vacuously whether or not
    // the drain stood down.
    await waitFor(() => commitSubjects().length === 2, "turn 1's queued-turn commit landed");
    await flush();
    await flush();

    // The queued turn was NOT started alongside the adopted one.
    expect(drainNext).not.toHaveBeenCalled();
    expect(runner.running).toBe(true);
    expect(runner.queueLength).toBe(1);

    // It drains once the adopted turn ends.
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => drainNext.mock.calls.length === 1, "queued turn drained after the adopted turn");

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
