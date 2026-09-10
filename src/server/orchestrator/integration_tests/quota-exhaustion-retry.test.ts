import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { SessionRunner } from "../session-runner.js";
import type { SystemTurnDeps } from "../session-runner.js";
import type { AgentId } from "../../shared/types.js";
import { ProviderRouteUnavailableError } from "../provider-route-preflight.js";
import { testDispatch } from "./dispatch-test-helpers.js";
import { allRefusedMessage } from "../turn-executor.js";

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
        setMuted: vi.fn(),
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
    routeLabel: (routeId: string) => ROUTE_LABELS[routeId],
  };
  return { deps, prepareAgentEnv, persistUserRow, autoCommit };
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
