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

interface FakeAgent extends EventEmitter {
  run: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
}

function makeFakeAgent(onRun?: (agent: FakeAgent) => void): FakeAgent {
  const agent = new EventEmitter() as FakeAgent;
  agent.run = vi.fn(() => onRun?.(agent));
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

describe("no-result error row carries the agent's stderr", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "shi309-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
    fs.writeFileSync(path.join(repoDir, "file.txt"), "base\n");
    execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: repoDir, stdio: "pipe" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  async function runDyingTurn(
    stderr: { source: string; text: string }[],
    exitCode: number,
  ): Promise<string | undefined> {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const errors: string[] = [];
    vi.spyOn(runner, "emitMessage").mockImplementation((m) => {
      if (m.type === "error") errors.push(m.message);
    });

    const agent = makeFakeAgent((a) => {
      for (const line of stderr) a.emit("log", line.source, line.text);
    });
    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: async () => ({ committed: false, parentHash: null }) as never,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow: vi.fn(async () => {}),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "do the thing",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext: async () => {},
      emit: () => {},
      useStreaming: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn started");

    agent.emit("done", exitCode);
    await waitFor(() => !runner.running, "turn settled");
    await waitFor(() => errors.length > 0, "error row emitted");

    runner.dispose({ force: true });
    return errors[0];
  }

  it("names the Codex cold-start failure instead of only the exit code", async () => {
    const message = await runDyingTurn(
      [{
        source: "codex-stderr",
        text: "Error: failed to initialize sqlite state runtime under "
          + "/workspace/.inner-shipit/credentials/provider-accounts/codex/acct_a8250731/.codex",
      }],
      1,
    );

    expect(message).toContain("Agent process exited with code 1");
    expect(message).toContain("failed to initialize sqlite state runtime");
    expect(message).not.toContain("acct_a8250731");
  });

  it("carries Claude's stderr too — the source label is the only difference", async () => {
    const message = await runDyingTurn(
      [{ source: "stderr", text: "node: bad option: --nonexistent-flag" }],
      1,
    );
    expect(message).toContain("node: bad option: --nonexistent-flag");
  });

  it("falls back to the bare message when the process wrote nothing to stderr", async () => {
    const message = await runDyingTurn([{ source: "codex", text: "spawning: codex app-server" }], 1);
    expect(message).toBe("Agent process exited with code 1");
  });

  it("uses the no-response wording for a clean exit with no result", async () => {
    const message = await runDyingTurn([], 0);
    expect(message).toBe("Agent process ended without a response");
  });
});
