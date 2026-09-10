import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { SessionRunner } from "../session-runner.js";
import type { SystemTurnDeps } from "../session-runner.js";
import type { AgentId } from "../../shared/types.js";
import { testDispatch } from "./dispatch-test-helpers.js";

vi.mock("node:child_process", async () => {
  // eslint-disable-next-line no-restricted-syntax -- vitest's blessed form
  const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...real, spawn: vi.fn() };
});

import * as childProcess from "node:child_process";
import { StreamingClaudeProcess } from "../../session/agents/claude/process.js";

const mockChildSpawn = vi.mocked(childProcess.spawn);

// Captured from one unauthenticated Claude CLI 2.1.219 run: two events, one failure.
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

function feedRealCliOutput(agent: FakeAgent): (raw: string) => void {
  const stdout = new EventEmitter();
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
  proc.stdout = stdout;
  proc.stderr = new EventEmitter();
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

function makeDeps(
  agents: FakeAgent[],
  ensureAgentTokenFresh: SystemTurnDeps["ensureAgentTokenFresh"],
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
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(true);
    const { deps, startOAuthFlow } = makeDeps(agents, ensureAgentTokenFresh);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);

    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "re-dispatched agent run");
    expect(ensureAgentTokenFresh).toHaveBeenCalledTimes(1);
    expect(agents[0]!.kill).toHaveBeenCalled();

    expect(messages.some((m) => m.type === "auth_required")).toBe(false);
    expect(startOAuthFlow).not.toHaveBeenCalled();

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");
    expect(agents).toHaveLength(2);

    runner.dispose({ force: true });
  });

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

    const feed = feedRealCliOutput(agents[0]!);
    feed(REAL_AUTH_FAILURE_NDJSON);
    agents[0]!.emit("done", 0);

    await waitFor(() => agents.length >= 2 && agents[1]!.run.mock.calls.length === 1, "re-dispatched agent run");
    for (let i = 0; i < 20; i++) await flush();

    expect(ensureAgentTokenFresh).toHaveBeenCalledTimes(1);
    expect(agents).toHaveLength(2);
    expect(agents[1]!.run).toHaveBeenCalledTimes(1);
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
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(false);
    const { deps, sseBroadcast, startOAuthFlow } = makeDeps(agents, ensureAgentTokenFresh);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);

    await waitFor(() => messages.some((m) => m.type === "error"), "re-auth error surfaced");
    expect(ensureAgentTokenFresh).toHaveBeenCalledTimes(1);
    expect(startOAuthFlow).not.toHaveBeenCalled();
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

    agents[1]!.emit("auth_required");
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "bounded auth failure");
    expect(agents).toHaveLength(2);
    expect(prepareAgentEnv).toHaveBeenCalledTimes(2);
    expect(selectedRoutes).toEqual(["acct-a", "acct-b"]);
    runner.dispose({ force: true });
  });

  it("a late `done` does not release the failed-heal sequence's reclaim hold", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(false);
    const { deps } = makeDeps(agents, ensureAgentTokenFresh);
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((r) => { releaseCommit = r; });
    deps.autoCommit = vi.fn().mockImplementation(async () => {
      await commitGate;
      return { commitHash: null, parentHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [] };
    });
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("auth_required");
    await waitFor(() => (deps.autoCommit as ReturnType<typeof vi.fn>).mock.calls.length === 1, "commit started");
    expect(runner.postTurnWorkInFlight).toBe(true);
    expect(runner.agentBusy).toBe(true);

    agents[0]!.emit("done", 0);
    await flush();
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

    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "re-dispatched agent run");

    agents[1]!.emit("auth_required");
    agents[1]!.emit("done", 0);
    await waitFor(() => messages.some((m) => m.type === "error"), "re-auth error on the retry");

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
    expect(durableHistory.every((m) => !m.inProgress)).toBe(true);
    expect(durableHistory.filter((m) => m.isError)).toHaveLength(1);

    runner.dispose({ force: true });
  });

  it("heals the account the turn ran on, not the whole provider", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
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
    expect(startOAuthFlow).not.toHaveBeenCalled();

    runner.dispose({ force: true });
  });

  it("does not heal a reserved-route turn off other accounts' tokens", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const messages: { type: string; [k: string]: unknown }[] = [];
    runner.on("message", (m) => messages.push(m as never));
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(true);
    const { deps } = makeDeps(
      agents,
      ensureAgentTokenFresh,
      { kind: "reserved", id: "claude-api-key" },
    );
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);
    await waitFor(() => messages.some((m) => m.type === "error"), "re-auth error surfaced");

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

    agents[1]!.emit("error", new Error("fresh retry failed"));
    await waitFor(() => durableHistory.some((m) => m.isError), "durable retry error");
    expect(durableHistory.map((m) => m.text)).toContain("Work already shown");
    expect(durableHistory.some((m) => String(m.text).includes("fresh retry failed"))).toBe(true);
    expect(durableHistory.every((m) => !m.inProgress)).toBe(true);
    expect(agents).toHaveLength(2);

    runner.dispose({ force: true });
  });
});
