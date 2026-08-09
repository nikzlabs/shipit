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
  /**
   * planning#266 — the durable DELIVERY id the worker recorded for this turn, when it
   * was dispatched on behalf of a server-side delivery (a notify-on-merge wake).
   * Absent for an ordinary user turn and on a legacy worker.
   */
  deliveryId?: string;
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
  // planning#261 — this used to rebuild `AgentDispatchOptions` by hand (text +
  // activity + images + files + uploads + permissionMode), dropping `execution`,
  // `systemTurn`, `postTurn`, and `onTurnComplete`. A notify-on-merge wake-turn
  // queued behind an ADOPTED turn therefore ran as an ordinary turn and never
  // signalled completion — the exact failure planning#257 had just fixed for the
  // other three drains, reachable again through this path. It now routes through
  // the shared `startQueuedMessage`, and (docs/240) `dispatch` /
  // `runDispatchedTurn` take a branded `PreparedDispatch`, so the hand-rolled
  // version does not compile any more.
  const drainNext = async (): Promise<void> => {
    // planning#338 — a rebase flow holds the session; starting a queued turn would
    // displace its agent slot mid-rebase. The flow's `finally` releases the
    // queue when it settles. (An adopted turn itself never sets the flag.)
    if (runner.systemTurnInProgress) return;
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

  // planning#266 — re-acquire the completion settlement for the delivery this turn
  // was dispatched on behalf of.
  //
  // Adoption rebuilds a live turn, but the settlement it started with died with
  // the previous orchestrator process — so before this the adopted turn ran to
  // completion and settled NOTHING. The originating watch stayed non-terminal,
  // and `reconcilePending` (which runs right after the adoption sweep) then
  // queued a SECOND wake behind the still-running first one. Startup ordering
  // stopped the two colliding; it never stopped the duplicate.
  //
  // The worker's reported delivery id is what closes it: the owner of that id
  // hands back the same callback it would have attached at dispatch time, so
  // the ORIGINAL watch settles from the adopted turn. Undefined when nothing
  // owns the id any more (cancelled, re-armed, already terminal) — the turn then
  // runs with no settlement, exactly like a user turn.
  const rebound = info.deliveryId !== undefined
    ? deps.rebindDelivery?.(info.deliveryId)
    : undefined;
  if (info.deliveryId !== undefined) {
    const verdict = rebound ? "settlement rebound" : "no live owner, running unsettled";
    console.log(
      `[turn-adoption:${sessionId}] adopted turn carries delivery ${info.deliveryId} — ${verdict}`,
    );
  }

  await executeAgentTurn(runner, deps, agent, {
    agentId: info.agentId,
    sessionId,
    adopt: true,
    // Publishes the delivery on the runner for the adopted turn's duration, so
    // `runner.hasDelivery(id)` answers truthfully in the restarted process too.
    ...(info.deliveryId !== undefined ? { deliveryId: info.deliveryId } : {}),
    ...(rebound ? { onTurnComplete: rebound } : {}),
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
