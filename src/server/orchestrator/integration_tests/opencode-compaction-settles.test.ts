// planning#644 — an OpenCode compaction is a one-shot turn, whose idle signal, settlement and
// hold release run from `done`. Driven through the real adapter, so a compaction that reports
// only its result fails here.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, type ChildProcess } from "node:child_process";
import { SessionRunner } from "../session-runner.js";
import type { SystemTurnDeps } from "../session-runner.js";
import { executeAgentTurn } from "../turn-executor.js";
import type { AgentId } from "../../shared/types.js";
import { GitManager } from "../../shared/git.js";
import { OpencodeAdapter } from "../../session/agents/opencode/adapter.js";

// No pid, so killProcessTree never signals a real process for it.
class FakeServer extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => true);
}

async function waitFor(fn: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
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
      touchUnlessResolved: vi.fn(),
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

const SUCCESS = { ok: true, status: 200, body: "true" };
const FAILURE = { ok: false, status: 503, body: "not available yet" };

describe("an OpenCode compaction turn settles (planning#644)", () => {
  let repoDir: string;
  let agentHome: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-compact-turn-"));
    agentHome = fs.mkdtempSync(path.join(os.tmpdir(), "oc-compact-home-"));
    vi.stubEnv("AGENT_HOME", agentHome);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(repoDir, "file.txt"), "base\n");
    git("add", "-A");
    git("commit", "-qm", "initial");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(agentHome, { recursive: true, force: true });
  });

  async function compact(opts: {
    summarize: typeof SUCCESS;
    queued?: boolean;
    drainNext?: (runner: SessionRunner) => void;
  }) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: opts.summarize.ok,
        status: opts.summarize.status,
        text: () => Promise.resolve(opts.summarize.body),
      }),
    );
    const server = new FakeServer();
    const adapter = new OpencodeAdapter({ spawnFn: () => server as unknown as ChildProcess });
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "opencode" as AgentId });
    const events: string[] = [];
    runner.on("idle", () => events.push("idle"));
    const onTurnComplete = vi.fn();
    const commitTurn = vi.fn<NonNullable<SystemTurnDeps["commitTurn"]>>(async ({ sessionDir, summary }) => {
      const r = await new GitManager(sessionDir).autoCommit(summary);
      return r.commitHash;
    });
    const drainNext = vi.fn(async () => { opts.drainNext?.(runner); });

    const deps: SystemTurnDeps = {
      agentFactory: () => adapter,
      autoCommit: vi.fn(),
      scheduleAutoPush: vi.fn(),
      commitTurn,
      postTurnPrFlow: vi.fn(),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({
        prompt: "/compact",
        cwd: repoDir,
        sessionId: "ses_compact",
        model: "anthropic/claude-sonnet-4",
        compact: true,
      }),
    };

    if (opts.queued) runner.messageQueue.push({ text: "the queued message" } as never);
    runner.running = true;
    await executeAgentTurn(runner, deps, adapter, {
      agentId: "opencode" as AgentId,
      sessionId: "s1",
      prompt: "/compact",
      userText: "/compact",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext,
      emit: () => {},
      useStreaming: false,
      compact: true,
      onTurnComplete,
    });
    await waitFor(() => server.stdout.listenerCount("data") > 0, "compaction server spawned");
    server.stdout.emit("data", Buffer.from("opencode server listening on http://127.0.0.1:4096\n"));

    await waitFor(() => onTurnComplete.mock.calls.length > 0, "turn settled");
    await waitFor(() => !runner.postTurnWorkInFlight, "post-turn hold released");
    return { runner, events, onTurnComplete, commitTurn, drainNext };
  }

  it.each([
    { outcome: "success", summarize: SUCCESS },
    { outcome: "failure", summarize: FAILURE },
  ])("commits, signals idle and releases its holds after a $outcome", async ({ summarize }) => {
    const { runner, events, onTurnComplete, commitTurn } = await compact({ summarize });
    await waitFor(() => events.includes("idle"), "idle");

    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(onTurnComplete.mock.calls[0]![0]).toMatchObject({ status: "completed" });
    expect(commitTurn).toHaveBeenCalledTimes(1);
    expect(runner.turnCommitPending).toBe(false);
    expect(runner.running).toBe(false);
    runner.dispose({ force: true });
  });

  // docs/295 and docs/324-agent-requested-compaction queue a successor behind the compaction,
  // and the drain at the result starts it before `done` is handled.
  it("leaves a successor the drain started running, and signals no idle under it", async () => {
    const { runner, events, onTurnComplete, drainNext } = await compact({
      summarize: SUCCESS,
      queued: true,
      // As drainNextQueuedMessage does: the entry is claimed before the successor's setup.
      drainNext: (r) => {
        r.messageQueue.shift();
        r.running = true;
      },
    });
    expect(drainNext).toHaveBeenCalledTimes(1);
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(runner.running).toBe(true);
    expect(events).not.toContain("idle");
    runner.dispose({ force: true });
  });
});
