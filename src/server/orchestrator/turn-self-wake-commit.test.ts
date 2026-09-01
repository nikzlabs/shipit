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
import { postTurnCommit } from "./ws-handlers/post-turn.js";
import type { AgentId } from "../shared/types.js";
import { GitManager } from "../shared/git.js";

// These tests run several `waitFor` polls plus real git subprocesses per case;
// under a loaded full-suite CI runner the vitest default (5000ms) is headroom-
// free, and it equals `waitFor`'s internal deadline, which swallowed the
// helper's diagnostic label (see the comment on `waitFor`).
//
// The two deadlines COMPOSE, which is why this is not simply "20s is generous".
// The heaviest cases chain THREE sequential `waitFor` calls, so the budget a
// single test can consume is `3 × waitFor deadline` — and that product, not the
// helper deadline alone, is what has to stay under this timeout for a hang to
// fail with its label.
//
// `waitFor` now also honours a poll FLOOR (see `MIN_POLLS`), so its worst case is
// `max(15s, 200 polls × whatever a poll costs)`. 90s keeps `3 ×` that under this
// timeout until a single `git status` costs ~150ms — far past anything measured,
// and the point at which a bare vitest timeout would be the honest answer anyway.
vi.setConfig({ testTimeout: 90_000 });

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

// The deadline must stay strictly below the file's testTimeout — MULTIPLIED by
// the most `waitFor` calls any one test chains (three). When the two were equal
// (both 5000, vitest's default), vitest killed the test at the same instant this
// deadline expired, so CI reported a bare "Test timed out in 5000ms" and the
// descriptive label never surfaced. The gap is what makes a hang diagnosable.
//
// **Why there is a poll FLOOR and not just a bigger number.** Every poll runs a
// synchronous `git status` subprocess, so what a wall-clock deadline actually
// buys is a poll count — and how many polls a given number of seconds buys is
// decided by how loaded the machine is, which is the one thing a test cannot
// control. That was diagnosed correctly the first time this failed ("the two
// heaviest cases sit at 17 and 19 polls; in the failing run the 17-poll sibling
// passed and the 19-poll case did not") and answered by raising the deadline
// 5s → 15s. It then failed AGAIN, same test, same label, on a 918-file run.
//
// Raising the number a third time would buy another slowdown multiple and
// nothing else. A floor removes load from the equation: the loop refuses to give
// up before it has actually looked `MIN_POLLS` times, however long those took.
// The wall clock stays as the hang detector for the case where the condition is
// never going to arrive.
//
// **200, from measurement, and the earlier figure in this file was wrong.** The
// comment above used to say the heaviest cases sit at "17 and 19 polls". Running
// every `waitFor` in this file to completion with the clock disabled says
// otherwise: the busiest conditions ("wake turn post-turn flow ran",
// "cli-started turn post-turn flow ran") need **59** polls on an idle box, and
// half a dozen sit in the 53–58 band. A floor of 30 would have been BELOW what
// the file needs — failing precisely when the clock ran out first, which is the
// one situation it exists to cover.
//
// The floor is free on the success path: the loop returns the moment `fn()` is
// true, so a high floor costs nothing when things work. It is spent only when a
// condition never arrives, and 200 `git status` spawns report that in a second
// or two. So it is set well clear of the measured maximum rather than close to
// it — there is no prize for tightness here, and there is a demonstrated cost to
// guessing low.
const MIN_POLLS = 200;

async function waitFor(fn: () => boolean, label = "condition", timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let polls = 0;
  for (;;) {
    if (fn()) return;
    polls += 1;
    // Both bounds must be spent: the clock AND the floor. Either alone is a
    // budget the machine's load gets a vote in.
    if (polls >= MIN_POLLS && Date.now() >= deadline) break;
    await flush();
  }
  // The counts go in the message because they are what distinguishes a genuine
  // hang (the floor spent in milliseconds, the clock run out) from a starved
  // poll loop (the clock spent on a handful of polls) — telling those apart from
  // a CI log is what cost two rounds of this.
  throw new Error(
    `Timed out waiting for ${label} after ${polls} polls / ${Date.now() - startedAt}ms`,
  );
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
   * A `commitTurn` wired to the REAL `postTurnCommit` over the temp repo, so a
   * test can observe the two things the turn-start-head heuristic actually does
   * — the secret scan's `diffRange`, and the auto-push arm — instead of
   * asserting them by proxy.
   *
   * Only the two collaborators `postTurnCommit` reaches for outside git are
   * faked, and neither can decide the heuristic: `sessionManager` makes the
   * merged-branch guard allow a push, and `chatHistoryManager` takes the
   * commit→message link. Everything the assertions turn on — HEAD, ancestry,
   * the diff — comes from real git.
   */
  function makeRealCommitTurn() {
    const gitManager = new GitManager(repoDir);
    const diffRange = vi.spyOn(gitManager, "diffRange");
    const scheduleAutoPush = vi.fn();
    const ctx = {
      createGitManager: () => gitManager,
      chatHistoryManager: {
        updateLastMessage: vi.fn().mockReturnValue(null),
        indexOfMessageId: vi.fn().mockReturnValue(-1),
        append: vi.fn(),
      },
      sessionManager: {
        get: vi.fn().mockReturnValue({ id: "s1" }),
        getPrStatus: vi.fn().mockReturnValue(undefined),
        getSecretBlock: vi.fn().mockReturnValue(undefined),
        setSecretBlock: vi.fn(),
      },
      scheduleAutoPush,
    } as unknown as Parameters<typeof postTurnCommit>[0];

    /** Every `turnStartHeadHash` the executor hands the commit, in turn order. */
    const headsSeen: (string | null | undefined)[] = [];
    const commitTurn: SystemTurnDeps["commitTurn"] = async (args) => {
      headsSeen.push(args.turnStartHeadHash);
      return postTurnCommit(ctx, {
        sessionDir: args.sessionDir,
        sessionId: args.sessionId,
        emit: args.emit,
        turnSummary: args.summary,
        turnStartHeadHash: args.turnStartHeadHash,
        runner: args.runner,
        ...(args.deferPushArm ? { deferPushArm: args.deferPushArm } : {}),
      });
    };
    return { commitTurn, gitManager, diffRange, scheduleAutoPush, headsSeen };
  }

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
      // Codex: steering-capable (so streaming) but NOT resident across turns —
      // the executor derives that from `agentId` via the harness catalogue.
      useStreaming: true,
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
  it("commits AND finalizes an adopted turn that crashes while the re-arm is pending", async () => {
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

    const listenerDeps = makeListenerDeps();
    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: realAutoCommit,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow,
      listenerDeps,
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
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Both done." }],
    });
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await prEntered;
    const finalizedBefore = (listenerDeps.chatHistoryManager.finalizeInProgress as ReturnType<typeof vi.fn>).mock.calls.length;
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

    // Its ANSWER survives too. `receivedResult` stays true from turn 1, so
    // without widening the partial-turn finalize this turn's streamed rows would
    // be left `in_progress` for the next turn's `replaceInProgress` to delete —
    // the same chat-history loss this phase exists to stop.
    const finalize = listenerDeps.chatHistoryManager.finalizeInProgress as ReturnType<typeof vi.fn>;
    expect(finalize.mock.calls.length).toBeGreaterThan(finalizedBefore);
    const replace = listenerDeps.chatHistoryManager.replaceInProgress as ReturnType<typeof vi.fn>;
    const lastRows = replace.mock.calls[replace.mock.calls.length - 1]?.[1] as { text?: string }[];
    expect(lastRows.map((r) => r.text)).toContain("Renaming the folder");

    runner.dispose({ force: true });
  });

  /**
   * docs/140 — the same hand-over, reached through the ADAPTER-ERROR path
   * rather than `done`. A dispatched crash lands here (`codex/adapter.ts`
   * `initializeAndRun(...).catch`, a worker `agent_error` whose `agent_done`
   * never arrives), and it has its own drain+commit sequence — which would
   * otherwise run against the predecessor's settled memos.
   */
  it("commits an adopted turn that errors while the re-arm is pending", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "turn-1 work\n"));

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
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Both done." }],
    });
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await prEntered;
    expect(gitOut("status", "--porcelain")).toBe("");

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Renaming the folder" }],
    });
    await flush();
    expect(runner.running).toBe(true);
    fs.writeFileSync(filePath, "steered work\n");
    agent.emit("error", new Error("worker agent_error"));
    await flush();

    releasePr();

    await waitFor(() => gitOut("status", "--porcelain") === "", "errored adopted turn's edits committed");
    expect(gitOut("show", "HEAD:file.txt")).toBe("steered work\n");
    expect(commitSubjects()[0]).toBe("Renaming the folder");

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

  /**
   * The re-arm's ninth hand-over, and the one it was missing: the adopted turn's
   * TURN-START HEAD.
   *
   * `turnStartHeadHash` is read once, before the agent spawns, and frozen on the
   * executor's `TurnInput` — so an adopted turn inherited the head of whatever
   * turn the orchestrator last started, which on a session that self-wakes for
   * an hour is arbitrarily old. `postTurnCommit`'s clean-tree branch reads
   * `currentHead !== turnStartHead` as "the agent moved HEAD itself this turn",
   * and a self-wake turn that reads a review and answers stages nothing — so
   * that branch was entered on every one of them:
   *
   *  - it re-scanned the whole already-pushed `turnStartHead..HEAD` range for
   *    secrets, a range that grows with every turn, so a finding anywhere in
   *    shipped history would have false-blocked the push; and
   *  - it pushed a head the remote already holds, which moves nothing but still
   *    emits the `Auto-pushed to origin/<branch>` card — the reported symptom,
   *    the same commit announced again once per self-wake, with no error on any
   *    surface because every step believed it had succeeded.
   *
   * This drives the REAL `postTurnCommit` so both halves are observable: the
   * `diffRange` the scan would run, and the push arm.
   */
  it("gives an adopted turn its own turn-start head, so a no-op wake neither re-scans nor re-pushes", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "turn-1 work\n"));

    const { commitTurn, gitManager, diffRange, scheduleAutoPush, headsSeen } = makeRealCommitTurn();

    let settledTurns = 0;
    runner.on("idle", () => { settledTurns += 1; });

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: realAutoCommit,
      commitTurn,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow: vi.fn(async () => {}),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    // The head the ORCHESTRATOR-started turn was spawned against — read before
    // the agent runs, exactly as `agent-execution.ts` does.
    const headBeforeTurn1 = gitOut("rev-parse", "HEAD").trim();

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "kick off a background job",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: headBeforeTurn1,
      readTurnStartHeadHash: () => gitManager.getHeadHash(),
      drainNext: vi.fn(async () => {}),
      emit: () => {},
      useStreaming: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    // Turn 1 ends: its edit is committed, and that commit is pushed — once.
    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Backgrounding the consult" }],
    });
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => settledTurns === 1, "turn 1 post-turn flow settled");
    const headAfterTurn1 = gitOut("rev-parse", "HEAD").trim();
    expect(headAfterTurn1).not.toBe(headBeforeTurn1);
    expect(scheduleAutoPush).toHaveBeenCalledTimes(1);
    diffRange.mockClear();

    // The consult returns and the CLI wakes itself. This turn reads the review
    // and answers — no file changes at all, which is the ordinary shape.
    await selfWake(agent);
    expect(runner.running).toBe(true);
    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "The reviewer found nothing blocking" }],
    });
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => headsSeen.length === 2, "wake turn reached the commit");
    await waitFor(() => settledTurns === 2, "wake turn post-turn flow settled");

    // The symptom first. Nothing was committed and HEAD did not move, so the
    // clean-tree branch has nothing to do: already-pushed history is not
    // re-scanned for secrets…
    expect(diffRange).not.toHaveBeenCalled();
    // …and the commit the remote already holds is not pushed — and therefore
    // not announced — a second time.
    expect(scheduleAutoPush).toHaveBeenCalledTimes(1);
    expect(commitSubjects()).toHaveLength(2);
    // Then the cause: the adopted turn was handed the head it actually started
    // from, not the head of the turn that opened this closure.
    expect(headsSeen).toEqual([headBeforeTurn1, headAfterTurn1]);

    runner.dispose({ force: true });
  });

  /**
   * …and the baseline must not be sampled so late that the adopted turn has
   * already moved it.
   *
   * There is no instant at which the orchestrator can read HEAD and be sure the
   * adopted turn has not committed: the CLI opened that turn before it told us.
   * Reading HEAD *after* the predecessor's whole post-turn sequence — a commit
   * plus a PR round-trip, seconds during which the CLI keeps running — makes
   * that gap wide enough to lose work: the adopted turn's own `git commit` gets
   * sampled AS the baseline, so `postTurnCommit` sees `currentHead ===
   * turnStartHead` and neither scans nor pushes it, and the commit sits local
   * until some later turn happens to move it.
   *
   * So the baseline is sampled at the adoption EDGE — the earliest reading
   * available, taken before the re-arm waits the predecessor out.
   *
   * Reported by the docs/261 reviewer (codex) against the first version of this
   * fix, which read HEAD at the end of the re-arm.
   */
  it("samples an adopted turn's baseline at the adoption edge, so a commit the adopted turn makes itself is still scanned and pushed", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "turn-1 work\n"));
    const { commitTurn, gitManager, diffRange, scheduleAutoPush, headsSeen } = makeRealCommitTurn();
    /** Every baseline the executor sampled, as it resolved. */
    const headsRead: (string | null)[] = [];

    // Park turn 1's post-turn sequence AFTER its commit — `postTurnPrFlow` runs
    // inside `runCommitAndPr`, downstream of `commitOnce`. That is the real
    // window: the predecessor has committed, its PR round-trip is still going,
    // and the CLI is not waiting for any of it.
    let releasePrFlow: () => void = () => {};
    let signalPrFlowEntered: () => void = () => {};
    const parked = new Promise<void>((r) => { releasePrFlow = r; });
    const prFlowEntered = new Promise<void>((r) => { signalPrFlowEntered = r; });
    // The runner's "idle" event is no use as turn 1's settle signal here: the
    // wake flips `running` back to true before the sequence reaches it, so it
    // is correctly suppressed (same reason as the mid-post-turn-flow case
    // above). Latch the parked step's own completion instead.
    let prFlowDone = false;
    const postTurnPrFlow = vi.fn(async () => {
      signalPrFlowEntered();
      await parked;
      prFlowDone = true;
    });

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: realAutoCommit,
      commitTurn,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow,
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    const headBeforeTurn1 = gitOut("rev-parse", "HEAD").trim();
    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "kick off a background job",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: headBeforeTurn1,
      readTurnStartHeadHash: async () => {
        const head = await gitManager.getHeadHash();
        headsRead.push(head);
        return head;
      },
      drainNext: vi.fn(async () => {}),
      emit: () => {},
      useStreaming: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Backgrounding the consult" }],
    });
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await prFlowEntered;
    const predecessorCommit = gitOut("rev-parse", "HEAD").trim();
    expect(predecessorCommit).not.toBe(headBeforeTurn1);

    // The wake lands while that PR round-trip is still parked…
    agent.emit("event", { type: "agent_self_wake", taskId: "bg-1" });
    await flush();
    expect(runner.running).toBe(true);
    // `getHeadHash` is a real subprocess, so wait for the sample to actually
    // land rather than assuming two flushes covered it — otherwise the commit
    // below races the read and the test asserts nothing on a slow box.
    await waitFor(() => headsRead.length === 1, "baseline sampled at the adoption edge");

    // …and the adopted turn does what a real agent does after a consult comes
    // back with a fix worth keeping: it commits, itself, right away — before
    // the predecessor's flow has finished and released the re-arm.
    fs.writeFileSync(path.join(repoDir, "fix.txt"), "the consult's fix\n");
    git("add", "-A");
    git("commit", "-qm", "Agent's own commit during the adopted turn");
    const adoptedCommit = gitOut("rev-parse", "HEAD").trim();

    releasePrFlow();
    await waitFor(() => prFlowDone, "turn 1 post-turn flow settled");

    // The adopted turn ends having staged nothing further, so `autoCommit`
    // returns no hash and the clean-tree branch is the only thing that can
    // notice its commit.
    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Applied and committed the consult's fix" }],
    });
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => headsSeen.length === 2, "adopted turn reached the commit");
    await waitFor(() => scheduleAutoPush.mock.calls.length === 2, "adopted turn's commit pushed");

    // The baseline is HEAD as of the adoption edge — NOT the adopted turn's own
    // commit, which a read taken after the release would have sampled.
    expect(headsRead).toEqual([predecessorCommit]);
    expect(headsSeen[1]).toBe(predecessorCommit);
    expect(headsSeen[1]).not.toBe(adoptedCommit);
    // So the agent's commit is seen as newly added on top: scanned over exactly
    // its own range, and pushed.
    expect(diffRange).toHaveBeenCalledWith(predecessorCommit, adoptedCommit);
    expect(scheduleAutoPush).toHaveBeenCalledTimes(2);

    runner.dispose({ force: true });
  });

  /**
   * One adopted turn gets ONE re-arm, however many edges announce it.
   *
   * `agent_self_wake` and the adopted turn's first `agent_assistant` are
   * separate frames, and both reach `beginRearm`. Each used to build a re-arm of
   * its own — the winner's flag clearing happens after an await, so the loser
   * passed the same `streamingPostTurnFired` check — and the loser's `.finally`
   * had already overwritten `rearmInFlight`, so on settling it nulled the handle
   * while the winner was still working. Every terminal path waits by reading
   * that handle, so a null one reads as "no re-arm is running".
   *
   * Counting the reader's calls is the observable form: one adoption, one
   * baseline read, whichever edge arrives first.
   *
   * Reported by the docs/261 reviewer (codex).
   */
  it("builds one re-arm for one adopted turn, however many edges announce it", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "turn-1 work\n"));
    const { commitTurn, gitManager, headsSeen } = makeRealCommitTurn();

    let releasePrFlow: () => void = () => {};
    let signalPrFlowEntered: () => void = () => {};
    const parked = new Promise<void>((r) => { releasePrFlow = r; });
    const prFlowEntered = new Promise<void>((r) => { signalPrFlowEntered = r; });
    let prFlowDone = false;
    const postTurnPrFlow = vi.fn(async () => {
      signalPrFlowEntered();
      await parked;
      prFlowDone = true;
    });
    const readTurnStartHeadHash = vi.fn(() => gitManager.getHeadHash());

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: realAutoCommit,
      commitTurn,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow,
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    const headBeforeTurn1 = gitOut("rev-parse", "HEAD").trim();
    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "kick off a background job",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: headBeforeTurn1,
      readTurnStartHeadHash,
      drainNext: vi.fn(async () => {}),
      emit: () => {},
      useStreaming: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await prFlowEntered;
    const predecessorCommit = gitOut("rev-parse", "HEAD").trim();

    // Both edges land while the predecessor's flow is parked, so neither can
    // see the other's flag clearing — the shape that used to produce two.
    agent.emit("event", { type: "agent_self_wake", taskId: "bg-1" });
    await flush();
    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Reading the consult" }],
    });
    await flush();

    releasePrFlow();
    await waitFor(() => prFlowDone, "turn 1 post-turn flow settled");

    // The adopted turn ends. Reaching the commit at all means the one re-arm
    // completed and handed the guards over — so both assertions below are made
    // against a fully settled adoption, not a half-done one.
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => headsSeen.length === 2, "adopted turn reached the commit");

    // Two edges, one re-arm, one baseline read.
    expect(readTurnStartHeadHash).toHaveBeenCalledTimes(1);
    // …and it handed over intact: the adopted turn commits under its own
    // baseline, not the invoking turn's.
    expect(headsSeen[1]).toBe(predecessorCommit);

    runner.dispose({ force: true });
  });
});
