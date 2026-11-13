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

// docs/342-transient-provider-retry — the executor's half: it reports the error, never re-sends
// the prompt, and leaves auth alone. The manager's half is in services/quota-continuation.test.ts.

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

async function waitFor(fn: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// Claude Code's words for the 2026-11-13 block page, and OpenCode 2's notice for it (#3351).
const CLAUDE_CODE_403 = "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare";
const OPENCODE2_403 =
  "Anthropic's edge blocked this request: Cloudflare at api.anthropic.com answered with a 403 block page, "
  + "so this turn stopped. Signing in again will not help. Sending your message again later usually works.";

describe("a temporary provider error ends a turn (docs/342-transient-provider-retry)", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "transient-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  function harness(opts: { record?: boolean } = {}) {
    const agents: FakeAgent[] = [];
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const recordTransientProviderError = vi.fn(() => ({ retries: true }));
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(true);
    const onAgentAuthRequired = vi.fn();
    const deps: SystemTurnDeps = {
      agentFactory: () => {
        const a = makeFakeAgent();
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      autoCommit: async () => ({ committed: false, parentHash: null }) as never,
      scheduleAutoPush: vi.fn(),
      ensureAgentTokenFresh,
      ...(opts.record === false ? {} : { recordTransientProviderError }),
      listenerDeps: {
        sessionManager: {
          setAgentSessionId: vi.fn(),
          setLastTurnErrored: vi.fn(),
          get: vi.fn(() => ({ id: "s1", agentId: "claude" })),
          track: vi.fn(),
          touchUnlessResolved: vi.fn(),
          setMuted: vi.fn(),
          list: vi.fn().mockReturnValue([]),
          appendPendingAgentNotice: vi.fn(),
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
        onAgentAuthRequired,
      },
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };
    const start = (agent: FakeAgent, deliveryId?: string) =>
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
        useStreaming: false,
        ...(deliveryId ? { deliveryId } : {}),
      });
    return { agents, runner, deps, start, recordTransientProviderError, ensureAgentTokenFresh, onAgentAuthRequired };
  }

  it.each([
    ["Claude Code", CLAUDE_CODE_403, "edge-block"],
    ["OpenCode 2", OPENCODE2_403, "edge-block"],
    ["Claude Code, overloaded", "API Error: Repeated 529 Overloaded errors", "overloaded"],
    ["OpenCode 2, overloaded", "Overloaded", "overloaded"],
  ])("%s: reports it with the turn's delivery id, and neither re-sends the prompt nor touches auth", async (_l, error, kind) => {
    const h = harness();
    const first = makeFakeAgent();

    await h.start(first, "transient-provider-retry:1:abc");
    first.emit("event", { type: "agent_result", status: "error", error });
    first.emit("done", 1);
    await waitFor(() => !h.runner.running, "turn settled");

    expect(h.recordTransientProviderError).toHaveBeenCalledTimes(1);
    expect(h.recordTransientProviderError).toHaveBeenCalledWith({
      sessionId: "s1", agentId: "claude", kind, deliveryId: "transient-provider-retry:1:abc",
    });
    expect(h.agents).toHaveLength(0);
    expect(h.ensureAgentTokenFresh).not.toHaveBeenCalled();
    expect(h.onAgentAuthRequired).not.toHaveBeenCalled();
    h.runner.dispose({ force: true });
  });

  it("reports one from the adapter's error path too", async () => {
    const h = harness();
    const first = makeFakeAgent();

    await h.start(first);
    first.emit("error", new Error("API Error: 503 Service Unavailable"));
    await waitFor(() => !h.runner.running, "turn settled");

    expect(h.recordTransientProviderError).toHaveBeenCalledWith(expect.objectContaining({ kind: "server-error" }));
    h.runner.dispose({ force: true });
  });

  it("does not report any other error", async () => {
    const h = harness();
    const first = makeFakeAgent();

    await h.start(first);
    first.emit("event", { type: "agent_result", status: "error", error: "Tool failed: ENOENT" });
    first.emit("done", 1);
    await waitFor(() => !h.runner.running, "turn settled");

    expect(h.recordTransientProviderError).not.toHaveBeenCalled();
    h.runner.dispose({ force: true });
  });

  it("does not report a turn the user stopped", async () => {
    const h = harness();
    const first = makeFakeAgent();

    await h.start(first);
    h.runner.wasInterrupted = true;
    first.emit("event", { type: "agent_result", status: "error", error: CLAUDE_CODE_403 });
    first.emit("done", 1);
    await waitFor(() => !h.runner.running, "turn settled");

    expect(h.recordTransientProviderError).not.toHaveBeenCalled();
    h.runner.dispose({ force: true });
  });

  it("still sends a real 401 to auth recovery, not to the continuation", async () => {
    const h = harness();
    const first = makeFakeAgent();

    await h.start(first);
    first.emit("auth_required");
    first.emit("done", 1);
    await waitFor(() => h.ensureAgentTokenFresh.mock.calls.length > 0, "auth heal");

    expect(h.recordTransientProviderError).not.toHaveBeenCalled();
    h.runner.dispose({ force: true });
  });
});
