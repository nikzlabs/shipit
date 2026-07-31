/**
 * SHI-262 — the queue must not drain before the finished turn's work is
 * committed.
 *
 * `turn-executor.ts` used to end a turn with `tryDrain()` → `broadcastFinished`
 * → `runCommitAndPr()`, so the next queued turn started while the previous
 * turn's edits were still only on disk. That was harmless as long as no turn
 * began by discarding working-tree state — but the moment one does
 * (`git reset --hard`, `git checkout -f`, a branch reset), the previous turn's
 * edits are destroyed with no reflog entry and no way back, because they never
 * entered git at all.
 *
 * The fix lives inside `tryDrain` rather than at the call sites, which matters:
 * the NON-streaming path drains at `agent_result` and commits later in `done`,
 * so swapping the two statements in the `done` handler would have fixed
 * nothing. Every drain path funnels through `tryDrain`, so that is where the
 * guarantee belongs.
 *
 * These tests drive the real `SessionRunner.dispatch` → `runDispatchedTurn` →
 * `executeAgentTurn` path in-process (no Docker) against a REAL git repo in a
 * temp dir, with fake agents standing in for the CLI. The first test is the one
 * that matters: it lets the queued turn actually run `git reset --hard` and
 * asserts the previous turn's edits survived.
 */
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

/** Minimal listener deps — enough for `wireAgentListeners` to run end to end. */
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
    authManager: { startOAuthFlow: vi.fn() } as never,
    sseBroadcast,
    broadcastLog: vi.fn(),
    getSelectedModel: () => undefined,
  };
}

describe("queue drain vs. post-turn commit ordering (SHI-262)", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "shi262-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
    git("init", "-q", "-b", "main");
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

  it("commits the finished turn's edits BEFORE a queued turn that resets the working tree runs", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const filePath = path.join(repoDir, "file.txt");

    // Turn 1 writes an edit and never commits it itself — exactly what a normal
    // agent turn does. Turn 2 is the destructive queued turn: it starts by
    // throwing away working-tree state, which is the whole hazard.
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
      // The real thing — `postTurnCommit`'s fallback path in `turn-executor`.
      autoCommit: async (sessionDir: string, summary: string) => {
        const git = new GitManager(sessionDir);
        const parentHash = await git.getHeadHash();
        const r = await git.autoCommit(summary);
        return { ...r, parentHash };
      },
      scheduleAutoPush: vi.fn(),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "make an edit" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "turn 1 started");
    expect(fs.readFileSync(filePath, "utf8")).toBe("turn-1 work\n");

    // Queued behind the running turn.
    runner.dispatch(testDispatch({ text: "reset the tree" }));
    expect(runner.queueLength).toBe(1);

    // End turn 1. Non-streaming: `agent_result` drains, `done` finishes up.
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);

    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "turn 2 started");

    // Turn 2 has now run `git reset --hard`. Turn 1's edit survives ONLY if it
    // was committed before the drain handed control over. With the pre-SHI-262
    // ordering this reads "base\n" — the work is gone, and gone for good.
    expect(fs.readFileSync(filePath, "utf8")).toBe("turn-1 work\n");

    const log = execFileSync("git", ["log", "--oneline"], { cwd: repoDir, encoding: "utf8" });
    expect(log.split("\n").filter(Boolean)).toHaveLength(2);

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn 2 finished");
    runner.dispose({ force: true });
  });

  it("commits before the drain on the STREAMING branch too (post-turn flow runs off agent_result)", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const filePath = path.join(repoDir, "file.txt");
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
      autoCommit: async (sessionDir: string, summary: string) => {
        const git = new GitManager(sessionDir);
        const parentHash = await git.getHeadHash();
        const r = await git.autoCommit(summary);
        return { ...r, parentHash };
      },
      scheduleAutoPush: vi.fn(),
      // Makes the first dispatched turn spawn as a resident streaming process,
      // which routes the whole post-turn flow through `agent_result`.
      steerInputs: () => ({ liveSteering: true, steeringCapable: true }),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "make an edit" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "turn 1 started");
    expect(runner.isStreamingActive).toBe(true);

    // A system turn is never steerable, so it queues behind the streaming turn
    // — the docs/239 shape: a wake turn that resets the branch, queued behind a
    // user turn whose edits are not committed yet.
    runner.dispatch(testDispatch({ text: "reset the tree", systemTurn: true }));
    expect(runner.queueLength).toBe(1);

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "turn 2 started");

    expect(fs.readFileSync(filePath, "utf8")).toBe("turn-1 work\n");

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    agents[0]!.emit("done", 0);
    await waitFor(() => !runner.running, "turns finished");
    runner.dispose({ force: true });
  });

  it("does not put a GitHub round-trip between two ordinary queued messages", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const order: string[] = [];
    let releasePrFlow: (() => void) | undefined;

    const deps: SystemTurnDeps = {
      agentFactory: () => {
        const idx = agents.length;
        const a = makeFakeAgent(() => order.push(`turn-${idx + 1}-started`));
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      autoCommit: async () => {
        order.push("commit");
        // A real edit would produce a hash; return one so the PR flow is reached.
        return { commitHash: "abc1234", parentHash: "def5678", conflictedFiles: [], rebaseInProgress: false, secretFindings: [] };
      },
      scheduleAutoPush: vi.fn(),
      // Stands in for the GitHub round-trip — and never resolves. If the drain
      // were moved behind the whole of `runCommitAndPr` (the naive "just swap
      // the two lines" fix), the second message would never start at all; here
      // the worst a real slow GitHub call can do is run alongside it.
      postTurnPrFlow: vi.fn(() => {
        order.push("pr-flow-entered");
        return new Promise<void>((resolve) => { releasePrFlow = resolve; });
      }),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "first" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "turn 1 started");
    runner.dispatch(testDispatch({ text: "second" }));
    expect(runner.queueLength).toBe(1);

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);

    // Starts while the PR flow is still outstanding — that is the whole point.
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "turn 2 started");

    // Only the LOCAL commit gates the drain (that's the SHI-262 fix). The PR
    // flow is still parked on its unresolved promise, so it demonstrably ran
    // alongside the queued turn rather than in front of it.
    expect(order.indexOf("turn-1-started")).toBe(0);
    expect(order.indexOf("commit")).toBeLessThan(order.indexOf("turn-2-started"));
    expect(deps.postTurnPrFlow).toHaveBeenCalledTimes(1);

    releasePrFlow?.();
    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn 2 finished");
    releasePrFlow?.();
    runner.dispose({ force: true });
  });

  it("commits exactly once when a queued turn drains (the drain-time commit is reused by the PR flow)", async () => {
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
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "first" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "turn 1 started");
    runner.dispatch(testDispatch({ text: "second" }));

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "turn 2 started");
    await waitFor(() => postTurnPrFlow.mock.calls.length === 1, "pr flow ran");

    // `commitOnce` memoizes the promise, so the `done` handler's
    // `runCommitAndPr` reuses the drain-time commit rather than staging twice.
    expect(autoCommit).toHaveBeenCalledTimes(1);
    expect(postTurnPrFlow).toHaveBeenCalledWith("s1", repoDir, "abc1234", expect.any(Function));

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn 2 finished");
    runner.dispose({ force: true });
  });

  it("leaves the empty-queue turn end untouched — the commit still runs after the finished SSE", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const order: string[] = [];
    const sseBroadcast = vi.fn((event: string) => {
      if (event === "session_agent_finished") order.push("finished");
    });

    const deps: SystemTurnDeps = {
      agentFactory: () => {
        const a = makeFakeAgent();
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      autoCommit: (async () => {
        order.push("commit");
        return { commitHash: null, parentHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [] };
      }) as never,
      scheduleAutoPush: vi.fn(),
      listenerDeps: makeListenerDeps(sseBroadcast),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "only turn" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "turn started");
    expect(runner.queueLength).toBe(0);

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);
    await waitFor(() => order.includes("commit"), "commit ran");

    // Nothing is queued, so nothing can start against an uncommitted tree — the
    // ordering that keeps other tabs' sidebars prompt (see
    // `turn-finished-ordering.test.ts`) is preserved unchanged.
    expect(order).toEqual(["finished", "commit"]);

    runner.dispose({ force: true });
  });
});
