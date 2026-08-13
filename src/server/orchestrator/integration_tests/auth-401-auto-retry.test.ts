/**
 * Regression tests for docs/179 — the "new session 401 once a day" bug, and
 * its fix: a runtime-401 auto-retry.
 *
 * Symptom: a session that started in the narrow window where the scheduled
 * OAuth refresher had fallen behind its safety margin (a run of 429 backoffs
 * ate the lead time) synced in a dying source token and 401'd on its very first
 * CLI call. The user saw a sign-in card for a turn that should just have run,
 * and had to re-authenticate + re-send despite already being signed in.
 *
 * Fix: when a turn's CLI emits `auth_required`, the executor first awaits a
 * single-flight source-token heal (`ensureAgentTokenFresh`). If the token
 * rotates back to usable, it re-dispatches the SAME turn once on a fresh agent —
 * no sign-in card, no manual re-send. Only when the heal genuinely fails (token
 * revoked / rate-limited) does the visible re-auth flow surface. The retry is
 * bounded: a second `auth_required` on the re-dispatched turn surfaces the card
 * rather than looping.
 *
 * These tests drive the real `SessionRunner.dispatch` → `runDispatchedTurn` →
 * `executeAgentTurn` → `wireAgentListeners` path in-process (no Docker) with a
 * fake agent we make emit `auth_required`, mirroring the stale-token 401.
 * Reverting either the `recoverAuth` re-dispatch (turn-executor.ts) or the
 * listener's `willRecoverAuth`/`recoverAuth` wiring (agent-listeners.ts) makes
 * these bite: the heal is never awaited and the card surfaces on the first 401.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { SessionRunner } from "../session-runner.js";
import type { SystemTurnDeps } from "../session-runner.js";
import type { AgentId } from "../../shared/types.js";
import { testDispatch } from "./dispatch-test-helpers.js";

// Only needed by the end-to-end test below, which drives the REAL session-side
// drain loop rather than emitting a synthetic `auth_required`. Everything else
// in this file uses a bare fake agent.
vi.mock("node:child_process", async () => {
  // eslint-disable-next-line no-restricted-syntax -- vitest's blessed form
  const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...real, spawn: vi.fn() };
});

import * as childProcess from "node:child_process";
import { StreamingClaudeProcess } from "../../session/agents/claude/process.js";

const mockChildSpawn = vi.mocked(childProcess.spawn);

/**
 * The two events CLI 2.1.219 actually emits for one auth failure, captured from
 * a real unauthenticated run: a synthetic assistant envelope, then a result
 * whose `subtype` is "success" and whose `is_error` is true.
 */
const REAL_AUTH_FAILURE_NDJSON = `${JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] },
  error: "authentication_failed",
  is_api_error_message: true,
})}\n${JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: true,
  terminal_reason: "api_error",
  session_id: "abc",
  result: "Not logged in · Please run /login",
})}\n`;

/**
 * Wire the REAL session-side detection in front of a fake orchestrator agent.
 *
 * The other tests here emit one synthetic `auth_required`, which is precisely
 * the assumption that hid this bug: the real CLI describes a single failure
 * with TWO events, and each used to raise the signal independently. This helper
 * runs a genuine `StreamingClaudeProcess` (with `spawn` mocked) so raw CLI bytes
 * go through the production drain loop, and forwards whatever it raises to the
 * agent the executor is listening to. How many `auth_required`s the executor
 * sees is therefore decided by production code, not by the test.
 */
function feedRealCliOutput(agent: FakeAgent): (raw: string) => void {
  const stdout = new EventEmitter();
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
  proc.stdout = stdout;
  proc.stderr = new EventEmitter();
  // An EventEmitter, like the real `ChildProcess.stdin`: the process attaches an
  // `error` listener to it so an EPIPE cannot crash the worker, and a plain
  // object has no `.on`.
  const stdin = new EventEmitter() as EventEmitter & Record<string, unknown>;
  stdin.write = vi.fn(() => true);
  stdin.end = vi.fn();
  stdin.writable = true;
  stdin.destroyed = false;
  stdin.writableEnded = false;
  proc.stdin = stdin;
  proc.kill = vi.fn();
  mockChildSpawn.mockReturnValue(proc as never);

  const cli = new StreamingClaudeProcess();
  cli.on("auth_required", () => agent.emit("auth_required"));
  cli.run({ prompt: "do work" });

  return (raw: string) => stdout.emit("data", Buffer.from(raw));
}

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

/**
 * Minimal `SystemTurnDeps` for the dispatch path, with the docs/179
 * `ensureAgentTokenFresh` healer injected. `healResult` controls whether the
 * heal reports the token usable (→ silent re-dispatch) or not (→ sign-in card).
 */
function makeDeps(
  agents: FakeAgent[],
  ensureAgentTokenFresh: SystemTurnDeps["ensureAgentTokenFresh"],
  // docs/260 — the heal is scoped by the TURN'S OWN captured route, which the
  // executor takes from `prepareAgentEnv`'s returned `turnRoute`.
  turnRoute?: { kind: "account" | "reserved"; id: string },
): {
  deps: SystemTurnDeps;
  sseBroadcast: ReturnType<typeof vi.fn>;
  startOAuthFlow: ReturnType<typeof vi.fn>;
  persistUserRow: ReturnType<typeof vi.fn>;
  onAgentAuthRequired: ReturnType<typeof vi.fn>;
} {
  const sseBroadcast = vi.fn();
  const startOAuthFlow = vi.fn();
  const persistUserRow = vi.fn();
  const onAgentAuthRequired = vi.fn();
  const deps: SystemTurnDeps = {
    agentFactory: () => {
      const a = makeFakeAgent();
      agents.push(a);
      return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
    },
    ...(ensureAgentTokenFresh ? { ensureAgentTokenFresh } : {}),
    ...(turnRoute ? { prepareAgentEnv: async () => ({ turnRoute }) } : {}),
    autoCommit: vi.fn().mockResolvedValue({
      commitHash: null,
      parentHash: null,
      conflictedFiles: [],
      rebaseInProgress: false,
      secretFindings: [],
    }),
    scheduleAutoPush: vi.fn(),
    listenerDeps: {
      sessionManager: {
        setAgentSessionId: vi.fn(),
        clearAgentSessionId: vi.fn(),
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
      sseBroadcast,
      broadcastLog: vi.fn(),
      getSelectedModel: () => undefined,
      onAgentAuthRequired,
    },
    buildRunParams: vi.fn().mockResolvedValue({ prompt: "do work", cwd: "/tmp/s1" }),
  };
  return { deps, sseBroadcast, startOAuthFlow, persistUserRow, onAgentAuthRequired };
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

describe("runtime-401 auto-retry (docs/179)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("heals the token and silently re-dispatches the turn (no sign-in card) on a transient 401", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const messages: { type: string; [k: string]: unknown }[] = [];
    runner.on("message", (m) => messages.push(m as never));
    // Heal reports the token usable again → the executor should re-dispatch.
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(true);
    const { deps, startOAuthFlow } = makeDeps(agents, ensureAgentTokenFresh);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    // The stale-token 401: the CLI demands auth, then the worker process exits.
    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);

    // The heal is awaited and the SAME turn is re-dispatched on a fresh agent.
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "re-dispatched agent run");
    expect(ensureAgentTokenFresh).toHaveBeenCalledTimes(1);
    expect(agents[0]!.kill).toHaveBeenCalled();

    // Quiet recovery: no sign-in card, no OAuth flow start.
    expect(messages.some((m) => m.type === "auth_required")).toBe(false);
    expect(startOAuthFlow).not.toHaveBeenCalled();

    // The retried turn completes normally and finalizes the turn.
    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");
    // Bounded: exactly two agents (original + one retry).
    expect(agents).toHaveLength(2);

    runner.dispose({ force: true });
  });

  // The bug this test exists for: the CLI reports ONE auth failure with TWO
  // events, and both used to raise `auth_required` independently. Nothing
  // downstream was idempotent — each raise healed the token and re-dispatched
  // the turn on its own fresh agent — so a single 401 ran the user's whole
  // turn twice, side effects included. Every other test in this file emits one
  // synthetic `auth_required` and cannot see it.
  it("runs the turn exactly once when the real CLI reports one failure as two events", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const messages: { type: string; [k: string]: unknown }[] = [];
    runner.on("message", (m) => messages.push(m as never));
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(true);
    const { deps, startOAuthFlow } = makeDeps(agents, ensureAgentTokenFresh);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    // Raw CLI bytes → real drain loop → however many signals production raises.
    const feed = feedRealCliOutput(agents[0]!);
    feed(REAL_AUTH_FAILURE_NDJSON);
    agents[0]!.emit("done", 0);

    await waitFor(() => agents.length >= 2 && agents[1]!.run.mock.calls.length === 1, "re-dispatched agent run");
    // Settle everything a second (now-suppressed) raise would have started, so
    // an extra heal or extra agent would have shown up by the assertions below.
    for (let i = 0; i < 20; i++) await flush();

    // One heal, one fresh agent, one run of the user's prompt. Measured against
    // the pre-fix code, this same payload produced 2 heals and 3 agents, with
    // the user's turn dispatched twice.
    expect(ensureAgentTokenFresh).toHaveBeenCalledTimes(1);
    expect(agents).toHaveLength(2);
    expect(agents[1]!.run).toHaveBeenCalledTimes(1);
    // Still quiet: the duplicate must not surface a sign-in card mid-recovery.
    expect(messages.some((m) => m.type === "error")).toBe(false);
    expect(messages.some((m) => m.type === "auth_required")).toBe(false);
    expect(startOAuthFlow).not.toHaveBeenCalled();

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");
    expect(agents).toHaveLength(2);

    runner.dispose({ force: true });
  });

  it("surfaces a re-auth error pointing to Settings (no re-dispatch, no OAuth popup) when the heal fails — token revoked / rate-limited", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const messages: { type: string; [k: string]: unknown }[] = [];
    runner.on("message", (m) => messages.push(m as never));
    // Heal can't make the token usable → fall back to the visible re-auth flow.
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(false);
    const { deps, sseBroadcast, startOAuthFlow } = makeDeps(agents, ensureAgentTokenFresh);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);

    // The heal is attempted, fails, and a re-auth error surfaces — pointing
    // the user to Settings rather than auto-launching the OAuth flow.
    await waitFor(() => messages.some((m) => m.type === "error"), "re-auth error surfaced");
    expect(ensureAgentTokenFresh).toHaveBeenCalledTimes(1);
    expect(startOAuthFlow).not.toHaveBeenCalled();
    // No re-dispatch — exactly one agent — and the turn is finished.
    expect(agents).toHaveLength(1);
    expect(sseBroadcast).toHaveBeenCalledWith("session_agent_finished", { sessionId: "s1" });
    expect(runner.running).toBe(false);

    runner.dispose({ force: true });
  });

  it("continues the same logical turn on the next healthy subscription account after a confirmed auth failure", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const messages: { type: string; [key: string]: unknown }[] = [];
    runner.on("message", (message) => messages.push(message as never));
    const authFailedAccounts = new Set<string>();
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(false);
    const { deps, persistUserRow, onAgentAuthRequired } = makeDeps(agents, ensureAgentTokenFresh);
    onAgentAuthRequired.mockImplementation(() => authFailedAccounts.add("acct-a"));
    const prepareAgentEnv = vi.fn().mockImplementation(
      async (_sessionId: string, _agentId: AgentId, opts?: { excludeRouteIds?: readonly string[] }) => {
        const excluded = opts?.excludeRouteIds ?? [];
        if (!excluded.includes("acct-a") && !authFailedAccounts.has("acct-a")) {
          return { turnRoute: { kind: "account" as const, id: "acct-a" } };
        }
        return {
          turnRoute: {
            kind: "account" as const,
            id: "acct-b",
          },
        };
      },
    );
    deps.prepareAgentEnv = prepareAgentEnv;
    deps.routeProfile = vi.fn().mockReturnValue({
      serviceId: "anthropic",
      billingMode: "sub",
    });
    deps.routeLabel = (routeId) => routeId === "acct-a" ? "Primary" : "Backup";
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first account run");

    agents[0]!.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Partial work before authentication failed" }],
    });
    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "backup account run");

    expect(ensureAgentTokenFresh).toHaveBeenCalledWith("claude", "acct-a", { force: true });
    expect(onAgentAuthRequired).toHaveBeenCalledWith("claude");
    expect(authFailedAccounts).toContain("acct-a");
    expect(prepareAgentEnv.mock.calls[1]?.[2]?.excludeRouteIds).toEqual(["acct-a"]);
    expect(agents[1]!.run.mock.calls[0]?.[0]?.prompt).toBe("do work");
    const history = deps.listenerDeps.chatHistoryManager as any;
    expect(history.replaceInProgress.mock.calls.some((call: any[]) =>
      call[1]?.some((row: { text?: string }) => row.text === "Partial work before authentication failed"),
    )).toBe(true);
    expect(history.finalizeInProgress).toHaveBeenCalled();
    expect(messages.some((message) =>
      String(message.message).includes("Primary could not authenticate")
      && !String(message.message).includes("out of quota"),
    )).toBe(true);

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "failover turn finished");

    expect(agents).toHaveLength(2);
    expect(runner.lastTurnErrored).toBe(false);
    expect(messages.filter((message) => message.type === "error")).toHaveLength(0);
    const userRows = persistUserRow.mock.calls
      .map((call) => call[1] as { role?: string; text?: string } | undefined)
      .filter((row) => row?.role === "user" && row.text === "do work");
    expect(userRows).toHaveLength(1);
    runner.dispose({ force: true });
  });

  it("does not cross to metered billing and stops after the backup subscription also fails auth", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(false);
    const { deps } = makeDeps(agents, ensureAgentTokenFresh);
    const selectedRoutes: string[] = [];
    const prepareAgentEnv = vi.fn().mockImplementation(
      async (_sessionId: string, _agentId: AgentId, opts?: { excludeRouteIds?: readonly string[] }) => {
        const excluded = opts?.excludeRouteIds ?? [];
        if (excluded.includes("acct-a") && excluded.includes("acct-b")) {
          selectedRoutes.push("metered-key");
          return { turnRoute: { kind: "reserved" as const, id: "metered-key" } };
        }
        if (excluded.includes("acct-a")) {
          selectedRoutes.push("acct-b");
          return { turnRoute: { kind: "account" as const, id: "acct-b" } };
        }
        selectedRoutes.push("acct-a");
        return { turnRoute: { kind: "account" as const, id: "acct-a" } };
      },
    );
    deps.prepareAgentEnv = prepareAgentEnv;
    deps.routeProfile = vi.fn().mockImplementation((_kind, routeId) => ({
      serviceId: "anthropic",
      billingMode: routeId === "metered-key" ? "key" : "sub",
    }));
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "primary run");
    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "backup run");

    // The replacement attempt has spent the one automatic recovery budget.
    // Its auth failure surfaces normally and cannot start a third route.
    agents[1]!.emit("auth_required");
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "bounded auth failure");
    expect(agents).toHaveLength(2);
    expect(prepareAgentEnv).toHaveBeenCalledTimes(2);
    expect(selectedRoutes).toEqual(["acct-a", "acct-b"]);
    runner.dispose({ force: true });
  });

  // A late `done` must not release the FAILED-HEAL sequence's post-turn hold.
  //
  // `recoverAuth`'s heal-failed branch runs this turn's whole terminal sequence
  // (drain → commit → finished → settle) under the post-turn hold that keeps the
  // runner off the idle-reclaim list. The killed agent's `done` can arrive while
  // that sequence is mid-commit, and it takes the `automaticRecoveryInProgress`
  // stand-down — which briefly ALSO released the hold, on the mistaken theory
  // that the re-dispatched turn owned it. There is no re-dispatched turn on this
  // branch: the release just reopened the window over the commit. (Found by
  // cross-backend review.)
  it("a late `done` does not release the failed-heal sequence's reclaim hold", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(false); // heal fails
    const { deps } = makeDeps(agents, ensureAgentTokenFresh);
    // Hold the commit open so the terminal sequence is observably in flight.
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((r) => { releaseCommit = r; });
    deps.autoCommit = vi.fn().mockImplementation(async () => {
      await commitGate;
      return { commitHash: null, parentHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [] };
    });
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    // 401 → heal fails → the terminal sequence starts and parks in the commit.
    agents[0]!.emit("auth_required");
    await waitFor(() => (deps.autoCommit as ReturnType<typeof vi.fn>).mock.calls.length === 1, "commit started");
    expect(runner.postTurnWorkInFlight).toBe(true);
    expect(runner.agentBusy).toBe(true);

    // The killed process's `done` lands mid-commit.
    agents[0]!.emit("done", 0);
    await flush();
    // Before the fix this was false: the stand-down had dropped the hold and the
    // runner was reclaimable with its commit still running.
    expect(runner.postTurnWorkInFlight).toBe(true);
    expect(runner.agentBusy).toBe(true);

    releaseCommit();
    await waitFor(() => !runner.postTurnWorkInFlight, "hold released after the commit");
    expect(runner.agentBusy).toBe(false);

    runner.dispose({ force: true });
  });

  it("does not loop: a second auth_required on the re-dispatched turn surfaces the card instead of healing again", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const messages: { type: string; [k: string]: unknown }[] = [];
    runner.on("message", (m) => messages.push(m as never));
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(true);
    const { deps, startOAuthFlow } = makeDeps(agents, ensureAgentTokenFresh);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    // First 401 → heal succeeds → re-dispatch.
    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "re-dispatched agent run");

    // The re-dispatched turn ALSO 401s. Because it's the auth-retry, the
    // executor must NOT heal+retry again — it surfaces the card.
    agents[1]!.emit("auth_required");
    agents[1]!.emit("done", 0);
    await waitFor(() => messages.some((m) => m.type === "error"), "re-auth error on the retry");

    // The heal ran exactly once (first attempt only); no third agent spawned.
    expect(ensureAgentTokenFresh).toHaveBeenCalledTimes(1);
    expect(startOAuthFlow).not.toHaveBeenCalled();
    expect(agents).toHaveLength(2);
    expect(runner.running).toBe(false);

    runner.dispose({ force: true });
  });

  it("finalizes visible first-attempt output before a healed auth retry that fails empty", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(true);
    const { deps } = makeDeps(agents, ensureAgentTokenFresh);
    let durableHistory: any[] = [];
    const history = deps.listenerDeps.chatHistoryManager as any;
    history.replaceInProgress = vi.fn((_sid: string, messages: any[]) => {
      durableHistory = [...durableHistory.filter((m) => !m.inProgress), ...messages];
    });
    history.finalizeInProgress = vi.fn(() => {
      durableHistory = durableHistory.map((m) => ({ ...m, inProgress: false }));
    });
    history.append = vi.fn((_sid: string, message: any) => { durableHistory.push(message); });
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");
    agents[0]!.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "Visible before auth failed" }] });
    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "healed retry");

    agents[1]!.emit("error", new Error("retry spawn failed"));
    await waitFor(() => durableHistory.some((m) => m.isError), "durable retry error");
    expect(durableHistory.map((m) => m.text)).toContain("Visible before auth failed");
    expect(durableHistory.some((m) => String(m.text).includes("retry spawn failed"))).toBe(true);
    expect(durableHistory.every((m) => !m.inProgress)).toBe(true);

    runner.dispose({ force: true });
  });
  // ---- the heal has to actually heal something (docs/179, 2026-08-02) ----
  //
  // Production ran six `auth healed` events across three sessions in six hours
  // with ZERO `[claude-oauth-refresh]` log lines beside them, and four of the
  // six were followed by a surfaced failure anyway. Every heal was a no-op:
  // `ensureFresh` short-circuited on the SOURCE token's `expiresAt`, which
  // still had margin, so the turn was re-dispatched ~120ms later on
  // byte-identical credentials. Two things make the retry mean something now —
  // the heal is forced (expiry is not evidence when a live 401 says otherwise),
  // and the source token is force-pushed into the session, bypassing the
  // per-turn sync-in guard that refuses to overwrite a dead-but-later-dated
  // copy.

  it("forces the heal rather than letting it short-circuit on source expiry", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(true);
    const { deps } = makeDeps(agents, ensureAgentTokenFresh);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);
    await waitFor(() => agents.length === 2, "re-dispatched agent");

    expect(ensureAgentTokenFresh).toHaveBeenCalledWith("claude", undefined, { force: true });

    runner.dispose({ force: true });
  });

  it("force-pushes the source token into the session BEFORE the healed retry spawns", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(true);
    const { deps } = makeDeps(agents, ensureAgentTokenFresh);
    const repushed: { sessionId: string; agentId: AgentId; agentsAtCall: number }[] = [];
    deps.repushSessionAgentToken = (sessionId, agentId) => {
      repushed.push({ sessionId, agentId, agentsAtCall: agents.length });
    };
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "healed retry");

    // Ordering matters: the retry's env-prep runs the guarded sync-in, so the
    // unconditional push has to land before the second agent is created.
    expect(repushed).toEqual([{ sessionId: "s1", agentId: "claude", agentsAtCall: 1 }]);

    runner.dispose({ force: true });
  });

  it("does not repush when the heal failed (no retry to prepare for)", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const messages: { type: string }[] = [];
    runner.on("message", (m) => messages.push(m as never));
    const { deps } = makeDeps(agents, vi.fn().mockResolvedValue(false));
    const repush = vi.fn();
    deps.repushSessionAgentToken = repush;
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);
    await waitFor(() => messages.some((m) => m.type === "error"), "re-auth error surfaced");

    expect(repush).not.toHaveBeenCalled();

    runner.dispose({ force: true });
  });

  // The other half of the incident: even when a viewer WAS attached, the
  // sign-in notice was emit-only, so it vanished on the next session switch or
  // reload. With no viewer attached — the production case, twice — it reached
  // nobody at all and the user was left with a prompt and no reply.
  it("leaves the surfaced sign-in notice in durable chat history", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps } = makeDeps(agents, vi.fn().mockResolvedValue(false));
    let durableHistory: any[] = [];
    const history = deps.listenerDeps.chatHistoryManager as any;
    history.replaceInProgress = vi.fn((_sid: string, messages: any[]) => {
      durableHistory = [...durableHistory.filter((m) => !m.inProgress), ...messages];
    });
    history.finalizeInProgress = vi.fn(() => {
      durableHistory = durableHistory.map((m) => ({ ...m, inProgress: false }));
    });
    history.append = vi.fn((_sid: string, message: any) => { durableHistory.push(message); });
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);
    await waitFor(() => durableHistory.some((m) => m.isError), "durable sign-in notice");

    const notice = durableHistory.find((m) => m.isError);
    expect(String(notice.text)).toContain("Settings → Agents");
    // Finalized, so the next turn's `replaceInProgress` can't delete it.
    expect(durableHistory.every((m) => !m.inProgress)).toBe(true);
    // And exactly one error row — the generic "ended without a response" is
    // suppressed on the auth path rather than sitting beside it unpersisted.
    expect(durableHistory.filter((m) => m.isError)).toHaveLength(1);

    runner.dispose({ force: true });
  });

  // docs/260 — with several accounts per provider, the heal has to name the
  // account this TURN ran on (the captured route). Provider-wide,
  // `ensureAgentTokenFresh` refreshes every account and returns
  // `results.every(Boolean)`, so a second account that is revoked (or was
  // never signed in) makes the aggregate false and a healthy account's turn
  // gets a sign-in card it did not need.
  it("heals the account the turn ran on, not the whole provider", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    // Stands in for the real healer: account-scoped calls heal, a
    // provider-wide call reports failure because a sibling account is revoked.
    const ensureAgentTokenFresh = vi.fn(
      async (_agentId: AgentId, accountId?: string) => accountId === "acct_healthy",
    );
    const { deps, startOAuthFlow } = makeDeps(
      agents,
      ensureAgentTokenFresh as unknown as SystemTurnDeps["ensureAgentTokenFresh"],
      { kind: "account", id: "acct_healthy" },
    );
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);

    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "re-dispatched agent run");
    expect(ensureAgentTokenFresh).toHaveBeenCalledWith("claude", "acct_healthy", { force: true });
    // Quiet recovery — the revoked sibling never entered the picture.
    expect(startOAuthFlow).not.toHaveBeenCalled();

    runner.dispose({ force: true });
  });

  // docs/260 — a turn that ran on a reserved route (`claude-api-key`,
  // `claude-env-oauth`) has no account token of its own. Rotating every
  // *subscription* account and reporting the aggregate answers a question
  // nobody asked: a bad API key would read as healed because the subscriptions
  // are fine. Don't heal; let the 401 surface.
  it("does not heal a reserved-route turn off other accounts' tokens", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const messages: { type: string; [k: string]: unknown }[] = [];
    runner.on("message", (m) => messages.push(m as never));
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(true);
    const { deps } = makeDeps(
      agents,
      ensureAgentTokenFresh,
      // The turn ran on `claude-api-key` — not an account.
      { kind: "reserved", id: "claude-api-key" },
    );
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);
    await waitFor(() => messages.some((m) => m.type === "error"), "re-auth error surfaced");

    // No OAuth refresh was attempted, and no silent re-dispatch happened.
    expect(ensureAgentTokenFresh).not.toHaveBeenCalled();
    expect(agents).toHaveLength(1);

    runner.dispose({ force: true });
  });

  it("clears a rejected resume id and re-dispatches the same turn once as a fresh conversation", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps } = makeDeps(agents, undefined);
    let agentSessionId: string | undefined = "rejected-resume-id";
    const sessionManager = deps.listenerDeps.sessionManager as any;
    sessionManager.get = vi.fn(() => ({ id: "s1", agentId: "claude", agentSessionId }));
    sessionManager.clearAgentSessionId = vi.fn(() => { agentSessionId = undefined; });
    sessionManager.setAgentSessionId = vi.fn((_sid: string, next: string) => { agentSessionId = next; });
    deps.buildRunParams = vi.fn(async () => ({
      prompt: "do work",
      cwd: "/tmp/s1",
      ...(agentSessionId ? { sessionId: agentSessionId } : {}),
    }));
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "resumed run");
    expect(agents[0]!.run).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "rejected-resume-id" }));

    agents[0]!.emit("log", "stderr", "No conversation found with session ID: rejected-resume-id");
    agents[0]!.emit("done", 1);
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "fresh-conversation retry");
    expect(sessionManager.clearAgentSessionId).toHaveBeenCalledWith("s1");
    expect(agents[1]!.run.mock.calls[0]![0]).not.toHaveProperty("sessionId");

    agents[1]!.emit("event", { type: "agent_init", agentId: "claude", sessionId: "fresh-session-id", tools: [] });
    agents[1]!.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "Recovered" }] });
    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "fresh-session-id" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "recovered turn finished");
    expect(agentSessionId).toBe("fresh-session-id");
    expect(agents).toHaveLength(2);

    runner.dispose({ force: true });
  });

  it("keeps first-attempt output durable when the fresh-conversation retry fails empty", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps } = makeDeps(agents, undefined);
    let agentSessionId: string | undefined = "rejected-resume-id";
    let durableHistory: any[] = [];
    const sessionManager = deps.listenerDeps.sessionManager as any;
    sessionManager.get = vi.fn(() => ({ id: "s1", agentId: "claude", agentSessionId }));
    sessionManager.clearAgentSessionId = vi.fn(() => { agentSessionId = undefined; });
    sessionManager.setAgentSessionId = vi.fn((_sid: string, next: string) => { agentSessionId = next; });
    const history = deps.listenerDeps.chatHistoryManager as any;
    history.replaceInProgress = vi.fn((_sid: string, messages: any[]) => {
      durableHistory = [...durableHistory.filter((m) => !m.inProgress), ...messages];
    });
    history.finalizeInProgress = vi.fn(() => {
      durableHistory = durableHistory.map((m) => ({ ...m, inProgress: false }));
    });
    history.append = vi.fn((_sid: string, message: any) => { durableHistory.push(message); });
    deps.buildRunParams = vi.fn(async () => ({
      prompt: "do work",
      cwd: "/tmp/s1",
      ...(agentSessionId ? { sessionId: agentSessionId } : {}),
    }));
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "resumed run");
    agents[0]!.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "Work already shown" }] });
    agents[0]!.emit("log", "stderr", "No conversation found with session ID: rejected-resume-id");
    agents[0]!.emit("done", 1);
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "fresh retry");

    // The bounded retry fails before producing any content. Its error-path
    // replace only touches in-progress rows, so the finalized first attempt is
    // still present when history is reloaded from durable storage.
    agents[1]!.emit("error", new Error("fresh retry failed"));
    await waitFor(() => durableHistory.some((m) => m.isError), "durable retry error");
    expect(durableHistory.map((m) => m.text)).toContain("Work already shown");
    expect(durableHistory.some((m) => String(m.text).includes("fresh retry failed"))).toBe(true);
    expect(durableHistory.every((m) => !m.inProgress)).toBe(true);
    expect(agents).toHaveLength(2);

    runner.dispose({ force: true });
  });
});
