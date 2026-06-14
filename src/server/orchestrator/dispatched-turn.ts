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
import { buildTurnMessages, emitNoticePostTurn } from "./chat-card-persistence.js";
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
  if (next.postTurn !== undefined) nextOpts.postTurn = next.postTurn;
  if (next.systemTurn !== undefined) nextOpts.systemTurn = next.systemTurn;
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
      // docs/169 — post-turn policy + system-turn marker + completion signal.
      ...(opts.postTurn !== undefined ? { postTurn: opts.postTurn } : {}),
      ...(opts.systemTurn !== undefined ? { systemTurn: opts.systemTurn } : {}),
      // The completion callback only fires on the FIRST attempt's turn — a
      // no-result retry re-enters runOnce and would otherwise fire it twice.
      // (The rebase loop never sets onNoResultExit, so retries don't apply to
      // it; this guard keeps the contract clean regardless.)
      ...(attempt === 0 && opts.onTurnComplete !== undefined ? { onTurnComplete: opts.onTurnComplete } : {}),
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
        // A turn that streamed visible work (assistant text / tool calls) before
        // exiting WITHOUT an `agent_result` — the OOM/SIGHUP case (exit 137/129
        // under memory pressure) — DID run, and must NOT be retried:
        //   1. Re-running re-executes an already-partially-applied prompt.
        //   2. The retry's `resetRunnerTurnState` clears `runner.chatMessageGroups`
        //      in memory while the streamed rows are still `in_progress=1` in the
        //      DB. When the retry then also exits without a result, the surfaced
        //      error rebuilds chat history from the now-EMPTY groups, so
        //      `replaceInProgress([])` deletes the partial turn's rows. Across a
        //      long memory-pressured session these unfinalized `in_progress=1`
        //      rows accumulate and vanish in one wipe — "the agent did the work
        //      but the turns disappeared", while the diffs survive in git.
        // So only the genuinely-empty "never ran" exit (docs/163) is retried; a
        // partial-work exit surfaces the error immediately, while the groups are
        // still intact, so the `agent.error` handler FINALIZES the partial turn
        // (`replaceInProgress` + `finalizeInProgress`) instead of deleting it.
        // The WS path preserves partial turns the same way via `onInterruptedTurn`;
        // dispatch must not retry away from that guarantee.
        const producedPartialWork =
          buildTurnMessages(
            runner.chatMessageGroups,
            runner.steeredMessages ?? [],
            runner.recordedCards ?? [],
            { inProgress: false },
          ).length > 0;

        if (!producedPartialWork && noResultRetries < MAX_NO_RESULT_RETRIES) {
          noResultRetries++;
          console.warn(
            `[turn] dispatched turn for ${runner.sessionId} exited (code ${code}) with no result — ` +
              `retrying (attempt ${noResultRetries}/${MAX_NO_RESULT_RETRIES})`,
          );
          emitNoticePostTurn(
            (m) => runner.emitMessage(m),
            deps.listenerDeps.chatHistoryManager,
            runner.sessionId,
            "The agent didn't start on the first attempt — retrying…",
            "warn",
          );
          await runOnce(attempt + 1);
          return true;
        }
        console.error(
          `[turn] dispatched turn for ${runner.sessionId} exited with no result ` +
            `(partialWork=${producedPartialWork}, retries=${noResultRetries}) — surfacing error`,
        );
        // Route through the agent's `error` event so the failure surfaces
        // exactly like any other turn error — a chat error row, a
        // `session_status` reset, `session_agent_finished`, and a queue drain —
        // instead of being swallowed as a completed turn. When the turn streamed
        // partial work before dying, the error handler FINALIZES those still-intact
        // groups (so the visible work is preserved on reload); phrase the message
        // as "stopped before finishing" rather than "without running", which only
        // fits the genuinely-empty case.
        agent.emit(
          "error",
          new Error(
            producedPartialWork
              ? (code !== null && code !== 0
                  ? `The agent stopped before finishing (exit ${code}). The work so far is preserved — send your message again to continue.`
                  : "The agent stopped before finishing. The work so far is preserved — send your message again to continue.")
              : (code !== null && code !== 0
                  ? `The agent exited with code ${code} without running. Please send your message again.`
                  : "The agent stopped without doing any work. Please send your message again."),
          ),
        );
        return true;
      },
    });
  };

  await runOnce(0);
}
