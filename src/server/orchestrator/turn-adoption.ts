/**
 * Turn adoption — re-attach the orchestrator to an agent turn that was already
 * in flight inside a session container (docs/240).
 *
 * The orchestrator is restartable; session containers are not tied to its
 * lifetime. When the orchestrator crashes or is redeployed mid-turn, the CLI
 * inside the container keeps working: it goes on emitting `agent_assistant` /
 * `agent_tool_result` / `agent_result` into the worker's SSE ring buffer. The
 * fresh orchestrator process rediscovers the container and reconnects SSE, but
 * every in-memory object that turn was bound to — the `ProxyAgentProcess`, its
 * listeners, the runner's `running` flag — died with the old process. Without
 * this module the replayed events hit the `(no _agent)` drop branch in
 * `handleSSEEvent`: the session renders as stopped, the turn's transcript tail
 * is never persisted, and `postTurnCommit` → auto-push → PR card never run. The
 * user's only recovery was typing "continue" into every affected session.
 *
 * Adoption rebuilds exactly the state a live turn needs and nothing else:
 *
 *   1. a `ProxyAgentProcess` in the runner's `_agent` slot, carrying the run
 *      token the WORKER recorded for the spawn (so the eventual `agent_done`
 *      still correlates and isn't ignored as a stale-spawn exit), and
 *   2. the standard listener + post-turn wiring, via the same
 *      `executeAgentTurn` every other turn goes through — in `adopt` mode,
 *      which skips the spawn (the process is already running) and the user-row
 *      persist (the pre-restart orchestrator already wrote it).
 *
 * From there the replayed events flow through the normal path: chat rows
 * accumulate, `agent_result` finalizes the turn into history, and the post-turn
 * commit / push / PR-lifecycle flow fires. `container-session-runner.ts` anchors
 * the SSE replay cursor at the worker's `turnStartSseSeq` so the replay covers
 * this turn and not the previous (already-persisted) one.
 *
 * Duplicate-safety: the pre-restart orchestrator persisted the turn's partial
 * rows as `in_progress=1` (that is what every tool-result boundary writes), and
 * the listener's `agent_result` handler calls `replaceInProgress`, which deletes
 * every in-progress row before writing the rebuilt turn. So a replayed turn
 * lands in history exactly once, no matter how much of it was already written
 * before the crash.
 */

import type { AgentId, AgentProcess } from "../shared/types.js";
import type { SessionRunnerInterface, SystemTurnDeps } from "./session-runner.js";
import { executeAgentTurn } from "./turn-executor.js";
import { buildTurnMessages } from "./chat-card-persistence.js";
import { startQueuedMessage, queuedMessageToDispatchOptions } from "./queue-drain.js";

/** What the worker reported about the turn it still has in flight. */
export interface InFlightTurnInfo {
  agentId: AgentId;
  /** The run token the worker recorded for this spawn (absent on a legacy worker). */
  runToken?: string;
  /** The turn is running on a resident streaming (live-steering) process. */
  streaming: boolean;
}

/**
 * Wire an already-running worker turn into `runner` + `agent`. The caller must
 * have put `agent` in the runner's agent slot BEFORE calling this (and before
 * the SSE stream connects), so no replayed event can arrive unrouted.
 *
 * Resolves once the listeners are wired — the turn itself completes later, off
 * the replayed `agent_result`.
 */
export async function adoptInFlightTurn(
  runner: SessionRunnerInterface,
  deps: SystemTurnDeps,
  agent: AgentProcess,
  info: InFlightTurnInfo,
): Promise<void> {
  const sessionId = runner.sessionId;

  // Queue drain re-entry. The in-memory queue died with the previous process,
  // so this is normally a no-op — but a message enqueued WHILE the adopted turn
  // runs must still drain when it ends, exactly as it would on any other turn.
  // `tryDrain` has already cleared `running` by the time this fires, so it
  // starts a real turn.
  //
  // SHI-259 — this used to rebuild `AgentDispatchOptions` by hand (text +
  // activity + images + files + uploads + permissionMode), dropping `execution`,
  // `systemTurn`, `postTurn`, and `onTurnComplete`. A notify-on-merge wake-turn
  // queued behind an ADOPTED turn therefore ran as an ordinary turn and never
  // signalled completion — the exact failure SHI-255 had just fixed for the
  // other three drains, reachable again through this path. It now routes through
  // the shared `startQueuedMessage`, and (docs/240) `dispatch` /
  // `runDispatchedTurn` take a branded `PreparedDispatch`, so the hand-rolled
  // version does not compile any more.
  const drainNext = async (): Promise<void> => {
    const next = runner.dequeue();
    if (!next) return;
    runner.emitMessage({ type: "queue_updated", queue: runner.getQueueSnapshot() });
    await startQueuedMessage(runner, next, (queued) => {
      // The adoption sweep runs at startup with no WS connection behind it, so
      // there is no interactive re-entry to fall back to. Hand the entry to the
      // shared send-or-queue funnel with the FULL converted option set — never a
      // narrowed literal.
      runner.dispatch(queuedMessageToDispatchOptions(queued));
      return Promise.resolve();
    });
  };

  await executeAgentTurn(runner, deps, agent, {
    agentId: info.agentId,
    sessionId,
    adopt: true,
    // No prompt / user text: the turn is mid-flight and its user row was
    // persisted by the orchestrator that started it.
    prompt: "",
    userText: "",
    emitUserEcho: false,
    persistUserMessage: () => { /* already persisted before the restart */ },
    isNewSession: false,
    fallbackTitle: "Agent",
    // The turn started in a process we can no longer ask for its starting HEAD.
    // `postTurnCommit` treats null as "no branch-tip heuristic" and falls back
    // to the normal working-tree auto-commit, which is what almost every turn
    // needs anyway.
    turnStartHeadHash: null,
    drainNext,
    emit: (m) => runner.emitMessage(m),
    ...(info.streaming ? { useStreaming: true } : {}),
    // WS-style surfacing: if the adopted process exits without ever producing a
    // result, tell the viewer instead of leaving a spinner behind, and finalize
    // whatever partial rows the replay produced so they survive the next turn's
    // `replaceInProgress`.
    emitErrorOnNoResult: true,
    onInterruptedTurn: () => {
      const partial = buildTurnMessages(
        runner.chatMessageGroups,
        runner.steeredMessages ?? [],
        runner.recordedCards ?? [],
        { inProgress: false },
      );
      if (partial.length > 0) {
        deps.listenerDeps.chatHistoryManager.replaceInProgress(sessionId, partial);
        deps.listenerDeps.chatHistoryManager.finalizeInProgress(sessionId);
      }
      runner.clearTurnEventBuffer();
    },
  });
}
