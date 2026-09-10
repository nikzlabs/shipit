import { vi } from "vitest";
import { EventEmitter } from "node:events";
import { prepareDispatch, type PreparedDispatch } from "../prepared-dispatch.js";
import type { AgentDispatchOptions, SystemTurnDeps } from "../session-runner.js";

// Test literals may omit fields; production queue conversions must preserve every field.
export function testDispatch(
  opts: Partial<AgentDispatchOptions> & { text: string },
): PreparedDispatch {
  return prepareDispatch({
    text: opts.text,
    agentInterface: opts.agentInterface,
    messageOrigin: opts.messageOrigin,
    execution: opts.execution,
    activity: opts.activity,
    images: opts.images,
    files: opts.files,
    uploads: opts.uploads,
    permissionMode: opts.permissionMode,
    postTurn: opts.postTurn,
    systemTurn: opts.systemTurn,
    onTurnComplete: opts.onTurnComplete,
    resetMergedBranch: opts.resetMergedBranch,
    compactContext: opts.compactContext,
    silent: opts.silent,
    deliveryId: opts.deliveryId,
    dictated: opts.dictated,
  });
}

export interface FakeAgent extends EventEmitter {
  run: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  removeAllListeners: () => this;
  setPermissionMode: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
}

export function makeFakeAgent(): FakeAgent {
  const agent = new EventEmitter() as FakeAgent;
  agent.run = vi.fn();
  agent.kill = vi.fn();
  agent.setPermissionMode = vi.fn();
  agent.sendUserMessage = vi.fn();
  return agent;
}

export function makeDispatchTurnDeps(agents: FakeAgent[], appended: unknown[]): {
  deps: SystemTurnDeps;
  sseBroadcast: ReturnType<typeof vi.fn>;
} {
  const sseBroadcast = vi.fn();
  const deps: SystemTurnDeps = {
    agentFactory: () => {
      const a = makeFakeAgent();
      agents.push(a);
      return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
    },
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
        setLastTurnErrored: vi.fn(),
        get: vi.fn(),
        track: vi.fn(),
        setMuted: vi.fn(),
        list: vi.fn().mockReturnValue([]),
      } as never,
      chatHistoryManager: {
        replaceInProgress: vi.fn(),
        finalizeInProgress: vi.fn(),
        append: (_sid: string, msg: unknown) => { appended.push(msg); },
        updateLastMessage: vi.fn().mockReturnValue(null),
        indexOfMessageId: vi.fn().mockReturnValue(-1),
      } as never,
      usageManager: { record: vi.fn(), getSessionUsage: vi.fn(), getSessionTokenTotals: vi.fn() } as never,
      sseBroadcast,
      broadcastLog: vi.fn(),
      getSelectedModel: () => undefined,
    },
    buildRunParams: vi.fn().mockResolvedValue({ prompt: "do work", cwd: "/tmp/s1" }),
  };
  return { deps, sseBroadcast };
}

export async function flushTurn(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 0));
}

export async function waitForTurn(fn: () => boolean, label = "condition", timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await flushTurn();
  }
  throw new Error(`Timed out waiting for ${label}`);
}
