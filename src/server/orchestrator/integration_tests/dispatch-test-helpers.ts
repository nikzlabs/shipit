/**
 * TEST-ONLY helpers for building a `PreparedDispatch` (docs/240).
 *
 * Production code must call `prepareDispatch` with a COMPLETE
 * `AgentDispatchInit` — that completeness is the whole point of Fix A, because a
 * producer that fills in defaults for the fields you didn't mention re-opens the
 * exact hole SHI-255 / SHI-259 fell through (a drain site quietly narrowing a
 * queued entry). Tests, though, dispatch a bare `{ text }` dozens of times, and
 * spelling out nine `undefined`s at each call site buys nothing: a test isn't
 * *deriving* options from a queued entry, so there is nothing for it to drop.
 *
 * So this shim lives here — under `integration_tests/`, never imported by
 * production code — and is deliberately NOT exported from `prepared-dispatch.ts`.
 * If you find yourself wanting it in `src/server/orchestrator/*.ts`, that is the
 * signal you are writing a drain site by hand; use `queuedMessageToDispatchOptions`
 * instead.
 */

import { vi } from "vitest";
import { EventEmitter } from "node:events";
import { prepareDispatch, type PreparedDispatch } from "../prepared-dispatch.js";
import type { AgentDispatchOptions, SystemTurnDeps } from "../session-runner.js";

/** Build a `PreparedDispatch` from a partial literal. Tests only. */
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
    deliveryId: opts.deliveryId,
    dictated: opts.dictated,
  });
}

// ---------------------------------------------------------------------------
// In-process dispatched-turn harness
// ---------------------------------------------------------------------------
//
// Drives the REAL `SessionRunner.dispatch` → `runDispatchedTurn` →
// `executeAgentTurn` path with a fake agent, so the turn lifecycle (retries,
// settlement, post-turn teardown) is exercised end-to-end without Docker.

export interface FakeAgent extends EventEmitter {
  run: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  removeAllListeners: () => this;
  setPermissionMode: ReturnType<typeof vi.fn>;
}

export function makeFakeAgent(): FakeAgent {
  const agent = new EventEmitter() as FakeAgent;
  agent.run = vi.fn();
  agent.kill = vi.fn();
  agent.setPermissionMode = vi.fn();
  return agent;
}

/** A minimal listenerDeps + turn deps wiring usable by `executeAgentTurn`. */
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
