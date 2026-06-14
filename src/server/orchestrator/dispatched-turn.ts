/**
 * Thin dispatch adapter over the shared `executeAgentTurn` (turn-executor.ts).
 *
 * Translates a server-dispatched message (quick / child / CI-fix / HTTP
 * dispatch / queue drain) into a normalized `TurnInput` and delegates. The only
 * dispatch-specific work left here is: acquire the agent (reuse a resident
 * streaming process when this turn streams and one is alive — docs/163 — else
 * spawn fresh; system turns never stream so they always spawn fresh), echo the
 * message via `emitUserEcho`, persist the user row (text-only), and supply the
 * queue-drain re-entry. Everything else — reset, env-prep, spawn, listeners,
 * post-turn commit/push/PR/drain — lives in the shared executor so this path
 * can't drift from the WS path.
 *
 * docs/163 — a child/quick-session dispatched turn runs as a *streaming* process
 * when live steering is on and the agent supports it (the same gate the WS path
 * uses), so a follow-up `shipit session message` arriving mid-turn is steered
 * into the running turn instead of being queued. See `useStreaming` below.
 *
 * Used by both SessionRunner.dispatch and ContainerSessionRunner.dispatch.
 *
 * docs/149 — async because env-prep + run-params assembly are async. Callers
 * fire-and-forget via `void runDispatchedTurn(...)`.
 */

import type { AgentId, AgentProcess } from "../shared/types.js";
import { executeAgentTurn } from "./turn-executor.js";
import { emitNoticePostTurn } from "./chat-card-persistence.js";
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

  // docs/163 — a child/quick-session dispatched turn must run as a *streaming*
  // process when live steering is on and the agent supports it, EXACTLY as a
  // user-typed WS turn does (agent-execution.ts computes the same gate). The
  // child's own first turn is started through THIS path, so if it spawns
  // non-streaming the resident process is one-shot, `runner.isStreamingActive`
  // stays false, and a follow-up `shipit session message` arriving mid-turn
  // fails `shouldSteerMessage` and is QUEUED instead of injected — the "spawn a
  // session, then message it, and the message just sits in the queue" bug. With
  // streaming on, the running turn's agent is steerable, so `trySteerDispatch`
  // injects the message via `sendUserMessage`, i.e. it behaves as if the user
  // typed it. System turns (rebase resolution, CI-fix) are explicitly never
  // steered (`systemTurnInProgress` blocks it), so they stay non-streaming and
  // keep their fresh-agent-per-turn / one-shot post-turn semantics.
  const steer = opts.systemTurn ? undefined : deps.steerInputs?.();
  const useStreaming = steer ? steer.liveSteering && steer.steeringCapable : false;

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
    // docs/140 + docs/163 — when this dispatched turn streams AND a resident
    // streaming process from a previous turn is still alive, REUSE it (carry the
    // message in via `sendUserMessage`) exactly as the WS path does, rather than
    // spawning a fresh agent. Spawning fresh while the worker still holds the old
    // streaming process would 409 the `/agent/start` and trigger a kill+restart
    // (SIGTERM 143) — the respawn-noise bug docs/140 fixed for the WS path. Only
    // the FIRST attempt can reuse; a no-result retry always spawns fresh (the
    // resident ref was cleared by the `done` handler when the process exited
    // without a result). A non-streaming or system turn never reuses — `resident`
    // stays null, so `createAgent` spawns fresh exactly as before.
    const resident =
      useStreaming && attempt === 0 && runner.isStreamingActive ? runner.getAgent() : null;
    const reuse = resident !== null;
    const agent = resident ?? createAgent(agentId);
    // Drop the previous turn's per-turn listeners off a reused process before the
    // executor wires its own, else they fire N times after N turns (mirrors the
    // WS path's `existingAgent.removeAllListeners()`).
    if (reuse) agent.removeAllListeners();

    await executeAgentTurn(runner, deps, agent, {
      agentId,
      sessionId: runner.sessionId,
      prompt: text,
      userText: text,
      ...(activity !== undefined ? { activity } : {}),
      // Only set the key when streaming so a non-steerable dispatch keeps the
      // exact run-params shape it had before (turn-executor leaves `useStreaming`
      // out of the run params when this is undefined — see its spawn branch).
      ...(useStreaming ? { useStreaming: true } : {}),
      // Carry the message into the resident streaming process via
      // `sendUserMessage` instead of a fresh `/agent/start` (turn-executor's
      // reuse branch).
      ...(reuse ? { reuseExistingAgent: true } : {}),
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
        if (noResultRetries < MAX_NO_RESULT_RETRIES) {
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
