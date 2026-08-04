/**
 * SHI-277 — a turn that ends NORMALLY must still auto-commit, even when a
 * post-turn step that runs BEFORE the commit fails.
 *
 * `7f6aeb85` made `runCommitAndPr` reachable from every terminal path. It did
 * not make it unskippable on those paths: on all four it is sequenced last,
 * behind the token sync-back, the queue drain, the no-result chat row, the
 * interrupted-turn finalize and the finished-SSE broadcast —
 *
 *     trySyncToken(); await tryDrain(); broadcastFinishedIfIdle(); await runCommitAndPr();
 *
 * — inside an un-awaited `async` event listener. A throw in any earlier step
 * became an unhandled rejection that abandoned the rest of the sequence,
 * silently. Nothing recovered afterwards: `agent-listeners` had already
 * persisted the transcript, cleared `running` and told every viewer the turn
 * had finished, the resident streaming process does not exit so `done` never
 * fires, and the runner's `verifyRunningState` reconciler only acts while
 * `running` is still true. The turn's edits stayed in the working tree — no
 * commit, no push, no error — until a later turn's `git add -A` swept them up
 * under the wrong summary, or the branch's pull request merged without them.
 *
 * That is the shape of the PR #1890 incident: the branch squash-merged at
 * 13:23:44Z containing everything through the previous turn, and the missing
 * turn's seven files first entered git at 13:24:49Z inside the NEXT turn's
 * commit, carrying that turn's summary.
 *
 * These tests drive the real executor in-process (no Docker) against a REAL git
 * repo in a temp dir. Each makes exactly one pre-commit step throw and asserts
 * the work still lands. Remove the `postTurnStep` guards and every one of them
 * reads "base\n" — the turn's work is gone.
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

describe("the post-turn commit cannot be skipped by an earlier post-turn step", () => {
  let repoDir: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  const status = () => execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" });
  const commitCount = () =>
    execFileSync("git", ["log", "--oneline"], { cwd: repoDir, encoding: "utf8" })
      .split("\n")
      .filter(Boolean).length;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "shi277-"));
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
   * Build the WS shape: streaming (the default whenever live steering is on),
   * empty queue, a turn that writes a file and then ends cleanly with
   * `agent_result`. `failing` injects one throwing pre-commit step.
   */
  function setup(
    failing: Partial<SystemTurnDeps> & {
      drainNext?: () => Promise<void>;
      onInterruptedTurn?: () => void;
    } = {},
  ) {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const filePath = path.join(repoDir, "file.txt");
    const scheduleAutoPush = vi.fn();
    const postTurnPrFlow = vi.fn(async () => {});
    const { drainNext, onInterruptedTurn, ...depOverrides } = failing;
    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "the turn's work\n"));

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: realAutoCommit,
      scheduleAutoPush,
      postTurnPrFlow,
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
      ...depOverrides,
    };

    const start = (useStreaming: boolean) =>
      executeAgentTurn(runner, deps, agent as never, {
        agentId: "claude" as AgentId,
        sessionId: "s1",
        prompt: "p",
        userText: "make an edit",
        emitUserEcho: false,
        persistUserMessage: vi.fn(),
        isNewSession: false,
        fallbackTitle: "t",
        turnStartHeadHash: null,
        drainNext: drainNext ?? (async () => {}),
        emit: () => {},
        useStreaming,
        emitErrorOnNoResult: true,
        ...(onInterruptedTurn ? { onInterruptedTurn } : {}),
      });

    return { runner, agent, scheduleAutoPush, postTurnPrFlow, start };
  }

  /**
   * The incident's own ordering. Nothing crashed and nothing was interrupted:
   * the turn completed, `agent_result` arrived, and the FIRST statement of the
   * streaming post-turn sequence — the credentials sync-back — threw. That one
   * throw used to cost the turn its drain, its finished broadcast, its commit,
   * its push and its PR update, with no error surfaced anywhere.
   */
  it("commits when the token sync-back throws at the top of a clean streaming turn's post-turn flow", async () => {
    const { runner, agent, scheduleAutoPush, postTurnPrFlow, start } = setup({
      finalizeAgentEnv: () => {
        throw new Error("EACCES: credentials tree is owned by the wrong uid");
      },
    });

    await start(true);
    await waitFor(() => agent.run.mock.calls.length === 1, "turn started");
    expect(runner.queueLength).toBe(0);

    // A completely ordinary end of turn.
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });

    await waitFor(() => postTurnPrFlow.mock.calls.length === 1, "post-turn flow ran");
    expect(commitCount()).toBe(2);
    // Nothing left behind for a later turn to sweep up under its own summary.
    expect(status()).toBe("");
    expect(scheduleAutoPush).toHaveBeenCalled();

    runner.dispose({ force: true });
  });

  /**
   * The queue drain sits between the sync-back and the commit. `drainNext` runs
   * transport code (attachment resolution, the WS re-entry) and can reject; that
   * must cost the queued turn, not the finished turn's work.
   */
  it("commits when the queue drain rejects", async () => {
    const { runner, agent, postTurnPrFlow, start } = setup({
      drainNext: async () => {
        throw new Error("attachment resolution failed");
      },
    });

    await start(true);
    await waitFor(() => agent.run.mock.calls.length === 1, "turn started");

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });

    await waitFor(() => postTurnPrFlow.mock.calls.length === 1, "post-turn flow ran");
    expect(commitCount()).toBe(2);
    expect(status()).toBe("");

    runner.dispose({ force: true });
  });

  /**
   * The finished-SSE broadcast is the last step before the commit. It is a
   * pure UI signal aimed at other tabs — the cheapest thing in the sequence,
   * and it used to be able to take the commit down with it.
   */
  it("commits when the session_agent_finished broadcast throws", async () => {
    const sseBroadcast = vi.fn((event: string) => {
      if (event === "session_agent_finished") throw new Error("SSE client gone");
    });
    const { runner, agent, postTurnPrFlow, start } = setup({
      listenerDeps: makeListenerDeps(sseBroadcast),
    });

    await start(true);
    await waitFor(() => agent.run.mock.calls.length === 1, "turn started");

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });

    await waitFor(() => postTurnPrFlow.mock.calls.length === 1, "post-turn flow ran");
    expect(commitCount()).toBe(2);
    expect(status()).toBe("");

    runner.dispose({ force: true });
  });

  /**
   * The non-streaming turn splits its post-turn work across two handlers: the
   * sync-back and the drain run at `agent_result`, the commit later in `done`.
   * The finished-SSE broadcast is the one step still standing between the two,
   * and it had the same power to abandon the commit.
   */
  it("commits a non-streaming turn when the session_agent_finished broadcast throws", async () => {
    const sseBroadcast = vi.fn((event: string) => {
      if (event === "session_agent_finished") throw new Error("SSE client gone");
    });
    const { runner, agent, postTurnPrFlow, start } = setup({
      listenerDeps: makeListenerDeps(sseBroadcast),
    });

    await start(false);
    await waitFor(() => agent.run.mock.calls.length === 1, "turn started");

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agent.emit("done", 0);

    await waitFor(() => postTurnPrFlow.mock.calls.length === 1, "post-turn flow ran");
    expect(commitCount()).toBe(2);
    expect(status()).toBe("");

    runner.dispose({ force: true });
  });

  /**
   * The interrupted-turn finalize rewrites chat-history rows and runs before
   * the commit on the crash path. A SQLite failure there ("database connection
   * is not open" is already caught by name one layer up) must not also cost the
   * dead turn its partial edits — the very thing `7f6aeb85` added that path for.
   */
  it("commits a crashed streaming turn when the partial-turn finalize throws", async () => {
    const { runner, agent, postTurnPrFlow, start } = setup({
      onInterruptedTurn: () => {
        throw new Error("database connection is not open");
      },
    });

    await start(true);
    await waitFor(() => agent.run.mock.calls.length === 1, "turn started");

    // No `agent_result` — the process just dies, and finalizing the partial
    // transcript throws on the way to the commit.
    agent.emit("done", 143);
    await waitFor(() => postTurnPrFlow.mock.calls.length === 1, "post-turn flow ran");
    expect(commitCount()).toBe(2);
    expect(status()).toBe("");

    runner.dispose({ force: true });
  });
});
