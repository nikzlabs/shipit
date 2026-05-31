/**
 * Thin dispatch adapter over the shared `executeAgentTurn` (turn-executor.ts).
 *
 * Translates a server-dispatched message (quick / child / CI-fix / HTTP
 * dispatch / queue drain) into a normalized `TurnInput` and delegates. The only
 * dispatch-specific work left here is: create a fresh agent (system turns never
 * reuse a streaming process), echo the message via `emitUserEcho`, persist the
 * user row (text-only), and supply the queue-drain re-entry. Everything else —
 * reset, env-prep, spawn, listeners, post-turn commit/push/PR/drain — lives in
 * the shared executor so this path can't drift from the WS path.
 *
 * Used by both SessionRunner.dispatch and ContainerSessionRunner.dispatch.
 *
 * docs/149 — async because env-prep + run-params assembly are async. Callers
 * fire-and-forget via `void runDispatchedTurn(...)`.
 */

import type { AgentId, AgentProcess } from "../shared/types.js";
import { executeAgentTurn } from "./turn-executor.js";
import type {
  SessionRunnerInterface,
  SystemTurnDeps,
  AgentDispatchOptions,
  QueuedMessage,
} from "./session-runner.js";

function queuedMessageToDispatchOptions(next: QueuedMessage): AgentDispatchOptions {
  const nextOpts: AgentDispatchOptions = { text: next.text };
  if (next.activity !== undefined) nextOpts.activity = next.activity;
  if (next.images !== undefined) nextOpts.images = next.images;
  if (next.files !== undefined) nextOpts.files = next.files;
  if (next.uploads !== undefined) nextOpts.uploads = next.uploads;
  if (next.permissionMode !== undefined) nextOpts.permissionMode = next.permissionMode;
  if (next.reviewFilePath !== undefined) nextOpts.reviewFilePath = next.reviewFilePath;
  return nextOpts;
}

export async function runDispatchedTurn(
  runner: SessionRunnerInterface,
  deps: SystemTurnDeps,
  agentId: AgentId,
  opts: AgentDispatchOptions,
  createAgent: (agentId: AgentId) => AgentProcess,
): Promise<void> {
  const { text, activity } = opts;
  // System turns always spawn a fresh agent (no persistent streaming reuse).
  const agent = createAgent(agentId);

  const drainNext = async (): Promise<void> => {
    if (runner.queueLength === 0) return;
    const next = runner.dequeue();
    if (!next) return;
    runner.emitMessage({ type: "queue_updated", queue: runner.getQueueSnapshot() });
    await runDispatchedTurn(runner, deps, agentId, queuedMessageToDispatchOptions(next), createAgent);
  };

  await executeAgentTurn(runner, deps, agent, {
    agentId,
    prompt: text,
    userText: text,
    ...(activity !== undefined ? { activity } : {}),
    ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
    ...(opts.reviewFilePath !== undefined ? { reviewFilePath: opts.reviewFilePath } : {}),
    // Server-initiated message → emit a bubble (no client-side optimistic one).
    emitUserEcho: true,
    persistUserMessage: (sessionId) =>
      deps.listenerDeps.chatHistoryManager.append(sessionId, { role: "user", text }),
    isNewSession: false,
    fallbackTitle: text.slice(0, 80) || "Agent",
    turnStartHeadHash: null,
    drainNext,
  });
}
