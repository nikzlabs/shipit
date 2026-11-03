import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { SessionRunner } from "../session-runner.js";
import type { SystemTurnDeps } from "../session-runner.js";
import type { AgentId } from "../../shared/types.js";
import { ProviderRouteUnavailableError } from "../provider-route-preflight.js";
import { testDispatch } from "./dispatch-test-helpers.js";
import { allRefusedMessage } from "../turn-executor.js";
import { buildAccountFailoverNote, buildParkedFailoverNotice } from "../account-failover-note.js";
import type { TurnOutcome } from "../turn-settlement.js";

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
  appendPendingAgentNotice: ReturnType<typeof vi.fn>;
} {
  const prepareAgentEnv = vi.fn().mockResolvedValue(undefined);
  const persistUserRow = vi.fn();
  const appendPendingAgentNotice = vi.fn();
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
        touchUnlessResolved: vi.fn(),
        setMuted: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        appendPendingAgentNotice,
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
    buildRunParams: vi.fn(async (_sessionId: string, _agentId: AgentId, prompt: string) => ({ prompt, cwd: "/tmp/s1" })),
    routeLabel: (routeId: string) => ROUTE_LABELS[routeId],
  };
  return { deps, prepareAgentEnv, persistUserRow, autoCommit, appendPendingAgentNotice };
}

/** What each attempt's agent was started with. */
function runPrompts(agents: FakeAgent[]): (string | undefined)[] {
  return agents.map((agent) => (agent.run.mock.calls[0]?.[0] as { prompt?: string } | undefined)?.prompt);
}

const ROUTE_LABELS: Record<string, string> = {
  "acct-1": "Personal",
  "acct-2": "Work",
};

function selectionOverTwoAccounts(prepareAgentEnv: ReturnType<typeof vi.fn>): void {
  prepareAgentEnv.mockImplementation(
    async (_sessionId: string, _agentId: AgentId, opts?: { excludeRouteIds?: readonly string[] }) => {
      const excluded = opts?.excludeRouteIds ?? [];
      const next = Object.keys(ROUTE_LABELS).find((id) => !excluded.includes(id));
      if (!next) {
        throw new ProviderRouteUnavailableError("claude" as AgentId, {
          reason: "all_exhausted",
          earliestResetAt: null,
        });
      }
      return { turnRoute: { kind: "account" as const, id: next } };
    },
  );
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
// Captured CLI notice, delivered as assistant text.
const QUOTA_NOTICE_TEXT = "You've hit your session limit · resets 5:10pm (UTC)";

describe("same-turn quota failover (docs/150-multiple-provider-subscriptions req 14)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("preserves quota details when the attempt ledger also contains an auth failure", () => {
    const message = allRefusedMessage([
      {
        routeId: "acct-1",
        label: "Personal",
        providerMessage: QUOTA_ERROR,
        resetAt: "2099-01-01T00:00:00.000Z",
        failureKind: "quota",
      },
      {
        routeId: "acct-2",
        label: "Work",
        providerMessage: "Authentication failed",
        resetAt: null,
        failureKind: "auth",
      },
    ]);

    expect(message).toContain("Personal");
    expect(message).toContain(QUOTA_ERROR);
    expect(message).toContain("2099-01-01T00:00:00.000Z");
    expect(message).toContain("Authentication failed for: Work");
    expect(message).not.toContain("Authentication failed for: Personal");
  });

  it("re-runs the turn once on a fresh agent when the provider reports exhaustion", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps, prepareAgentEnv } = makeDeps(agents);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });

    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");
    expect(agents[0]!.kill).toHaveBeenCalled();
    expect(prepareAgentEnv).toHaveBeenCalledTimes(2);

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");

    runner.dispose({ force: true });
  });

  it("tries each account once, then fails with the ledger-built all-refused report (docs/260-turn-level-account-routing reqs 6, 12)", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps, prepareAgentEnv, persistUserRow } = makeDeps(agents);
    selectionOverTwoAccounts(prepareAgentEnv);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "second account's attempt");
    expect(prepareAgentEnv.mock.calls[1]?.[2]?.excludeRouteIds).toEqual(["acct-1"]);

    agents[1]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");

    expect(agents).toHaveLength(3);
    expect(agents[2]!.run).not.toHaveBeenCalled();
    expect(prepareAgentEnv.mock.calls[2]?.[2]?.excludeRouteIds).toEqual(["acct-1", "acct-2"]);

    const errorRow = persistUserRow.mock.calls
      .map((call) => call[1] as { text?: string; isError?: boolean } | undefined)
      .find((row) => row?.isError === true);
    expect(errorRow?.text).toContain("Every connected account refused this turn for quota");
    expect(errorRow?.text).toContain("Personal");
    expect(errorRow?.text).toContain("Work");
    expect(errorRow?.text).toContain("resets at 2099-01-01T00:00:00.000Z");
    expect(errorRow?.text).toContain("usage limit");
    expect(runner.lastTurnErrored).toBe(true);

    runner.dispose({ force: true });
  });

  it("settles a turn that every account refused with the resets they stated, so its owner can wait (docs/306-quota-continuation)", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps, prepareAgentEnv } = makeDeps(agents);
    selectionOverTwoAccounts(prepareAgentEnv);
    runner.setSystemTurnDeps(deps);
    const outcomes: TurnOutcome[] = [];

    runner.dispatch(testDispatch({ text: "do work", onTurnComplete: (outcome) => outcomes.push(outcome) }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");
    agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "second account's attempt");
    agents[1]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => outcomes.length === 1, "settlement");

    expect(outcomes[0]).toMatchObject({
      status: "errored",
      quotaRefused: { resetsAt: ["2099-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"] },
    });
    runner.dispose({ force: true });
  });

  it("does not ask the user to send again a message that ShipIt started (docs/306-quota-continuation req 3)", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps, prepareAgentEnv, persistUserRow } = makeDeps(agents);
    selectionOverTwoAccounts(prepareAgentEnv);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "Your PR merged", automatic: true }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");
    agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "second account's attempt");
    agents[1]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");

    const errorRow = persistUserRow.mock.calls
      .map((call) => call[1] as { text?: string; isError?: boolean } | undefined)
      .find((row) => row?.isError === true);
    expect(errorRow?.text).toContain("Every connected account refused this turn for quota");
    expect(errorRow?.text).not.toMatch(/send this message again|resend/i);
    expect(allRefusedMessage([
      { routeId: "acct-2", label: "Work", providerMessage: "Authentication failed", resetAt: null, failureKind: "auth" },
    ], { automatic: true })).not.toMatch(/resend/i);
    runner.dispose({ force: true });
  });

  it("does not call a turn quota-refused when no account was there to refuse it", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps, prepareAgentEnv } = makeDeps(agents);
    prepareAgentEnv.mockRejectedValue(
      new ProviderRouteUnavailableError("claude" as AgentId, { reason: "all_exhausted", earliestResetAt: null }),
    );
    runner.setSystemTurnDeps(deps);
    const outcomes: TurnOutcome[] = [];

    runner.dispatch(testDispatch({ text: "do work", onTurnComplete: (outcome) => outcomes.push(outcome) }));
    await waitFor(() => outcomes.length === 1, "settlement");

    expect(outcomes[0]?.status).toBe("errored");
    expect(outcomes[0]?.quotaRefused).toBeUndefined();
    runner.dispose({ force: true });
  });

  it("adds no transcript row and no echo for a prompt that an earlier attempt showed (docs/306-quota-continuation)", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps, persistUserRow } = makeDeps(agents);
    runner.setSystemTurnDeps(deps);
    const emitted = vi.spyOn(runner, "emitMessage");

    runner.dispatch(testDispatch({ text: "do work", promptShown: true }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "agent run");
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");

    expect(vi.mocked(deps.buildRunParams).mock.calls[0]?.[2]).toContain("do work");
    const userRows = persistUserRow.mock.calls.filter((call) => (call[1] as { role?: string }).role === "user");
    expect(userRows).toEqual([]);
    expect(emitted.mock.calls.some(([message]) => message.type === "system_user_message")).toBe(false);
    runner.dispose({ force: true });
  });

  it("does not signal idle before the errored turn's post-turn commit has run", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps, autoCommit } = makeDeps(agents);
    runner.setSystemTurnDeps(deps);

    let committedWhenIdle: number | null = null;
    runner.on("idle", () => { committedWhenIdle = autoCommit.mock.calls.length; });

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");

    agents[1]!.emit("error", new Error("turn blocked: no eligible account"));
    await waitFor(() => committedWhenIdle !== null, "idle signal");

    expect(committedWhenIdle).toBeGreaterThan(0);

    runner.dispose({ force: true });
  });

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
    expect(autoCommit).not.toHaveBeenCalled();

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");

    runner.dispose({ force: true });
  });

  it("ends errored on the all-refused report, not successful, when every account hits the limit in text (docs/260-turn-level-account-routing req 6)", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps, prepareAgentEnv, persistUserRow } = makeDeps(agents);
    selectionOverTwoAccounts(prepareAgentEnv);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: QUOTA_NOTICE_TEXT }],
    });
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "second account's attempt");

    agents[1]!.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: QUOTA_NOTICE_TEXT }],
    });
    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");

    expect(agents).toHaveLength(3);
    expect(agents[2]!.run).not.toHaveBeenCalled();
    expect(runner.lastTurnErrored).toBe(true);
    const errorRow = persistUserRow.mock.calls
      .map((call) => call[1] as { text?: string; isError?: boolean } | undefined)
      .find((row) => row?.isError === true);
    expect(errorRow?.text).toContain("Every connected account refused this turn for quota");
    expect(errorRow?.text).toContain(QUOTA_NOTICE_TEXT);

    runner.dispose({ force: true });
  });

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

  // planning#712 — the retry's own turn start clears the task list (planning#710), so the note
  // must have read it before.
  for (const streaming of [true, false]) {
    it(`names the refused process's background tasks in a note before the replayed prompt (${streaming ? "streaming" : "one-shot"})`, async () => {
      const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
      const agents: FakeAgent[] = [];
      const { deps } = makeDeps(agents);
      if (streaming) deps.steerInputs = () => ({ liveSteering: true, steeringCapable: true });
      runner.setSystemTurnDeps(deps);

      runner.dispatch(testDispatch({ text: "do work" }));
      await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");
      agents[0]!.emit("event", { type: "agent_background_tasks", tasks: [{ id: "t1", description: "npm run e2e" }] });
      agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
      await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");

      const prompts = runPrompts(agents);
      expect(prompts[0]).not.toContain(buildAccountFailoverNote([]));
      expect(prompts[1]).toBe(`${buildAccountFailoverNote(["npm run e2e"])}\n\n${prompts[0]}`);
      expect(runner.backgroundWorkDescriptions).toEqual([]);

      agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
      agents[1]!.emit("done", 0);
      await waitFor(() => !runner.running, "turn finished");
      runner.dispose({ force: true });
    });
  }

  // One note per attempt, never two stacked. Its tasks are carried on until a CLI echoes the
  // note back: before that, the conversation the next attempt resumes may not hold it.
  for (const [label, echoed, named] of [
    ["carries the earlier tasks when the refused attempt's CLI never echoed its note", false, ["first job", "second job"]],
    ["names only the newest tasks once the CLI has echoed the earlier note", true, ["second job"]],
  ] as const) {
    it(label, async () => {
      const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
      const agents: FakeAgent[] = [];
      const { deps } = makeDeps(agents);
      deps.steerInputs = () => ({ liveSteering: true, steeringCapable: true });
      runner.setSystemTurnDeps(deps);

      runner.dispatch(testDispatch({ text: "do work" }));
      await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");
      agents[0]!.emit("event", { type: "agent_background_tasks", tasks: [{ id: "t1", description: "first job" }] });
      agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
      await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "second attempt");
      if (echoed) agents[1]!.emit("event", { type: "agent_user_replay", text: runPrompts(agents)[1] });
      agents[1]!.emit("event", { type: "agent_background_tasks", tasks: [{ id: "t2", description: "second job" }] });
      agents[1]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
      await waitFor(() => agents.length === 3 && agents[2]!.run.mock.calls.length === 1, "third attempt");

      const prompts = runPrompts(agents);
      expect(prompts[2]).toBe(`${buildAccountFailoverNote(named)}\n\n${prompts[0]}`);

      agents[2]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
      agents[2]!.emit("done", 0);
      await waitFor(() => !runner.running, "turn finished");
      runner.dispose({ force: true });
    });
  }

  it("swaps the current status card into the replayed prompt behind the note (docs/303 req 35)", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps } = makeDeps(agents);
    let card = "<session_status_card>before</session_status_card>";
    deps.sessionStatusContext = () => card;
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");
    card = "<session_status_card>after</session_status_card>";
    agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");

    const prompts = runPrompts(agents);
    expect(prompts[0]).toContain("before");
    expect(prompts[1]).toBe(
      `${buildAccountFailoverNote([])}\n\n${prompts[0]!.replace("before", "after")}`,
    );

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");
    runner.dispose({ force: true });
  });

  it("keeps a slash command first in the replayed prompt, with the note after it", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps } = makeDeps(agents);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "/code-review high" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");
    agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");

    const prompts = runPrompts(agents);
    expect(prompts[0]).toBe("/code-review high");
    expect(prompts[1]).toBe(`/code-review high\n\n${buildAccountFailoverNote([])}`);

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");
    runner.dispose({ force: true });
  });

  it("leaves a compaction's prompt whole and parks the note for the next turn", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps, appendPendingAgentNotice } = makeDeps(agents);
    deps.steerInputs = () => ({ liveSteering: true, steeringCapable: true });
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "/compact" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");
    agents[0]!.emit("event", { type: "agent_background_tasks", tasks: [{ id: "t1", description: "npm run e2e" }] });
    agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");

    const prompts = runPrompts(agents);
    expect(prompts[0]).toBe("/compact");
    expect(prompts[1]).toBe(prompts[0]);
    expect(appendPendingAgentNotice).toHaveBeenCalledWith("s1", buildParkedFailoverNotice(["npm run e2e"]));

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");
    runner.dispose({ force: true });
  });

  it("leaves drain and commit to the retry, not the exhausted attempt", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps, autoCommit } = makeDeps(agents);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");

    expect(autoCommit).not.toHaveBeenCalled();
    expect(runner.running).toBe(true);

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");
    // The commit can finish after running clears.
    await waitFor(() => autoCommit.mock.calls.length > 0, "retry committed");

    runner.dispose({ force: true });
  });
});
