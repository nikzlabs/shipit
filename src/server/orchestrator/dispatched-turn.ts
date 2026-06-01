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

/**
 * How many times a dispatched first turn that exited WITHOUT producing a result
 * is auto-retried before we give up and surface a visible error. The known
 * manual workaround for the docs/163 "quick-session first turn never ran" bug
 * is resending the prompt — one automatic retry reproduces that workaround so
 * the user never has to. Bounded so a genuinely broken turn can't loop.
 */
const MAX_NO_RESULT_RETRIES = 1;

export async function runDispatchedTurn(
  runner: SessionRunnerInterface,
  deps: SystemTurnDeps,
  agentId: AgentId,
  opts: AgentDispatchOptions,
  createAgent: (agentId: AgentId) => AgentProcess,
): Promise<void> {
  const { text, activity } = opts;

  const drainNext = async (): Promise<void> => {
    if (runner.queueLength === 0) return;
    const next = runner.dequeue();
    if (!next) return;
    runner.emitMessage({ type: "queue_updated", queue: runner.getQueueSnapshot() });
    await runDispatchedTurn(runner, deps, agentId, queuedMessageToDispatchOptions(next), createAgent);
  };

  // Tracks no-result retries across the recursive `runOnce` calls for THIS
  // dispatched message (a queue drain re-enters `runDispatchedTurn`, which gets
  // its own fresh counter — each message is retried independently).
  let noResultRetries = 0;

  const runOnce = async (attempt: number): Promise<void> => {
    // System turns always spawn a fresh agent (no persistent streaming reuse).
    const agent = createAgent(agentId);

    await executeAgentTurn(runner, deps, agent, {
      agentId,
      sessionId: runner.sessionId,
      prompt: text,
      userText: text,
      ...(activity !== undefined ? { activity } : {}),
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
      ...(opts.reviewFilePath !== undefined ? { reviewFilePath: opts.reviewFilePath } : {}),
      // Server-initiated message → emit a bubble (no client-side optimistic
      // one). A retry must NOT re-echo the bubble or re-append the user row —
      // both already happened on the first attempt — so only the first run does.
      emitUserEcho: attempt === 0,
      persistUserMessage:
        attempt === 0
          ? (sid) => deps.listenerDeps.chatHistoryManager.append(sid, { role: "user", text })
          : () => { /* user row already persisted on the first attempt */ },
      isNewSession: false,
      fallbackTitle: text.slice(0, 80) || "Agent",
      turnStartHeadHash: null,
      drainNext,
      emit: (m) => runner.emitMessage(m),
      // The masking-bug fix (docs/163): a dispatched first turn that exits
      // without an `agent_result` is NOT a completed turn. Auto-retry once
      // (the user's known "resend the prompt" workaround), then surface a
      // visible error so the failure can never silently vanish again.
      onNoResultExit: async (code) => {
        if (noResultRetries < MAX_NO_RESULT_RETRIES) {
          noResultRetries++;
          console.warn(
            `[turn] dispatched turn for ${runner.sessionId} exited (code ${code}) with no result — ` +
              `retrying (attempt ${noResultRetries}/${MAX_NO_RESULT_RETRIES})`,
          );
          runner.emitMessage({
            type: "system_notice",
            sessionId: runner.sessionId,
            level: "warn",
            message: "The agent didn't start on the first attempt — retrying…",
          });
          await runOnce(attempt + 1);
          return true;
        }
        console.error(
          `[turn] dispatched turn for ${runner.sessionId} exited with no result after ` +
            `${noResultRetries} retr${noResultRetries === 1 ? "y" : "ies"} — surfacing error`,
        );
        // Route through the agent's `error` event so the failure surfaces
        // exactly like any other turn error — a chat error row, a
        // `session_status` reset, `session_agent_finished`, and a queue drain —
        // instead of being swallowed as a completed turn.
        agent.emit(
          "error",
          new Error(
            code !== null && code !== 0
              ? `The agent exited with code ${code} without running. Please send your message again.`
              : "The agent stopped without doing any work. Please send your message again.",
          ),
        );
        return true;
      },
    });
  };

  await runOnce(0);
}
