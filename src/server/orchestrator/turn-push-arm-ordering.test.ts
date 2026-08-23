/**
 * The post-turn auto-push is armed AFTER the turn's own git work, not inside
 * the commit.
 *
 * The post-turn flows push: `postTurnPrFlow` opens a pull request with a plain
 * push, or a `forcePush` when re-arming past a merged one (`quickCreatePr`), and
 * the release flow can publish a branch. While the arm lived inside
 * `postTurnCommit`, a debounced plain push could race that force-push, be
 * rejected non-fast-forward, and post the "your branch has diverged" transcript
 * notice for a branch that was fine — the false-alarm class
 * `services/auto-push-scheduler.ts` documents from two production incidents.
 *
 * What kept them apart was nothing but the 5-second debounce being longer than
 * the flow, which was never a guarantee: PR creation writes its title with an
 * LLM and can exceed it. `merged-push-guard.ts` deliberately ALLOWS the
 * auto-push once the branch has left the merged tip, which is exactly the
 * re-arm case, so the two really do meet on that path.
 *
 * The ordering is now explicit — `postTurnCommit` hands the arm to
 * `turn-executor.ts` via `deferPushArm` — and that is what these pin. Without
 * it the debounce cannot go to 0, which is where it belongs: it never coalesced
 * anything (see `app-di.ts`).
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
import { testDispatch } from "./integration_tests/dispatch-test-helpers.js";

interface FakeAgent extends EventEmitter {
  run: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
}

function makeFakeAgent(): FakeAgent {
  const agent = new EventEmitter() as FakeAgent;
  agent.run = vi.fn();
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

describe("post-turn auto-push arm ordering", () => {
  let repoDir: string;
  /** Every ordered event of one turn's post-turn sequence, in the order it happened. */
  let order: string[];

  /**
   * Stands in for the real wiring: `commitTurn` → `postTurnCommit`, which takes
   * the arm rather than firing it when the caller passes `deferPushArm`.
   */
  function makeDeps(over: Partial<SystemTurnDeps> = {}): SystemTurnDeps {
    const agents: FakeAgent[] = [];
    return {
      agentFactory: () => {
        const a = makeFakeAgent();
        agents.push(a);
        (makeDeps as unknown as { agents: FakeAgent[] }).agents = agents;
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      autoCommit: vi.fn(),
      scheduleAutoPush: vi.fn(),
      commitTurn: vi.fn(async ({ deferPushArm }) => {
        order.push("commit");
        deferPushArm?.(() => order.push("push-armed"));
        return "abc1234";
      }),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
      ...over,
    } as SystemTurnDeps;
  }

  /** Run one turn to completion against `deps`, returning the fake agents used. */
  async function runOneTurn(runner: SessionRunner, agents: FakeAgent[]): Promise<void> {
    runner.dispatch(testDispatch({ text: "do the thing" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "turn started");
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);
    await waitFor(() => order.includes("push-armed"), "push armed");
  }

  beforeEach(() => {
    order = [];
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-push-arm-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    fs.writeFileSync(path.join(repoDir, "README.md"), "x\n");
    git("add", "-A");
    git("commit", "-qm", "initial");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("arms the push after the PR flow, which does its own synchronous push", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const deps = makeDeps({
      agentFactory: () => {
        const a = makeFakeAgent();
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      postTurnPrFlow: vi.fn(async () => {
        order.push("pr-flow-start");
        // The PR flow's own `git push` / `forcePush` — the thing the debounced
        // push must not race.
        await new Promise((r) => setTimeout(r, 5));
        order.push("pr-flow-end");
      }),
    });
    runner.setSystemTurnDeps(deps);

    await runOneTurn(runner, agents);

    expect(order).toEqual(["commit", "pr-flow-start", "pr-flow-end", "push-armed"]);
    runner.dispose({ force: true });
  });

  it("arms after the release flow too — it can publish a branch of its own", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const deps = makeDeps({
      agentFactory: () => {
        const a = makeFakeAgent();
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      postTurnReleaseFlow: vi.fn(async () => { order.push("release-flow"); }),
    });
    runner.setSystemTurnDeps(deps);

    await runOneTurn(runner, agents);

    expect(order).toEqual(["commit", "release-flow", "push-armed"]);
    runner.dispose({ force: true });
  });

  it("still arms when a post-turn flow throws — the commit is already made", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const deps = makeDeps({
      agentFactory: () => {
        const a = makeFakeAgent();
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      postTurnPrFlow: vi.fn(async () => {
        order.push("pr-flow");
        throw new Error("GitHub is down");
      }),
    });
    runner.setSystemTurnDeps(deps);

    await runOneTurn(runner, agents);

    // A commit that never gets pushed, with nothing said, is the failure the
    // scheduler exists to make impossible — a failing PR flow must not cause it.
    expect(order).toEqual(["commit", "pr-flow", "push-armed"]);
    runner.dispose({ force: true });
  });

  /**
   * The path an independent review found, and the reason the arm is not held by
   * the post-turn flow alone. `tryDrain` COMMITS before it starts a queued turn,
   * and starting that turn supersedes this one's agent. The `superseded` handler
   * is settle-only — it is forbidden from running a post-turn commit — and a
   * retired turn's `done` carries the previous spawn's runToken, so it may be
   * dropped and never arrive. The commit would then sit local with no scheduler
   * record and nothing said anywhere: invariant 3's failure, reintroduced by the
   * deferral itself.
   */
  it("arms when the turn is superseded after committing, even with no `done`", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const deps = makeDeps({
      agentFactory: () => {
        const a = makeFakeAgent();
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
    });
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "first" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "turn 1 started");
    // Queued behind it — this is what makes the drain commit.
    runner.dispatch(testDispatch({ text: "second" }));
    expect(runner.queueLength).toBe(1);

    // `agent_result` drains: it commits turn 1's work, then starts turn 2 —
    // and `setAgent` emits `superseded` on turn 1's agent for real. No `done`
    // ever follows for it, which is the case the runToken guard can produce.
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => agents.length === 2, "turn 2 started (turn 1 superseded)");
    expect(order).toContain("commit");

    await waitFor(() => order.includes("push-armed"), "push armed despite supersession");
    runner.dispose({ force: true });
  });

  it("arms exactly once, however many terminal paths reach the post-turn flow", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const deps = makeDeps({
      agentFactory: () => {
        const a = makeFakeAgent();
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
    });
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do the thing" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "turn started");
    // Both terminal signals, as a crashing streaming agent produces.
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);
    agents[0]!.emit("done", 0);
    await waitFor(() => order.includes("push-armed"), "push armed");
    await flush();

    expect(order.filter((e) => e === "push-armed")).toHaveLength(1);
    runner.dispose({ force: true });
  });
});
