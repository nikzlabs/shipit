/**
 * docs/150 req 14 — "When hard exhaustion happens partway through a turn,
 * ShipIt retries on the next eligible account regardless of what that turn has
 * already done."
 *
 * The provider ends the turn with `agent_result { error: "…usage limit…" }`.
 * Before that result can drain the queue or finalize the turn, the executor
 * re-runs it once on a fresh agent; the retry's own env-prep is what moves the
 * session onto another account (the spent one was benched by the listener a
 * moment earlier, req 7).
 *
 * These drive the real `SessionRunner.dispatch` → `runDispatchedTurn` →
 * `executeAgentTurn` path in-process with a fake agent, the same way the
 * docs/179 auth-retry tests do. Reverting the `retryOnNextAccount` branch in
 * `turn-executor.ts` makes them bite: the failed turn settles and the user is
 * left to resend.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { SessionRunner } from "../session-runner.js";
import type { SystemTurnDeps } from "../session-runner.js";
import type { AgentId } from "../../shared/types.js";
import { testDispatch } from "./dispatch-test-helpers.js";

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

function makeDeps(agents: FakeAgent[]): {
  deps: SystemTurnDeps;
  prepareAgentEnv: ReturnType<typeof vi.fn>;
  persistUserRow: ReturnType<typeof vi.fn>;
  autoCommit: ReturnType<typeof vi.fn>;
} {
  const prepareAgentEnv = vi.fn().mockResolvedValue(undefined);
  const persistUserRow = vi.fn();
  const autoCommit = vi.fn().mockResolvedValue({
    commitHash: null,
    parentHash: null,
    conflictedFiles: [],
    rebaseInProgress: false,
    secretFindings: [],
  });
  const deps: SystemTurnDeps = {
    agentFactory: () => {
      const a = makeFakeAgent();
      agents.push(a);
      return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
    },
    autoCommit,
    scheduleAutoPush: vi.fn(),
    prepareAgentEnv,
    listenerDeps: {
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
        append: persistUserRow,
        updateLastMessage: vi.fn().mockReturnValue(null),
        indexOfMessageId: vi.fn().mockReturnValue(-1),
      } as never,
      usageManager: { record: vi.fn(), getSessionUsage: vi.fn(), getSessionTokenTotals: vi.fn() } as never,
      sseBroadcast: vi.fn(),
      broadcastLog: vi.fn(),
      getSelectedModel: () => undefined,
    },
    buildRunParams: vi.fn().mockResolvedValue({ prompt: "do work", cwd: "/tmp/s1" }),
  };
  return { deps, prepareAgentEnv, persistUserRow, autoCommit };
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 0));
}

async function waitFor(fn: () => boolean, label = "condition", timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await flush();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const QUOTA_ERROR = "You've hit Claude's 5h usage limit. It resets at 2099-01-01T00:00:00.000Z.";
/** Verbatim from the incident — the CLI's own notice, delivered as assistant text. */
const QUOTA_NOTICE_TEXT = "You've hit your session limit · resets 5:10pm (UTC)";

describe("same-turn quota failover (docs/150 req 14)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("re-runs the turn once on a fresh agent when the provider reports exhaustion", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps, prepareAgentEnv } = makeDeps(agents);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });

    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");
    // The dying process held the spent account's token — it must not survive
    // into the retry and keep spending it.
    expect(agents[0]!.kill).toHaveBeenCalled();
    // The retry re-runs env-prep, which is what actually moves the session onto
    // the next eligible account (the spent one is already benched).
    expect(prepareAgentEnv).toHaveBeenCalledTimes(2);

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");

    runner.dispose({ force: true });
  });

  // Bounded to one retry: if the second account is spent too, the turn fails
  // normally rather than marching down every account one process at a time.
  it("does not retry a second time when the retry is also exhausted", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps } = makeDeps(agents);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");

    agents[1]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");

    expect(agents).toHaveLength(2);

    runner.dispose({ force: true });
  });

  /**
   * The 2026-08-10 incident: a post-turn commit landed and its push silently
   * never happened.
   *
   * The quota-retry path clears `running` before the replacement attempt starts,
   * so when the superseded process died the error listener signalled "idle"
   * while the turn's post-turn commit was still ~150ms away. The idle enforcer
   * accepted `dispose(force=false)` in that window, the runner left the
   * registry, and the push — whose debounce timer lived on that runner — went
   * with it. Nothing was logged.
   *
   * Pinned as an *ordering* fact, not a call shape: whenever the runner says it
   * is idle, this turn's commit has already run.
   */
  it("does not signal idle before the errored turn's post-turn commit has run", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps, autoCommit } = makeDeps(agents);
    runner.setSystemTurnDeps(deps);

    let committedWhenIdle: number | null = null;
    runner.on("idle", () => { committedWhenIdle = autoCommit.mock.calls.length; });

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    // Quota exhausted → the retry is armed and the current spawn is killed.
    agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");

    // ...and the retry dies at once — every account is spent, so the process
    // errors instead of producing a result. This is the path that signalled idle
    // ahead of its own commit.
    agents[1]!.emit("error", new Error("turn blocked: no eligible account"));
    await waitFor(() => committedWhenIdle !== null, "idle signal");

    expect(committedWhenIdle).toBeGreaterThan(0);

    runner.dispose({ force: true });
  });

  // The shape production hit on 2026-08-06 (session 174b5d98): the Claude CLI
  // reported the limit as an ordinary assistant message and then ended the turn
  // `subtype: "success"`, so the adapter left `agent_result.error` undefined.
  // Gated on that field, the retry never fired: the turn retired as a success,
  // no failover happened, and the limit notice became the auto-commit subject.
  it("retries when the limit arrives as assistant text on a success turn", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps, prepareAgentEnv, autoCommit } = makeDeps(agents);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: QUOTA_NOTICE_TEXT }],
    });
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });

    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");
    expect(agents[0]!.kill).toHaveBeenCalled();
    expect(prepareAgentEnv).toHaveBeenCalledTimes(2);
    // The exhausted attempt must not commit — that is how the limit notice
    // became a commit subject in the first place.
    expect(autoCommit).not.toHaveBeenCalled();

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");

    runner.dispose({ force: true });
  });

  // Bounded to one retry on the text channel too — and the turn it ends on must
  // not look like a success. That is the original incident (a limit notice
  // retiring as a completed turn), one account further along.
  it("ends errored, not successful, when the retry hits the limit in text as well", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps } = makeDeps(agents);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: QUOTA_NOTICE_TEXT }],
    });
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");

    agents[1]!.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: QUOTA_NOTICE_TEXT }],
    });
    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");

    expect(agents).toHaveLength(2);
    expect(runner.lastTurnErrored).toBe(true);

    runner.dispose({ force: true });
  });

  // The text channel carries the agent's own prose, so it matches only the
  // provider's own notice, anchored. An ordinary short summary that happens to
  // contain quota words — somebody else's billing problem — must still end as
  // one successful turn.
  it("does not retry a successful turn whose text merely mentions limits", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps } = makeDeps(agents);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("event", {
      type: "agent_assistant",
      content: [{
        type: "text",
        text: "The Vercel deploy failed because your account is out of credits; add funds and retry.",
      }],
    });
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");

    expect(agents).toHaveLength(1);
    expect(runner.lastTurnErrored).toBe(false);

    runner.dispose({ force: true });
  });

  // An ordinary failure is the user's to see and act on; silently re-running it
  // on another account would burn a second subscription's quota for nothing.
  it("does not retry an error that is not quota exhaustion", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps } = makeDeps(agents);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("event", { type: "agent_result", error: "API Error: 500", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");

    expect(agents).toHaveLength(1);

    runner.dispose({ force: true });
  });

  // The failed attempt must not look like a completed turn: draining the queue
  // or committing there would tell the user (and the next queued turn) that a
  // turn we are about to re-run is over.
  it("leaves drain and commit to the retry, not the exhausted attempt", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps, autoCommit } = makeDeps(agents);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    // The killed process's `done` must not run terminal work either.
    agents[0]!.emit("done", 0);
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");

    expect(autoCommit).not.toHaveBeenCalled();
    expect(runner.running).toBe(true);

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");
    // Wait for the commit itself rather than assuming it lands in the same tick
    // `running` clears. It deliberately does not: the finished-SSE broadcast is
    // sequenced between them so other tabs update without waiting out the git
    // work (`broadcastFinishedIfIdle`). What this test pins is WHICH attempt
    // commits — asserted above for the exhausted one, here for the retry.
    await waitFor(() => autoCommit.mock.calls.length > 0, "retry committed");

    runner.dispose({ force: true });
  });
});
