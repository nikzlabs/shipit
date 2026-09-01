/**
 * docs/252 phase 5, req 12 — the same-turn quota failover, gated on the billing
 * mode and reachable from BOTH terminal shapes.
 *
 * Two holes this pins shut, both found by reading the code rather than by a
 * failing report:
 *
 *  - **The retry had no billing-mode gate.** Account benching checks the route
 *    kind and bails for a metered one; this retry fired on any detected
 *    exhaustion. On a key there is nowhere to fail over to, so the turn was
 *    re-run in full against the credential that had just refused it, repeating
 *    every side effect the first attempt had.
 *  - **It watched `agent_result` only.** Codex reports a spent subscription by
 *    refusing `turn/start`, and a rejected JSON-RPC request becomes an
 *    adapter-level `error` — so a Codex subscription running out mid-turn
 *    reached neither the retry nor the exhaustion stamp.
 *
 * Drives the real executor in-process with a fake agent, as `turn-crash-commit`
 * does. The observable is the agent factory's call count: a retry re-dispatches
 * on a FRESH agent, so a second call is a failover and one call is a stop.
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
import type { AgentId, SessionInfo } from "../shared/types.js";

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

async function waitFor(fn: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await flush();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/**
 * The reset instant must stay in the FUTURE forever, hence 2099 — the same
 * literal every sibling quota fixture uses. `resolveResetAt` accepts a stated
 * reset only while `parsed > now` (a past one describes the window that just
 * ended), so a near-future date does not fail loudly when it arrives: the
 * detector quietly reports `resetAt: null` and the stamp becomes
 * `now + UNKNOWN_RESET_LOCKOUT_MS`. This fixture said 2026-09-01 and broke CI on
 * 2026-09-01, nine hours after midnight UTC.
 */
const RESET_AT = "2099-01-01T00:00:00.000Z";
const EXHAUSTED = `You've hit your weekly usage limit. It resets at ${RESET_AT}.`;

describe("same-turn quota failover (docs/252 phase 5, req 12)", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "shi321-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "T"], { cwd: repoDir, stdio: "pipe" });
    fs.writeFileSync(path.join(repoDir, "file.txt"), "base\n");
    execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: repoDir, stdio: "pipe" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  function harness(session: Partial<SessionInfo>) {
    const agents: FakeAgent[] = [];
    const markSessionAccountExhausted = vi.fn();
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const deps: SystemTurnDeps = {
      agentFactory: () => {
        const a = makeFakeAgent();
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      autoCommit: async () => ({ committed: false, parentHash: null }) as never,
      scheduleAutoPush: vi.fn(),
      listenerDeps: {
        sessionManager: {
          setAgentSessionId: vi.fn(),
          setLastTurnErrored: vi.fn(),
          get: vi.fn(() => ({ id: "s1", agentId: "claude", ...session })),
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
        markSessionAccountExhausted,
      },
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };
    return { agents, deps, runner, markSessionAccountExhausted };
  }

  const start = (runner: SessionRunner, deps: SystemTurnDeps, agent: FakeAgent) =>
    executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "do work",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext: async () => {},
      emit: () => {},
      useStreaming: true,
    });

  it("does NOT retry a turn billed to a metered key", async () => {
    const session = { billingMode: "key", providerRouteBillingMode: "key", serviceId: "deepseek" };
    const { agents, deps, runner } = harness(session as Partial<SessionInfo>);
    const first = makeFakeAgent();

    await start(runner, deps, first);
    first.emit("event", { type: "agent_result", status: "error", error: EXHAUSTED });
    await waitFor(() => !runner.running, "turn settled");

    // No fresh agent was ever built: the turn retired with the provider's own
    // error instead of being re-run against the same bad key.
    expect(agents).toHaveLength(0);
    runner.dispose({ force: true });
  });

  it("retries once for a subscription, as it does today", async () => {
    const session = { billingMode: "sub", providerRouteBillingMode: "sub", serviceId: "anthropic" };
    const { agents, deps, runner } = harness(session as Partial<SessionInfo>);
    const first = makeFakeAgent();

    await start(runner, deps, first);
    first.emit("event", { type: "agent_result", status: "error", error: EXHAUSTED });
    await waitFor(() => agents.length === 1, "retry dispatched");

    expect(first.kill).toHaveBeenCalled();
    runner.dispose({ force: true });
  });

  it("captures quota ownership after environment preparation moves the route", async () => {
    const oldSession = {
      billingMode: "sub",
      providerRouteBillingMode: "sub",
      serviceId: "anthropic",
      providerRouteKind: "account",
      providerRouteId: "acct-old",
    } as Partial<SessionInfo>;
    const { deps, runner } = harness(oldSession);
    // docs/260 §1b — the captured route is env-prep's RETURNED turn route, a
    // value, never a session row re-read.
    deps.prepareAgentEnv = vi.fn(async () => ({
      turnRoute: { kind: "account" as const, id: "acct-new" },
    }));
    const recordAgentRateLimits = vi.fn();
    deps.listenerDeps.recordAgentRateLimits = recordAgentRateLimits;
    const first = makeFakeAgent();

    await start(runner, deps, first);
    first.emit("event", {
      type: "agent_rate_limits",
      session: { usedPct: 5, resetAt: "2026-09-01T00:00:00.000Z" },
      weekly: { usedPct: 7, resetAt: "2026-09-07T00:00:00.000Z" },
    });

    expect(recordAgentRateLimits).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ usedPct: 5 }),
      expect.objectContaining({ usedPct: 7 }),
      "s1",
      "acct-new",
    );
    runner.dispose({ force: true });
  });

  it("fails over from an adapter-level error too, and benches the credential", async () => {
    // The Codex shape: a rejected `turn/start` never produces an `agent_result`.
    const session = { billingMode: "sub", providerRouteBillingMode: "sub", serviceId: "openai" };
    const { agents, deps, runner, markSessionAccountExhausted } = harness(session as Partial<SessionInfo>);
    const first = makeFakeAgent();

    await start(runner, deps, first);
    first.emit("error", new Error(`JSON-RPC error -32000: ${EXHAUSTED}`));
    await waitFor(() => agents.length === 1, "retry dispatched from the error path");

    // Stamped here rather than in `agent-listeners`, which only stamps on
    // `agent_result` — without it the retry re-selects the spent credential.
    expect(markSessionAccountExhausted).toHaveBeenCalledWith(
      "s1",
      Date.parse(RESET_AT),
      undefined,
    );
    runner.dispose({ force: true });
  });

  it("does not fail over from an adapter error on a metered key", async () => {
    const session = { billingMode: "key", providerRouteBillingMode: "key", serviceId: "deepseek" };
    const { agents, deps, runner, markSessionAccountExhausted } = harness(session as Partial<SessionInfo>);
    const first = makeFakeAgent();

    await start(runner, deps, first);
    first.emit("error", new Error(`JSON-RPC error -32000: ${EXHAUSTED}`));
    await waitFor(() => !runner.running, "turn settled");

    expect(agents).toHaveLength(0);
    expect(markSessionAccountExhausted).not.toHaveBeenCalled();
    runner.dispose({ force: true });
  });

  it("finalizes the first attempt's output before the retry resets the accumulators", async () => {
    // The `agent_result` path gets this from `wireAgentListeners`, which runs
    // its own handler first. This gate runs at the TOP of the listener's error
    // handler — ahead of the persistence it stands the listener down from — so
    // without an explicit finalize a retry that fails before producing output
    // rebuilds history from empty groups and deletes what the user already saw.
    const session = { billingMode: "sub", providerRouteBillingMode: "sub", serviceId: "openai" };
    const { agents, deps, runner } = harness(session as Partial<SessionInfo>);
    const first = makeFakeAgent();

    await start(runner, deps, first);
    first.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "partial work" }],
    });
    first.emit("error", new Error(`JSON-RPC error -32000: ${EXHAUSTED}`));
    await waitFor(() => agents.length === 1, "retry dispatched");

    const history = deps.listenerDeps.chatHistoryManager;
    expect(history.replaceInProgress).toHaveBeenCalledWith("s1", expect.any(Array));
    expect(history.finalizeInProgress).toHaveBeenCalledWith("s1");
    runner.dispose({ force: true });
  });

  it("leaves an ordinary process error alone", async () => {
    const session = { billingMode: "sub", providerRouteBillingMode: "sub", serviceId: "anthropic" };
    const { agents, deps, runner } = harness(session as Partial<SessionInfo>);
    const first = makeFakeAgent();

    await start(runner, deps, first);
    first.emit("error", new Error("spawn ENOENT"));
    await waitFor(() => !runner.running, "turn settled");

    expect(agents).toHaveLength(0);
    runner.dispose({ force: true });
  });
});
