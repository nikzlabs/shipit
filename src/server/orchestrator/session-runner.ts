/**
 * SessionRunnerInterface — shared contract for session runner implementations.
 *
 * SessionRunnerRegistry — app-level registry of active session runners.
 * One runner per session. Manages lifecycle (create, get, dispose) and
 * enforces resource limits.
 */

import { EventEmitter } from "node:events";
import type { AgentProcess, AgentId, TerminalProcess, AgentRunParams, SessionMessageOrigin } from "../shared/types.js";
import type { WsServerMessage, ImageAttachment, FileContextRef, UploadRef, PermissionMode, ClaudeContentBlockToolUse, SkillInfo } from "../shared/types.js";
import type { PresentStateEntry } from "../shared/types/ws-server-messages.js";
import type { ServiceManager } from "./service-manager.js";
import type { AgentListenerDeps } from "./ws-handlers/agent-listeners.js";
import type { PersistedMessage } from "./chat-history.js";
import type { SecretFinding } from "../shared/secret-scan.js";
import type { SubAgentSpawnRequest, SubAgentRunResult, SubAgentRunHandle } from "../shared/sub-agent-run.js";
import { runAgentToCompletion, buildSubAgentRunParams } from "../shared/sub-agent-run.js";
import type { AgentInterfaceProvenance } from "../shared/agent-interface-sdk/protocol.js";
import type { PreTurnResetHookResult, PreTurnResetRunner } from "./pre-turn-reset-hook.js";

// `runDispatchedTurn` lives in a separate module because it depends on
// `wireAgentListeners` at runtime, which would otherwise create an import
// cycle through `ws-handlers/agent-listeners.ts` ↔ `session-runner.ts`.
// Re-exported here so container-session-runner.ts (and the runner classes
// in this file) can keep their existing import path.
import { BackgroundTaskTracker, type BackgroundTaskInfo } from "./background-task-tracker.js";
import { getAgentDisplayName } from "../shared/agent-registry.js";
import { runDispatchedTurn } from "./dispatched-turn.js";
export { runDispatchedTurn };

// docs/163 — shared steer-or-queue helper for the dispatch path. Same module
// boundary rationale as `runDispatchedTurn`: it reaches `wireAgentListeners`
// helpers (recordSteeredMessage / persistTurnInProgress) at runtime, so it
// lives outside this file to keep the import graph acyclic.
import { trySteerDispatch } from "./dispatch-steering.js";
import { resetVoiceNoteTurnState } from "./voice/voice-note-router.js";
// docs/244 / planning#299 — the committed-body marker the reconnect snapshot reads.
// `transcript-projection.ts` imports only TYPES from this module, so this edge
// is one-way at runtime.
import {
  createCommittedBodyIds,
  clearCommittedBodyIds,
  type CommittedBodyIds,
} from "./transcript-projection.js";

// docs/240 — the branded prepared-dispatch producers and the turn settlement.
// `prepared-dispatch.ts` imports only TYPES from this module, so the runtime
// edge is one-way and the import graph stays acyclic.
import {
  withSettlement,
  queuedMessageToDispatchOptions,
  type PreparedDispatch,
} from "./prepared-dispatch.js";
import {
  createTurnSettlement,
  settleDroppedQueueEntries,
  turnDropped,
  turnErrored,
  TURN_STEERED,
  type TurnHandle,
  type TurnOutcome,
} from "./turn-settlement.js";
export {
  prepareDispatch,
  queuedMessageToDispatchOptions,
  type PreparedDispatch,
  type AgentDispatchInit,
} from "./prepared-dispatch.js";
export type { TurnHandle, TurnOutcome, TurnOutcomeStatus } from "./turn-settlement.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolResultEntry {
  toolUseId: string;
  content: string;
  isError?: boolean;
  /**
   * Per-tool execution time in milliseconds. The CLI never reports per-tool
   * timing (only a turn-level `duration_ms`), so the orchestrator derives this:
   * the wall-clock delta between observing the `tool_use` block and its matching
   * `tool_result`. Surfaced in the tool-call detail modal. For interactive tools
   * (AskUserQuestion / ExitPlanMode) the delta includes human approval time, so
   * it reads as elapsed, not pure execution. Absent when no start time was seen
   * for the tool (e.g. a result with no preceding recorded tool_use).
   */
  durationMs?: number;
  /**
   * docs/244 — `content` is a head slice and the full body is available from
   * `GET /api/sessions/:id/tool-results/:toolUseId`. Absent (rather than
   * `false`) on the common small result so it costs nothing on the wire. Set
   * only on the serve path; the persisted row always holds the whole body.
   */
  truncated?: true;
  /** True line count of the whole body — the "Show all N lines" label. */
  totalLines?: number;
  /** Byte length of the whole body. */
  totalBytes?: number;
}

/**
 * A single event emitted by a subagent (Claude's Task tool). Preserves the
 * parent-child link so the client can render subagent activity as a nested
 * tree under the parent Task call rather than flattening it into the main
 * conversation. (109 — subagent transparency)
 */
export type SubagentEvent =
  | {
      kind: "assistant";
      parentToolUseId: string;
      text: string;
      toolUse: ClaudeContentBlockToolUse[];
    }
  | {
      kind: "tool_result";
      parentToolUseId: string;
      toolResults: ToolResultEntry[];
    };

export interface ChatMessageGroup {
  text: string;
  toolUse: ClaudeContentBlockToolUse[];
  toolResults?: ToolResultEntry[];
  /**
   * Events emitted by subagents whose parent Task tool lives in this group's
   * `toolUse`. Stored as a flat ordered list; the client groups them by
   * parentToolUseId for rendering.
   */
  subagentEvents?: SubagentEvent[];
}

/**
 * A user message injected mid-turn via live steering (docs/140). Unlike the
 * turn-opening user message (persisted once via `append`), a steered message
 * lands *between* assistant message groups. `afterGroupIndex` records how many
 * persistable assistant groups existed when the steer arrived, so the message
 * can be re-interleaved at its true position every time `replaceInProgress`
 * rebuilds the in-progress set. Without this anchor the steered row keeps its
 * early id while assistant rows are deleted+reinserted at higher ids, and on
 * reload the steer collapses up next to the turn's first user message.
 */
export interface SteeredMessage {
  afterGroupIndex: number;
  text: string;
  agentInterface?: AgentInterfaceProvenance;
  messageOrigin?: SessionMessageOrigin;
  /**
   * Attachments the user sent with this steer. Shapes match `PersistedMessage`
   * so `buildTurnMessages` can write them straight through to chat history;
   * without these the steered bubble reloads as text-only and the model never
   * sees the image/file context the user attached.
   */
  images?: { data: string; mediaType: string }[];
  files?: { path: string; contentPreview: string; startLine?: number; endLine?: number }[];
  uploadPaths?: string[];
  /**
   * docs/140 — the exact assembled prompt sent to the streaming CLI for this
   * steer (what `--replay-user-messages` echoes back). The delivery-ack matcher
   * keys on it. Set only for steers routed through the live-steer path (a steer
   * that can be lost in the turn-end gap); a `SteeredMessage` without it is not
   * a re-queue candidate. In-memory only — `buildTurnMessages` copies just
   * text/attachments, so this never reaches chat-history persistence.
   */
  assembledPrompt?: string;
  /**
   * docs/140 — set true once the CLI's replay echo confirmed this steer was
   * accepted into a turn. A steer with `assembledPrompt` set but `delivered`
   * still falsy at turn end fell into the gap and is re-queued.
   */
  delivered?: boolean;
}

/**
 * A chat card recorded for in-band turn persistence (docs/163 voice notes,
 * docs/164 bug-report cards, and any future inline card).
 *
 * Such cards arrive on a side channel (the `voice_note` tool bridge, the derived
 * AskUserQuestion·ExitPlanMode observer, the `report_shipit_bug` HTTP relay),
 * NOT the agent-event stream, so `buildTurnMessages` doesn't capture them on its
 * own. Persisting them out-of-band via `append` reproduces the exact bug
 * `SteeredMessage` documents: the card row keeps its early id while the turn's
 * assistant rows are deleted+reinserted at higher ids on every
 * `replaceInProgress`, so on reload the card floats up above the whole turn
 * instead of landing where the tool was issued.
 *
 * `afterGroupIndex` records how many persistable assistant groups existed when
 * the card fired, so `buildTurnMessages` re-interleaves it at its true transcript
 * position on every in-progress rebuild — same mechanism as steers. `message` is
 * the exact `PersistedMessage` row to interleave (`{ role, text: "", <field>: … }`).
 *
 * Use `emitChatCard` (chat-card-persistence.ts) to emit + record in one call —
 * that is the single supported way to add a card so it can't be emit-only.
 */
export interface RecordedChatCard {
  afterGroupIndex: number;
  message: PersistedMessage;
}

export interface QueuedMessage {
  text: string;
  agentInterface?: AgentInterfaceProvenance;
  /** Another session's agent supplied this prompt, rather than the user. */
  messageOrigin?: SessionMessageOrigin;
  /**
   * planning#257 — which executor must run this entry when it drains.
   *
   * `"interactive"` — a user-typed WS message (the client already rendered an
   * optimistic bubble, so the drain must NOT echo one). Carries only text +
   * attachments + permission mode; the WS drain
   * (`ws-handlers/agent-execution.ts`) runs it.
   *
   * `"dispatched"` — a server-originated turn (wake-turn, CI auto-fix, rebase
   * resolution, child message, quick session). It may carry turn-execution
   * semantics the interactive re-entry cannot express — `systemTurn`,
   * `onTurnComplete`, `postTurn`, `activity` — so it MUST run through
   * `runDispatchedTurn`, which restores all of them.
   *
   * Required (not optional) so every enqueue site has to declare which it is;
   * `toQueuedMessage` defaults a dispatch to `"dispatched"`, the superset path,
   * so a caller that forgets can only over-deliver (an extra echo bubble), never
   * silently drop a field.
   */
  execution: "interactive" | "dispatched";
  /** Spinner label shown in the chat bubble (e.g. "Creating PR…"). Carried through queue drain. */
  activity?: string;
  images?: ImageAttachment[];
  files?: FileContextRef[];
  uploads?: UploadRef[];
  permissionMode?: PermissionMode;
  /** docs/169 — post-turn policy carried through the queue drain (see AgentDispatchOptions). */
  postTurn?: "commit-push" | "none";
  /** docs/169 — system-turn marker carried through the queue drain (see AgentDispatchOptions). */
  systemTurn?: boolean;
  /**
   * docs/196 fix — completion callback carried through the IN-MEMORY queue so a
   * turn enqueued behind a running turn still signals completion when it later
   * drains and runs. Without this a merge-watch wake-turn dispatched into a busy
   * parent never advanced past `merge-observed` (the callback was dropped at
   * enqueue), so every orchestrator restart re-fired it via `reconcilePending` —
   * duplicate notify-on-merge notifications. The queue is in-memory only and
   * never serialized (`getQueueSnapshot` projects to `{text,position}`), so a
   * function field is safe; a restart drops the queue (and this callback) along
   * with the un-run turn, which is exactly the in-flight case reconcile recovers.
   *
   * docs/240 — this is also what carries a `dispatch` handle's SETTLEMENT across
   * the queue (see `withSettlement`), and `clearQueue` / `dispose` now settle
   * every entry they throw away as `dropped` rather than eating the signal.
   */
  onTurnComplete?: (outcome: TurnOutcome) => void;
  /**
   * planning#266 — durable delivery identity, carried through the queue so a wake-turn
   * waiting behind a busy parent still answers `runner.hasDelivery(id)` while it
   * sits there. Without this the queued window would read as "not in flight" and
   * the retry supervisor would fire a duplicate.
   */
  deliveryId?: string;
  /** docs/144 — voice-dictated prompt (see `AgentDispatchOptions.dictated`). */
  dictated?: boolean;
}

/**
 * Options accepted by `runner.dispatch(...)` and `runDispatchedTurn(...)`. The
 * runner's send-or-queue entry point for a *new turn*: enqueued behind a
 * running turn or started directly when idle. Carries every field a queued
 * message can carry so the drain doesn't lose attachments, permission mode,
 * or the review allow-list (docs/150).
 */
export interface AgentDispatchOptions {
  text: string;
  agentInterface?: AgentInterfaceProvenance;
  /** Another session's agent supplied this prompt, rather than the user. */
  messageOrigin?: SessionMessageOrigin;
  /**
   * planning#257 — which executor must run this turn if it ends up queued behind a
   * running turn. Defaults to `"dispatched"` (this IS the dispatch path). The
   * WS send handler passes `"interactive"` for a user-typed message it delegates
   * here, so the drain reproduces the interactive turn (no server echo bubble on
   * top of the client's optimistic one). See `QueuedMessage.execution`.
   */
  execution?: "interactive" | "dispatched";
  /** Spinner label shown in the chat bubble (e.g. "Creating PR…", "Auto-fixing CI…"). */
  activity?: string;
  /** Optional inline image attachments (already validated by the caller). */
  images?: ImageAttachment[];
  /** File context references resolved against the session workspace. */
  files?: FileContextRef[];
  /** Upload refs (resolved to ImageAttachment[] / FileAttachment[] before the agent runs). */
  uploads?: UploadRef[];
  /** Per-turn permission mode override. */
  permissionMode?: PermissionMode;
  /**
   * docs/169 — post-turn policy. `"commit-push"` (default) runs the normal
   * auto-commit / auto-push / PR-flow + queue drain after the turn.
   * `"none"` skips ALL of them — used by the rebase driver, which commits via
   * `git rebase --continue` and force-pushes once the whole flow finishes;
   * auto-committing mid-rebase would corrupt the rebase.
   */
  postTurn?: "commit-push" | "none";
  /**
   * docs/169 — mark this as a system turn. When true, `dispatch()` sets
   * `runner.systemTurnInProgress` synchronously (same tick as `_isRunning`)
   * for the turn's duration so a concurrent user `send_message` is queued
   * rather than steered into the system turn (and so live-steering stays
   * suppressed). Cleared when the turn completes.
   */
  systemTurn?: boolean;
  /**
   * docs/169 — fired exactly once when the turn fully completes (process exit
   * / teardown). Lets a multi-turn driver (the rebase loop) `await` one
   * resolution turn, run its git step, then dispatch the next — the one
   * capability the old hand-rolled `runRebaseResolutionTurn` had that
   * fire-and-forget `dispatch()` lacked. `errored` is true when the turn
   * ended via an agent process error. Carried through the in-memory queue
   * (docs/196 fix), so it also fires for a turn enqueued behind a running turn
   * once that turn drains and runs — not only on the idle/start-now path.
   *
   * docs/240 — kept as a thin ADAPTER over the settlement `dispatch` returns, so
   * the ~15 existing call sites migrate to `handle.settled` incrementally
   * instead of in one big-bang commit. New code should prefer the handle: it is
   * owned, resolves exactly once from a `finally`, and lets the consumer tell
   * *pending* from *lost*.
   */
  onTurnComplete?: (outcome: TurnOutcome) => void;
  /**
   * planning#266 — durable identity for a turn dispatched on behalf of a server-side
   * DELIVERY (today: a notify-on-merge wake, `watchId:attempt`). Unlike
   * `onTurnComplete` — an in-memory callback that dies with the process — this
   * id is persisted with the dispatch, sent to the worker, and reported back
   * from `/agent/status`, so a turn that outlives an orchestrator restart can
   * still be recognized as THIS delivery and have its settlement rebound
   * (`turn-adoption.ts`) instead of being redispatched over the top of.
   *
   * Absent for an ordinary user turn: there is nothing to re-settle.
   */
  deliveryId?: string;
  /**
   * docs/144 — the human dictated this prompt by voice, so the text is a
   * machine transcription. Adds a `<dictated_input>` context block to the
   * assembled prompt (see `prompt-assembly.ts`) telling the agent to read
   * mis-heard terms and missing punctuation as artifacts rather than intent.
   * Carried through the queue so a message dictated while a turn is running
   * still arrives with the hint when it drains.
   *
   * Never set by a server-originated dispatch: nothing the orchestrator
   * composes has been through speech-to-text.
   */
  dictated?: boolean;
}

export const REPOSITORY_UNTRUSTED_CODE = "repository_untrusted" as const;
export const REPOSITORY_UNTRUSTED_MESSAGE =
  "Trust this repository before sending messages to the agent.";

/** Stable, transport-independent rejection for the repository trust gate. */
export class AgentTurnAdmissionError extends Error {
  readonly statusCode = 403;
  readonly code = REPOSITORY_UNTRUSTED_CODE;

  constructor(public readonly sessionId: string) {
    super(REPOSITORY_UNTRUSTED_MESSAGE);
    this.name = "AgentTurnAdmissionError";
  }
}

/**
 * The shared send-or-queue implementation behind BOTH runners' `dispatch`
 * (docs/240). Previously duplicated field-for-field in `SessionRunner` and
 * `ContainerSessionRunner` — precisely the copy-the-logic pattern this doc
 * exists to eliminate — so it lives in one place and both delegate.
 *
 * Every branch returns a settled-or-settleable handle, so `dispatch` never
 * hands back a promise nothing can resolve:
 *
 *   - **steered** — the message was injected into the running turn, so there is
 *     no separate turn to complete; settle immediately as `steered`. (Only
 *     reachable for a dispatch carrying neither `systemTurn` nor a completion
 *     callback — planning#256's guard in `isSteerableDispatch`.)
 *   - **enqueued** — the settlement is chained onto the entry's
 *     `onTurnComplete`, which rides the in-memory queue, so it resolves when the
 *     entry later drains and runs (or `dropped` if the queue is cleared).
 *   - **started now** — chained the same way onto the running turn, and
 *     additionally bounded by the runner's lifetime: a runner disposed mid-turn
 *     settles the handle as `dropped` rather than leaving it pending forever.
 */
export function dispatchOnRunner(
  runner: SessionRunnerInterface,
  deps: SystemTurnDeps | null,
  opts: PreparedDispatch,
): TurnHandle {
  // docs/243 — the shared server security boundary. Keep this first so denial
  // cannot steer, enqueue, mutate runner state, resolve attachments, persist,
  // graduate a warm session, or start a process.
  runner.assertCanDispatch();
  const settlement = createTurnSettlement();

  const enqueueAndReport = (): TurnHandle => {
    // docs/150 — the enqueue branch broadcasts `message_queued` via emitMessage
    // so every attached viewer (and any other HTTP-originated caller in this
    // session) sees the update, rather than one socket.
    const position = runner.enqueue(toQueuedMessage(withSettlement(opts, settlement)));
    runner.emitMessage({ type: "message_queued", text: opts.text, position });
    return settlement;
  };

  if (runner.running) {
    // docs/163 — honor live steering on the dispatch path too: when the running
    // turn is steerable+streaming and live steering is on, inject the message
    // via `sendUserMessage` instead of queuing it. Shares the
    // `shouldSteerMessage` predicate with the WS handler so the two paths can't
    // diverge. NOTE: the *unchained* `opts` is what the steer gate sees, so
    // attaching a settlement can never make a previously-steerable dispatch
    // unsteerable (`isSteerableDispatch` refuses anything with `onTurnComplete`).
    if (deps && trySteerDispatch(runner, opts, deps)) {
      settlement.settle(TURN_STEERED);
      return settlement;
    }
    return enqueueAndReport();
  }
  // No system-turn deps — fall back to enqueue (drains on the next WS-initiated
  // turn).
  if (!deps) return enqueueAndReport();

  // planning#338 — `systemTurnInProgress` with `running` false is a system FLOW (the
  // rebase driver) holding the session between its own turns: the executor's
  // `tryDrain` clears `running` at `agent_result`, and the driver keeps running
  // git (stage, `rebase --continue`, force-push, the next resolution turn)
  // after each turn settles. Starting ANY other turn in that window displaces
  // the flow's agent slot and strands the workspace mid-rebase — the planning#338
  // production incident — and another SYSTEM turn (a CI fix, a wake turn) is no
  // safer: it would run against a mid-rebase tree and clear the shared flag on
  // its own teardown. Enqueue instead; the flow releases the queue when it
  // settles. The one dispatch that must pass is the flow's own resolution turn,
  // which is the sole producer of `systemTurn` + `postTurn: "none"` ("a step
  // inside a git operation the driver owns" — see dispatched-turn.ts).
  if (runner.systemTurnInProgress && !(opts.systemTurn && opts.postTurn === "none")) {
    return enqueueAndReport();
  }

  // Flip running=true synchronously BEFORE scheduling the async dispatched
  // turn. Without this, the microtask gap between `void runDispatchedTurn(...)`
  // and the executor's own `runner.running = true` is a window where a
  // concurrent WS `send_message` (e.g. the user typing while clicking Fix CI)
  // sees `running=false`, falls through to `runAgentWithMessage`, and races this
  // dispatched turn for the `_agent` slot — silently dropping one turn's SSE
  // events.
  //
  // docs/169 — set `systemTurnInProgress` in the SAME synchronous tick as
  // `running` for a system turn (rebase resolution, CI fix), so a `send_message`
  // arriving in the gap sees the flag and queues instead of steering into the
  // system turn. Cleared by `executeAgentTurn` on completion.
  if (opts.systemTurn) runner.systemTurnInProgress = true;
  runner.running = true;
  // planning#266 — publish the delivery in the SAME synchronous tick as `running`,
  // for the same reason: `runDispatchedTurn` is async (attachment resolution,
  // agent creation, run-param assembly) and `executeAgentTurn` only sets it much
  // later, so the gap would read as "this delivery is not in flight" and let the
  // retry supervisor fire a duplicate at exactly the slowest sessions.
  if (opts.deliveryId !== undefined) runner.activeDeliveryId = opts.deliveryId;
  const chained = withSettlement(opts, settlement);
  // A started turn's settlement is bounded by the RUNNER'S LIFETIME, not just by
  // the turn machinery. `settleDroppedQueueEntries` already covers the entries a
  // disposed runner throws away, but a turn that had already STARTED had nothing
  // covering it: dispose kills the agent (or the container's worker) without any
  // terminal agent event, so the executor's settling `finally` never runs and the
  // handle resolves never. A consumer awaiting it waits forever — which is how a
  // CI auto-fix attempt dispatched into a runner that then went away wedged its
  // state machine in `running` and leaked the arbiter claim for the whole
  // process lifetime. `dropped` is exactly the outcome docs/240 defined for
  // "discarded before it could finish", and reporting it through the chained
  // callback (not `settlement.settle`) keeps the pre-docs/240 `onTurnComplete`
  // consumers in the loop, as the setup-failure path below does.
  //
  // Owned here for the same reason completion and setup failure are: one place
  // starts a dispatched turn, so one place can observe it losing its runner.
  //
  // planning#282 adds the second way a started turn can lose its ability to settle
  // itself, with the runner still very much alive: every event of the turn was
  // dropped on the way from the worker (in the field, an `_agent` slot that was
  // empty from `agent_init` onward), so the terminal `agent_result` never
  // reached the executor's `finally` either. `verifyRunningState` is what
  // eventually notices — it asks the worker, is told nothing is running, and
  // resets. That reset is the turn's real terminal moment, so it settles here
  // through the same `dropped` path for the same reason.
  const settleAsDropped = (reason: string): void => {
    if (settlement.isSettled) return;
    console.warn(`[dispatch] settling the dispatched turn for ${runner.sessionId} as dropped — ${reason}`);
    chained.onTurnComplete?.(turnDropped(reason));
  };
  const onRunnerDisposed = (): void => settleAsDropped("runner disposed mid-turn");
  const onTurnAbandoned = (): void =>
    settleAsDropped("turn abandoned — worker reported no agent running");
  runner.on("disposed", onRunnerDisposed);
  runner.on("turn_abandoned", onTurnAbandoned);
  void (async () => {
    await settlement.settled;
    runner.off("disposed", onRunnerDisposed);
    runner.off("turn_abandoned", onTurnAbandoned);
  })();
  void runner.runDispatchedTurn(chained).catch((err: unknown) => {
    // planning#265 — the setup half of a dispatched turn (attachment preparation,
    // `createAgent`, run-param assembly) runs BEFORE `executeAgentTurn` owns the
    // turn, so a throw there never reaches the executor's settling `finally`.
    // Left uncaught it produced three simultaneous bad states: the handle never
    // resolved (an awaiting caller hung forever), `running` /
    // `systemTurnInProgress` stayed true so the session looked busy with no turn
    // running, and — worst — planning#260's `isDeliveryInFlight` saw a live runner and
    // read the dead attempt as *indefinitely in flight*, so the watch was never
    // retried and never reached `delivery-failed` short of a restart. That is
    // exactly the stranding class docs/240's settlement exists to end, reached
    // through the one path it did not cover.
    //
    // Owned HERE rather than at each `dispatch` call site for the same reason
    // completion is: there is one place a dispatched turn starts, so there is one
    // place it can fail to start.
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[dispatch] dispatched turn for ${runner.sessionId} failed during setup:`,
      err,
    );
    if (opts.systemTurn) runner.systemTurnInProgress = false;
    runner.running = false;
    // planning#266 — the turn never started, so the delivery is not in flight. Left
    // set, it would read as live forever and suppress every retry — the same
    // stranding class planning#265 fixed for the settlement itself.
    if (opts.deliveryId !== undefined && runner.activeDeliveryId === opts.deliveryId) {
      runner.activeDeliveryId = undefined;
    }
    // Report through the CHAINED callback, not `settlement.settle` directly:
    // the settlement is implemented on top of `onTurnComplete`, and the
    // pre-docs/240 consumers that still read the adapter (`wakeSessionWithTurn`,
    // and through it the whole notify-on-merge state machine) would otherwise
    // never hear about the failure. `isSettled` is the guard against a double
    // fire when the throw happened AFTER the executor already reported — e.g. a
    // nested queue-drain re-entry whose own setup threw, which rejects the outer
    // promise too. In that case the outer turn keeps its real outcome and only
    // the runner state is restored here.
    if (!settlement.isSettled) {
      chained.onTurnComplete?.(turnErrored(`dispatched turn failed to start: ${detail}`));
    }
    // Release the queue: the turn that was holding the runner never ran, so
    // whatever is queued behind it would otherwise sit there until the next
    // user-initiated turn. Re-entering `dispatchOnRunner` (rather than
    // hand-rolling a drain) keeps the entry on the branded, settlement-carrying
    // path — the planning#257 / planning#261 rule.
    if (runner.queueLength > 0) {
      const next = runner.dequeue();
      if (next) {
        runner.emitMessage({ type: "queue_updated", queue: runner.getQueueSnapshot() });
        dispatchOnRunner(runner, deps, queuedMessageToDispatchOptions(next));
      }
    }
  });
  return settlement;
}

/**
 * Convert a prepared dispatch into a QueuedMessage. Both shapes carry the same
 * per-turn fields; this helper exists so `dispatch`'s enqueue branch doesn't
 * open-code the field-by-field copy (and silently miss new fields the next time
 * the shape grows).
 *
 * docs/240 — takes a `PreparedDispatch`, not a bare `AgentDispatchOptions`, so
 * `enqueue(toQueuedMessage(...))` can't be used as a back door around the brand:
 * every path INTO the queue starts at one of `prepared-dispatch.ts`'s two
 * producers, exactly like every path out of it.
 */
export function toQueuedMessage(opts: PreparedDispatch): QueuedMessage {
  // planning#257 — default to the dispatched executor: it is the superset path (it
  // restores `systemTurn` / `onTurnComplete` / `postTurn` / `activity`), so an
  // untagged dispatch can never be narrowed away by the interactive drain.
  const queued: QueuedMessage = { text: opts.text, execution: opts.execution ?? "dispatched" };
  if (opts.agentInterface !== undefined) queued.agentInterface = opts.agentInterface;
  if (opts.messageOrigin !== undefined) queued.messageOrigin = opts.messageOrigin;
  if (opts.activity !== undefined) queued.activity = opts.activity;
  if (opts.images !== undefined) queued.images = opts.images;
  if (opts.files !== undefined) queued.files = opts.files;
  if (opts.uploads !== undefined) queued.uploads = opts.uploads;
  if (opts.permissionMode !== undefined) queued.permissionMode = opts.permissionMode;
  if (opts.postTurn !== undefined) queued.postTurn = opts.postTurn;
  if (opts.systemTurn !== undefined) queued.systemTurn = opts.systemTurn;
  if (opts.onTurnComplete !== undefined) queued.onTurnComplete = opts.onTurnComplete;
  if (opts.deliveryId !== undefined) queued.deliveryId = opts.deliveryId;
  if (opts.dictated !== undefined) queued.dictated = opts.dictated;
  return queued;
}

/**
 * Dependencies for server-initiated (system) turns. Injected once after the
 * runner is created. Without these, dispatch() falls back to enqueue.
 */
export interface SystemTurnDeps {
  /** Resolve server-owned session/repository trust and throw on denial. */
  authorizeDispatch?: (sessionId: string) => void;
  /** Create an AgentProcess for the given agent ID. */
  agentFactory: (agentId: AgentId) => AgentProcess;
  /**
   * Auto-commit working tree changes. Returns the new commit's hash and the
   * pre-commit HEAD ("parent") so `dispatched-turn` can link both onto the
   * last chat message — without this link `findCommitBeforeGap` returns null
   * and the rewind preview reports "0 files". Returns null if nothing to
   * commit.
   */
  autoCommit: (
    sessionDir: string,
    summary: string,
  ) => Promise<{
    commitHash: string | null;
    parentHash: string | null;
    conflictedFiles: string[];
    rebaseInProgress: boolean;
    /** docs/213 — likely secrets in the staged diff; non-empty ⇒ commit refused. */
    secretFindings: SecretFinding[];
  }>;
  /** Schedule a debounced auto-push after a commit. */
  scheduleAutoPush: (sessionDir: string) => void;
  /**
   * Shared agent-listener deps. Same shape `wireAgentListeners` consumes on
   * the WS path — sharing it means message-group accumulation + chat-history
   * persistence behaves identically regardless of who initiated the turn
   * (user message, Fix CI, child-session spawn, /agent/dispatch HTTP route,
   * rebase conflict resolution). All listener-relevant managers (session,
   * chatHistory, usage, auth) and broadcasters (sse, log) live here.
   */
  listenerDeps: AgentListenerDeps;
  /**
   * docs/149 — build the full `AgentRunParams` for this turn (system prompt,
   * model, settings, MCP, autoCreatePr, permissionMode, resume id). Without
   * this, system turns used to run with only `{ prompt, sessionId, cwd }` and
   * inherited none of the user-path agent configuration.
   */
  buildRunParams: (sessionId: string, agentId: AgentId, prompt: string) => Promise<AgentRunParams>;
  /**
   * planning#266 — re-acquire the completion settlement for a DELIVERY whose turn
   * outlived an orchestrator restart.
   *
   * Turn adoption rebuilds a live turn from the worker's report, but the
   * settlement it was dispatched with died with the previous process — so
   * before this hook the adopted turn ran to completion and settled nothing,
   * leaving the originating watch non-terminal and `reconcilePending` free to
   * queue a SECOND wake behind it. Given the worker-reported delivery id, the
   * owner of that delivery (`MergeWatchManager`) hands back the same callback
   * it would have attached at dispatch time, and the original watch settles
   * from the adopted turn.
   *
   * Returns undefined when nothing owns the id any more (the watch was
   * cancelled, re-armed, or already terminal) — the adopted turn then simply
   * runs with no settlement, exactly as any user turn does.
   */
  rebindDelivery?: (deliveryId: string) => ((outcome: TurnOutcome) => void) | undefined;
  /**
   * docs/149 — emit the PR lifecycle card after a system-turn commit lands.
   * Mirrors the WS handler's post-turn flow. Optional so tests can omit it.
   */
  postTurnPrFlow?: (
    sessionId: string,
    sessionDir: string,
    commitHash: string,
    emit: (msg: WsServerMessage) => void,
  ) => Promise<void>;
  /**
   * docs/171 — react to release markers in the turn's assistant text after the
   * turn ends. Unlike `postTurnPrFlow` this fires on EVERY turn (commit or not),
   * because a release *proposal* turn makes no commit. Optional; only the WS
   * adapter wires it (releases are user-driven chat, not system turns).
   */
  postTurnReleaseFlow?: (
    sessionId: string,
    sessionDir: string,
    turnText: string,
    emit: (msg: WsServerMessage) => void,
  ) => Promise<void>;
  /**
   * docs/216 — re-arm a merged session whose branch was reset back to a clean
   * base (e.g. `git reset --hard origin/main` after the PR merged). Like
   * `postTurnReleaseFlow` this fires on EVERY turn (commit or not): a
   * branch-pointer reset leaves a clean tree, produces no auto-commit, and so is
   * invisible to the commit-gated `postTurnPrFlow`. No-op unless the session is
   * merged AND its branch now sits exactly at the base tip. Optional.
   */
  postTurnReArmReset?: (
    sessionId: string,
    sessionDir: string,
    emit: (msg: WsServerMessage) => void,
  ) => Promise<void>;
  /**
   * docs/218 + planning#333 — run the PRE-turn auto-reset of a merged session's
   * branch onto the latest base, before this dispatched turn's prompt is built.
   *
   * docs/218 wired this on the interactive path only, on the reasoning that a
   * destructive reset underneath an automated message would surprise. The Agent
   * Interface SDK (docs/242) made that boundary wrong: a click inside an
   * agent-built page IS the user continuing the session, it arrives as a
   * dispatch, and without this hook the turn ran on a branch still sitting on
   * already-merged commits. Every other programmatic continue (`shipit session
   * message`, a notify-on-merge wake, a Create-PR button) had the same hole.
   *
   * Nothing here narrows by caller: the safety gate inside the helper already
   * refuses every case a carve-out would have (a CI-fix turn's session is not
   * merged; a rebase-driver turn is mid-sequencer; a branch with unshipped work
   * fails the merged-head check). Optional so minimal test setups can omit it.
   */
  preTurnReset?: (
    runner: PreTurnResetRunner,
    sessionId: string,
    sessionDir: string,
  ) => Promise<PreTurnResetHookResult>;
  /**
   * docs/149 — write a CLI-rotated OAuth token back to the orchestrator source
   * after a system turn. Optional; production wires it to
   * `finalizeSessionAgentEnvironment` so the agent-spawned and CI-auto-fix
   * paths participate in the same rotating-token discipline as the WS path.
   */
  finalizeAgentEnv?: (sessionId: string, agentId: AgentId) => void;
  /**
   * Run env prep (first-turn cred provision + agent pin, then the per-turn
   * OAuth token sync-in + agent-env push) immediately before building run
   * params — exactly as the WS path does inside `runAgentWithMessage`. Wired to
   * `prepareSessionAgentEnvironment`. Without this, the dispatch path syncs the
   * token early (in the service fn, before claim/graduate/worker-ready) and can
   * spawn with a token a sibling Claude session has since rotated — the
   * single-use refresh token is then dead and the CLI reports
   * `Not logged in · Please run /login` even though the source stays valid.
   * Calling it again here is idempotent (provision/pin self-skip once pinned;
   * only the token re-syncs). Optional so minimal test setups can omit it.
   */
  prepareAgentEnv?: (
    sessionId: string,
    agentId: AgentId,
    opts?: {
      /**
       * True when this turn reuses a resident agent process instead of
       * spawning one. Suppresses the destructive docs/153 leak repair, which
       * must not run under a live CLI — see
       * `prepareSessionAgentEnvironment`'s `reusingResidentAgent`.
       */
      reusingResidentAgent?: boolean;
    },
  ) => Promise<void>;
  /**
   * docs/150 — whether the persisted provider account must change before the
   * next agent is captured. The dispatch adapter uses this to retire a
   * resident streaming process before creating the incoming turn's agent;
   * environment prep later performs the credential and route switch.
   */
  needsAccountFailover?: (sessionId: string, agentId: AgentId) => boolean;
  /**
   * docs/179 — heal the agent's OAuth source token. Used by the runtime-401
   * auto-retry: when a turn's CLI emits `auth_required`, the executor awaits
   * this and, if the token rotated back to usable, re-dispatches the same turn
   * once instead of flipping the sign-in card — so a transient stale-token 401
   * recovers invisibly. Resolves `true` when the token is usable after the
   * call. Optional — when absent (tests / local runtime), the executor falls
   * back to the legacy visible re-auth flow with no retry.
   */
  ensureAgentTokenFresh?: (
    agentId: AgentId,
    accountId?: string,
    /**
     * docs/179 — `force` switches the healer from "is the source token
     * healthy?" (the cheap proactive question, answered from `expiresAt`) to
     * "give me a token this session has not already tried." The runtime-401
     * recovery MUST force: the 401 it is recovering from is itself proof that
     * the expiry timestamp is lying, so the unforced short-circuit returns
     * `true` having done nothing and the retry re-runs on identical
     * credentials. Only this dep declares the parameter — the proactive
     * callers' narrower two-argument type is deliberate.
     */
    opts?: { force?: boolean },
  ) => Promise<boolean>;
  /**
   * docs/179 — force the orchestrator's source OAuth token into this session's
   * credential subtree, bypassing the per-turn sync-in's expiry-ordering guard.
   * Wired to `repushSessionAgentToken`; called only on the runtime-401 recovery
   * path, after a successful heal and before the turn is re-dispatched, so the
   * retry cannot spawn on the same dead token the sync-in's `srcExp <= dstExp`
   * guard would have kept in place. Optional — omitted in tests / local runtime.
   */
  repushSessionAgentToken?: (sessionId: string, agentId: AgentId) => void;
  /**
   * docs/150 — the provider account this session's turn is running on, or
   * `undefined` when unpinned / on a reserved route.
   *
   * Exists so the runtime-401 recovery above can heal **that** account rather
   * than the provider. Called with no account id, `ensureAgentTokenFresh`
   * refreshes every connected account and returns `results.every(Boolean)` —
   * fine when a provider had exactly one account, wrong once it can have
   * several: a second account that is revoked or never signed in makes the
   * aggregate false, so a healthy account's turn is told it could not heal and
   * the user gets a sign-in card for an account that was fine.
   */
  resolveTurnAccountId?: (sessionId: string) => string | undefined;
  /**
   * Single shared post-turn commit helper — the same `postTurnCommit` the WS
   * path uses (auto-commit + conflict notice + workspace-locked `git add` +
   * auto-push + commit→message link). Wiring both transports to one helper is
   * the first convergence step toward a single shared turn executor. When
   * omitted, `runDispatchedTurn` falls back to its inline `autoCommit` path so
   * extreme-minimal test setups keep working. Returns the commit hash or null.
   */
  commitTurn?: (args: {
    sessionDir: string;
    sessionId: string;
    summary: string;
    turnStartHeadHash: string | null;
    runner: SessionRunnerInterface | null;
    emit: (msg: WsServerMessage) => void;
  }) => Promise<string | null>;
  /**
   * docs/163 — resolve the live steer-or-queue gate for the dispatch path.
   * Returns the user's current `liveSteering` setting and whether the runner's
   * pinned agent advertises `supportsSteering`. `dispatch` consults this (via
   * `trySteerDispatch`) so a programmatic message arriving mid-turn is injected
   * into the running turn through the SAME decision the WS handler uses, rather
   * than always being queued. Optional: when absent (minimal test setups), the
   * dispatch path always enqueues a mid-turn message (legacy behavior).
   */
  steerInputs?: () => { liveSteering: boolean; steeringCapable: boolean };
}

/**
 * Reset every per-turn field on the runner before starting a new agent turn.
 * Shared by all turn flows (WS user-typed, system-dispatched, rebase conflict
 * resolution) so message-group accumulation always starts from a clean slate
 * — without this, a stale `chatMessageGroups` from a previous turn would mix
 * into the new turn's chat history. Pair with `wireAgentListeners`.
 */
export function resetRunnerTurnState(runner: SessionRunnerInterface): void {
  // The new turn takes ownership of the per-turn accumulators and the session's
  // in-progress rows; any teardown still pending from an earlier turn compares
  // its captured epoch against this and stands down (see
  // `SessionRunnerInterface.turnEpoch`). `?? 0` keeps partial test stubs that
  // never declared the field from poisoning the counter with NaN.
  runner.turnEpoch = (runner.turnEpoch ?? 0) + 1;
  runner.clearTurnEventBuffer();
  runner.turnSummary = "";
  runner.accumulatedText = "";
  runner.accumulatedToolUse = [];
  runner.chatMessageGroups = [];
  runner.needsNewMessageGroup = true;
  runner.steeredMessages = [];
  runner.recordedCards = [];
  runner.wasInterrupted = false;
  runner.pendingCommitLink = null;
  // docs/244 / planning#299 — nothing of the new turn is on disk yet, so no body of
  // it may leave the reconnect snapshot until a boundary writes it.
  clearCommittedBodyIds(runner.committedBodyIds);
  // docs/144 — a turn the orchestrator starts is a turn boundary for the spawn
  // budget too. Not the only one: see `resetSubAgentSpawnBudget`.
  resetSubAgentSpawnBudget(runner);
  // docs/163 — clear per-turn voice-note state (authored flag + attention cap).
  resetVoiceNoteTurnState(runner);
}

/**
 * docs/144 — refill the per-turn sub-agent spawn budget (`shipit agent run`).
 *
 * Split out of `resetRunnerTurnState` because the two have different safe-reset
 * points, and coupling them left one refill point missing:
 *
 *  - `resetRunnerTurnState` clears `chatMessageGroups`, so it may only run when
 *    no turn is in flight. That is why `agent_self_wake` resets **only** when
 *    `!runner.running` — a mid-turn `task_notification` resetting there would
 *    erase the running turn's opening from chat history for good (docs/237,
 *    `integration_tests/self-wake-midturn.test.ts`).
 *  - The budget is not transcript state. Refilling it is harmless at any
 *    boundary, and it must happen at every point a NEW INSTRUCTION arrives —
 *    which is not the same set as "a new orchestrator turn starts".
 *
 * The gap that made the cap latch shut: **live steering**. A message the user
 * types while the agent is mid-turn is injected into the running turn on
 * purpose (docs/140) — no orchestrator turn starts, so `resetRunnerTurnState`
 * never runs. In a session where the agent is usually busy (the ordinary shape
 * once it backgrounds consults, which is what ShipIt's guidance tells it to do)
 * every typed message kept drawing on one budget of 3, and `shipit agent run`
 * was then refused with "cap reached for this turn" on a turn the user
 * experiences as brand new.
 *
 * So `ws-handlers/send-message.ts` calls this from its steer branch. The
 * trigger is a WS message from a browser client — a human keystroke, which no
 * agent can emit — so the forgery-resistant fan-out bound (docs/144 §5) is
 * untouched. Deliberately NOT called from agent-reachable events: a
 * programmatic steer (`trySteerDispatch`) or a CLI terminal event would let an
 * agent top up its own budget without a human ever asking for anything.
 */
export function resetSubAgentSpawnBudget(
  runner: Pick<SessionRunnerInterface, "subAgentSpawnsThisTurn">,
): void {
  runner.subAgentSpawnsThisTurn = 0;
}

/**
 * docs/179 §4 — is there a CLI process alive for this session right now?
 *
 * The predicate for "may I rewrite this session's credential topology?". It is
 * deliberately NOT `runner.running` and NOT the turn-executor's
 * `reusingResidentAgent`:
 *
 *   - `runner.running` asks whether a TURN is in flight. A streaming Claude
 *     process outlives its turn — that is the whole point of live steering —
 *     so an idle session can still hold a process that re-reads its
 *     credentials on the next request.
 *   - `reusingResidentAgent` asks what the NEXT turn intends to do. It is the
 *     right question at a spawn boundary, where the executor is choosing; it
 *     is the wrong question for the OAuth refresher and post-sign-in re-push,
 *     which fire on a wall clock with no turn in view. A system turn that
 *     declines to reuse the resident process still leaves it running until
 *     something kills it.
 *
 * Actual process liveness is the only thing that answers "could a CLI read
 * these files while I am rewriting them?".
 */
export function sessionHasLiveAgent(
  registry: SessionRunnerRegistry | null | undefined,
  sessionId: string,
): boolean {
  return (registry?.get(sessionId)?.getAgent() ?? null) !== null;
}

// ---------------------------------------------------------------------------
// SessionRunnerInterface — shared contract for direct and container runners
// ---------------------------------------------------------------------------

/**
 * Event map for SessionRunner implementations. Used with typed EventEmitter.
 */
export interface SessionRunnerEvents {
  message: [WsServerMessage];
  idle: [];
  disposed: [];
  /**
   * planning#282 — the turn that was running on this runner has been declared dead
   * WITHOUT any terminal agent event: the stuck-running reconciler
   * (`verifyRunningState`) asked the worker, was told no agent is running, and
   * reset `running` to false.
   *
   * The turn machinery never reached its settling `finally` (the events that
   * would have driven it were dropped), so nothing else can settle a dispatched
   * turn that ended this way. `dispatchOnRunner` listens for this and settles
   * the handle as `dropped`, exactly as it does for a runner disposed mid-turn.
   */
  turn_abandoned: [];
  /**
   * planning#246 — this runner's `backgroundWorkDescriptions` changed: a background
   * task appeared or drained, a consult started or finished, or the resident
   * process died and took its tasks with it.
   *
   * The marker exists so a session that is *waiting* rather than thinking still
   * reads as busy in the sidebar, and its inputs are mutated from a dozen
   * places — `setBackgroundTasks`, `clearBackgroundTasks`, the
   * `isStreamingActive` gate, sub-agent registration, `dispose`. The first
   * version of the cross-session push announced the change at each call site
   * that happened to be on the mind at the time, which left five clears silent:
   * a spawn-identity change, a credential rotation, the stuck-running
   * reconciler, and both runners' `dispose`. Each of those turned the sidebar
   * dot into a permanent green light on a session with nothing running.
   *
   * So the runner announces its own state instead, from the one place that can
   * see every mutation, and exactly one subscriber (wired in
   * `runner-registry-factory`) turns it into the SSE broadcast. Adding a sixth
   * way to clear the tracker now needs no broadcast of its own.
   */
  background_work: [];
}

/**
 * Shared interface that both SessionRunner (direct process spawning) and
 * ContainerSessionRunner (Docker-proxied) implement. All external consumers
 * (HandlerContext, SessionRunnerRegistry, WebSocket handlers) program against
 * this interface rather than a concrete class.
 */
export interface SessionRunnerInterface extends EventEmitter<SessionRunnerEvents> {
  readonly sessionId: string;
  readonly sessionDir: string;

  // Agent state
  running: boolean;
  /**
   * docs/146 — set true while a system-driven turn is running (auto-resolve
   * rebase-resolution turn, etc.) so a concurrent user `send_message` does
   * NOT live-steer into it. Live steering is suppressed by checking this
   * flag in `send-message.ts`; the message lands in the queue instead and
   * drains when the system turn finishes. The flag is owned by the system-
   * turn driver — `runRebaseResolutionTurn` flips it true at `setAgent` and
   * false in the `done` handler.
   */
  systemTurnInProgress: boolean;
  wasInterrupted: boolean;
  /**
   * planning#318 follow-up — monotonic per-runner TURN identity, bumped by
   * `resetRunnerTurnState` every time a turn takes ownership of the per-turn
   * accumulators (`chatMessageGroups`, `recordedCards`, the in-progress chat
   * rows). A teardown path that captured the epoch at its turn's start compares
   * it against the current value before touching those accumulators or the
   * session's in-progress rows: a mismatch means a SUCCESSOR turn owns them
   * now, and the stale teardown must stand down. Without this, a superseded
   * turn's late finalize (`persistInterruptedTurn`, the listener error path)
   * flipped the successor's freshly-written rows to `in_progress=0`, and the
   * successor's next boundary re-inserted its recorded cards as duplicates —
   * the double account-failover notice incident.
   */
  turnEpoch: number;
  /**
   * Volatile per-runner flag (docs/138): set true once a turn requested guarded
   * mode but the CLI reported it unavailable (plan/admin/model constraint).
   * Subsequent turns read this and silently downgrade `guarded` → `auto` so the
   * user isn't repeatedly told it's unavailable. NOT persisted to SessionManager
   * and NOT in the warm-pool snapshot — it clears on session/container restart
   * and on page reload (the client re-reads static capability), so an admin
   * later enabling auto mode is rediscovered on the next fresh attempt.
   */
  guardedUnavailable: boolean;
  /**
   * docs/193 (Thread C) — requestIds of permission prompts this session is
   * currently BLOCKED awaiting an answer on. The agent is held inside the gated
   * tool call until the user approves/denies, so a non-empty set means "this
   * session needs your approval" — surfaced as a cross-session sidebar
   * attention signal so a user focused elsewhere can see it. Mutated by the
   * permission request/resolved listeners; volatile (a rebuilt runner starts
   * empty, and the worker re-broadcasts pending requests it still holds).
   */
  readonly awaitingPermissionIds: Set<string>;
  /**
   * docs/235 — outstanding agent-initiated background tasks (a
   * `Bash(run_in_background)` job, a scheduled wake-up). Already gated on
   * process liveness and decayed, so callers can read it directly; see
   * {@link BackgroundTaskTracker} for why it is a bounded hint rather than a
   * fact. Zero for backends that don't report background work (Codex today).
   */
  readonly backgroundTaskCount: number;
  /** docs/235 — descriptions of the outstanding background tasks, for the chat status line. */
  readonly backgroundTaskDescriptions: string[];
  /**
   * planning#298 — number of sub-agent spawns this runner is currently brokering
   * (docs/144 `shipit agent run`). Non-zero means a consult is live *right now*
   * on the worker, independent of whether any turn is running: docs/236 tells
   * agents to background long consults, so the primary turn routinely ends
   * while a 30-minute review is still in flight.
   *
   * Distinct from {@link backgroundTaskCount}, which is a decayed *hint*
   * reported by the CLI and gated on a resident streaming process. This is a
   * fact the orchestrator owns — it is the size of the in-flight request set —
   * so it needs no liveness gate. Bounded by the transport timeout
   * (`SUB_AGENT_TRANSPORT_TIMEOUT_MS`), so a wedged spawn cannot pin it forever.
   */
  readonly subAgentSpawnsInFlight: number;
  /**
   * planning#246 — one label per in-flight consult ("Codex consult"), for the
   * busy marker's status line. Same set as {@link subAgentSpawnsInFlight},
   * named.
   */
  readonly subAgentSpawnLabels: string[];
  /**
   * planning#246 — what the sidebar dot and the chat status line report as
   * "busy outside a turn": the CLI's background tasks PLUS the consults this
   * runner is brokering.
   *
   * This is the UI counterpart of {@link agentBusy}'s non-turn half, and it has
   * to be the union for the same reason that predicate does. A consult is the
   * case the background-task list cannot see: it needs no resident streaming
   * process, and Codex reports no background tasks at all, so a session waiting
   * on a 30-minute review reads as *idle* on `backgroundTaskDescriptions`
   * alone — which is precisely how the sidebar came to show a live
   * `shipit agent run` review as a finished session.
   *
   * Empty means "not busy outside a turn", which is what every consumer keys
   * on; a running turn is the separate `running` axis.
   */
  readonly backgroundWorkDescriptions: string[];
  /**
   * docs/235, planning#298 — the union liveness axis every container-reclaim path
   * must consult: `running || backgroundTaskCount > 0 || subAgentSpawnsInFlight > 0`.
   *
   * `running` alone is NOT sufficient — it is only ever set by an
   * orchestrator-initiated turn, so a session whose agent woke itself (or is
   * waiting on background work that will wake it) reads as idle and gets its
   * container destroyed underneath it. Neither is `running || backgroundTaskCount`:
   * a backgrounded sub-agent consult ends the primary turn (`running` false) and
   * needs no resident streaming process (so `backgroundTaskCount` reads 0), which
   * is how planning#298 reaped a live 12-minute Codex review.
   *
   * Conversely `running` must NOT be widened to cover background tasks:
   * `send-message.ts` branches on it to decide whether an incoming user message
   * is queued/steered into an in-flight turn or starts a fresh one, and there is
   * no turn to queue behind while a task is merely pending.
   */
  readonly agentBusy: boolean;
  /** docs/235 — replace the background-task list wholesale (the backend reports a complete set). */
  setBackgroundTasks(tasks: BackgroundTaskInfo[]): void;
  /** docs/235 — drop all background-task state (agent process died; its tasks died with it). */
  clearBackgroundTasks(): void;
  /**
   * docs/140 — true when the orchestrator believes the *currently-resident*
   * agent process was spawned with `useStreaming: true` (Claude
   * `StreamingClaudeProcess`, or any future adapter whose `run({ useStreaming })`
   * actually selected the streaming path). Distinct from
   * `agentRegistry.get(...).capabilities.supportsSteering`, which is a static
   * fact about the adapter type. Without this distinction the steer gate would
   * route `sendUserMessage` to a one-shot PTY `ClaudeProcess` whose adapter
   * silently no-ops, and the user's message disappears — see
   * `docs/140-live-steering/plan.md` §"Post-stabilization cleanup". Set in
   * `runAgentWithMessage` at spawn time and cleared on `agent.done` /
   * `dispose`. Not persisted; resets on container/orchestrator restart.
   */
  isStreamingActive: boolean;
  /**
   * docs/138 — the permission mode currently applied to the resident
   * streaming agent process. Set after `agent.run()` at spawn time with the
   * mode the CLI was launched with; updated when a mid-stream
   * `set_permission_mode` control_request is pushed. Used by
   * `runAgentWithMessage` to detect mode toggles between turns and push the
   * control_request before the next `sendUserMessage` — otherwise the
   * persistent CLI keeps its spawn-time mode for life and toggling the chip
   * has no effect. Volatile: reset on dispose / setAgent(null) so a fresh
   * spawn re-applies cleanly.
   */
  appliedPermissionMode: PermissionMode | undefined;
  /**
   * What the resident agent process was SPAWNED AS — the whole spawn-relevant
   * tuple (harness, service, billing mode, model, API style, endpoint,
   * credential route), serialized by `sessionSpawnIdentity`.
   *
   * Unlike the permission mode there is no mid-stream control_request we push
   * for any of it, so a resident streaming process keeps its spawn-time shaping
   * for life — which is why the model picker used to be a no-op mid-session:
   * `set_model` persisted the new model to the session record (so the dropdown
   * checkmark moved) while every subsequent turn was still steered into the old
   * process, and the CLI's `agent_init` kept reporting the OLD model back into
   * the trigger label. Compared against the session's own identity before a turn
   * reuses the resident process; on drift the process is released so the next
   * turn respawns with the new shaping (see `resident-spawn-guard.ts`).
   *
   * docs/252 phase 3 widened this from a bare model string: a model id does not
   * identify a service, so switching the same id between two services left the
   * strings equal and ran the next turn on the previous service's endpoint and
   * credential. Volatile, and preserved across proxy churn on exactly the same
   * rule as `appliedPermissionMode`.
   */
  appliedSpawnIdentity: string | undefined;
  /**
   * docs/182 — true when the runner's most recent completed turn ended in an
   * error (agent process error, or an errored `agent_result` that wasn't a
   * deliberate interrupt). Set definitively at every turn completion (false on a
   * clean finish), mirrored to `SessionInfo.lastTurnErrored` for restart
   * durability. Read by the child-session readiness check so `shipit session
   * wait` can resolve a distinct `error` outcome rather than a false `idle`.
   * Volatile: a rebuilt runner starts `false`; the persisted session flag is the
   * authority across an orchestrator restart.
   */
  lastTurnErrored: boolean;
  accumulatedText: string;
  accumulatedToolUse: ClaudeContentBlockToolUse[];
  turnSummary: string;
  chatMessageGroups: ChatMessageGroup[];
  needsNewMessageGroup: boolean;
  steeredMessages: SteeredMessage[];
  /** Inline chat cards recorded this turn (voice notes, bug-report cards, …),
   * folded into chat history by `buildTurnMessages` so each card persists at its
   * true transcript position. Populated via `emitChatCard` / `recordChatCard`. */
  recordedCards: RecordedChatCard[];
  agentId: AgentId;
  /**
   * Commit info captured by `postTurnCommit` that couldn't be linked
   * synchronously because the agent_result handler hadn't yet persisted the
   * final chat-history rows. The `wireAgentListeners` agent_result branch
   * picks this up after replaceInProgress + finalizeInProgress so the link
   * happens on the SAME rows that get rendered. Cleared after a successful
   * link or on the next turn's reset.
   *
   * Why this exists: for codex sessions the CLI sometimes emits two
   * `agent_result` events per turn — once before the final assistant text
   * streams in, once after. The first triggers `postTurnCommit` (which
   * commits the on-disk changes from earlier tool calls) but
   * `updateLastMessage` finds no in_progress=0 rows yet. Without this
   * field the commit_hash never lands on the final row and the rewind
   * preview reports "0 files" for a turn that genuinely committed.
   */
  pendingCommitLink: { commitHash: string; parentCommitHash: string } | null;

  /**
   * docs/144 — count of sub-agent spawns reaching `services/sub-agent.ts` this
   * primary turn. Refilled by {@link resetSubAgentSpawnBudget} wherever a new
   * human instruction arrives: turn start (`resetRunnerTurnState`) and a
   * user-typed message steered into a running turn (`send-message.ts`). The
   * forgery-resistant fan-out bound: keyed by the worker-injected SESSION_ID, so
   * every spawn in the turn — including any a sub-agent forges past the
   * best-effort depth guard — decrements the same budget (cap = 3).
   */
  subAgentSpawnsThisTurn: number;

  /**
   * docs/144 — run a one-shot SUB-AGENT to completion and return its final
   * assistant text. The container runner brokers to the worker's `/agent/spawn`
   * (a subprocess outside the agent slot); the in-process runner runs the
   * adapter directly. Never touches the runner's pinned `_agent` or the SSE
   * stream. Authorization, credentials, and the per-turn cap are enforced by the
   * caller (`services/sub-agent.ts`) before this is invoked.
   */
  spawnSubAgent(req: SubAgentSpawnRequest): Promise<SubAgentRunResult>;

  getAgent(): AgentProcess | null;
  setAgent(a: AgentProcess | null): void;

  // Message queue
  readonly messageQueue: QueuedMessage[];
  readonly queueLength: number;
  enqueue(msg: QueuedMessage): number;
  dequeue(): QueuedMessage | undefined;
  clearQueue(): void;
  getQueueSnapshot(): { text: string; position: number }[];

  /**
   * planning#266 — the durable DELIVERY id of the turn currently RUNNING on this
   * runner, when it was dispatched on behalf of a server-side delivery
   * (a notify-on-merge wake, either `kind`). Undefined for an ordinary turn and
   * between turns.
   *
   * Set synchronously by `dispatchOnRunner` when it starts a turn (the same tick
   * as `running`, for the same reason: the gap before `executeAgentTurn` runs is
   * a window a supervisor could read as "not in flight"), by the executor at
   * turn start, and by TURN ADOPTION from the id the worker reports — which is
   * what makes it survive an orchestrator restart. Cleared when the turn
   * settles.
   */
  activeDeliveryId: string | undefined;
  /**
   * planning#266 — is `deliveryId` still live on this runner: RUNNING as the current
   * turn, or QUEUED behind one?
   *
   * This is the "derive liveness rather than track it" primitive docs/240 called
   * for. planning#260's in-memory `inFlight` set was *tracked* state living beside
   * the runner, so it desynchronized from a disposed runner, an adopted turn, or
   * a second runner for the same session. Asking the runner that actually owns
   * the turn (and, after a restart, whose answer came from the worker's
   * `/agent/status`) cannot drift: no runner, no delivery.
   */
  hasDelivery(deliveryId: string): boolean;
  /**
   * planning#318 — GROUND TRUTH for "is a turn in flight in this session right now?",
   * asked of whatever actually owns the agent process.
   *
   * `running` is the orchestrator's local mirror of that fact, and every bug in
   * this family has been the mirror going stale: a terminal event dropped on the
   * way from the worker leaves it true, and a superseded turn's late teardown
   * can clear it while another turn is live. Callers that merely want to be
   * polite (queue behind a busy session) can keep reading `running`; callers for
   * whom a wrong answer means DESTROYING work — a timer-driven system turn, whose
   * spawn boundary retires the resident process — should ask this instead.
   *
   * Optional: implemented by `ContainerSessionRunner` (the worker's `turnActive`
   * from `/agent/status`). The in-process `SessionRunner` owns the process
   * directly, so `running` is already ground truth there and it omits this.
   */
  hasTurnInFlight?(): Promise<boolean>;

  // Terminal
  getTerminal(): TerminalProcess | null;
  setTerminal(t: TerminalProcess | null): void;
  appendTerminalOutput(data: string): void;
  getTerminalOutputBuffer(): string;
  clearTerminalOutputBuffer(): void;

  // Auto-push timer
  getPushTimer(): ReturnType<typeof setTimeout> | null;
  setPushTimer(t: ReturnType<typeof setTimeout> | null): void;
  clearPushTimer(): void;

  // Turn event buffer
  getTurnEventBuffer(): WsServerMessage[];
  clearTurnEventBuffer(): void;
  emitMessage(msg: WsServerMessage): void;
  /** Index into the turn event buffer up to which events have been persisted to chat history.
   *  On viewer attach, only events after this index need to be replayed. */
  lastPersistedBufferIndex: number;
  /**
   * docs/244 / planning#299 — which of the running turn's heavy bodies are already on
   * disk, so the reconnect `turn_snapshot` can strip the committed prefix
   * instead of re-sending the whole turn whole. Maintained by
   * `markMessagesCommitted` at each `replaceInProgress`, cleared at turn start.
   * A stable reference with mutable contents — never reassigned.
   */
  readonly committedBodyIds: CommittedBodyIds;

  // Detected ports (per-session)
  detectedPorts: number[];

  /**
   * Authoritative cache of agent-emitted presentation METADATA (docs/093),
   * mirroring the worker's PresentRegistry — no artifact bytes. Container-only,
   * and in-process runners omit it: `present` is not a tool the agent has here.
   * Every tool on the internal `shipit` MCP bridge is a transport to the
   * worker's `/agent-ops/*` surface, so an in-process runner — which has no
   * worker — is given no bridge at all rather than tools that ECONNREFUSE. See
   * {@link LOCAL_SHIPIT_BRIDGE} in `local-agent-mcp.ts` (planning#300), which is
   * where that decision and its follow-up live.
   * Maintained from the SSE `present_content` / `present_cleared` stream so
   * `attachToRunner` can replay a `present_state` message to a late- or
   * re-connecting viewer whose Present tab would otherwise be empty after a
   * session switch (the client then re-fetches each artifact's bytes on demand).
   */
  readonly presentations?: PresentStateEntry[];

  // Remote terminal support (container mode)
  readonly supportsRemoteTerminal?: boolean;

  /**
   * True while the runner's container is still being created. Container-only —
   * in-process runners have no container and omit it.
   *
   * The missing-container reconciler skips these: a runner is registered
   * synchronously, but its container manager entry only appears partway
   * through creation, so a runner in that window is not orphaned. See
   * `ContainerSessionRunner.awaitingContainer`.
   */
  readonly awaitingContainer?: boolean;

  /**
   * Timestamp (Date.now()) of the most recent SSE event from the worker.
   * Container-only — direct runners don't have an SSE stream and may
   * omit this property entirely. Used by the container health endpoint
   * to surface "events stale 47s" when the SSE channel is broken even
   * though the container is otherwise fine.
   */
  readonly lastSseEventAt?: number;

  // Agent factory (container mode — returns a proxy that delegates to the worker)
  createAgent?(agentId: AgentId): AgentProcess;

  /**
   * Fetch Codex's built-in system skills (`~/.codex/skills/**`) from inside the
   * container. Container-only — in-process runners (tests, local mode) omit
   * this, and the skills route falls back to project skills alone. See
   * docs/138-skill-invocation (change #5b).
   */
  getCodexBuiltinSkills?(): Promise<SkillInfo[]>;

  // Viewer management
  readonly viewerCount: number;
  attachViewer(): void;
  detachViewer(): void;
  /**
   * Timestamp (Date.now()) of the most recent viewer detach. Used by the idle
   * enforcer to skip recently-disconnected runners during a grace period —
   * this prevents transient WebSocket disconnects (network blips, page
   * reloads) from triggering container disposal.
   *
   * Returns 0 when no viewer has ever detached. The value is irrelevant when
   * `viewerCount > 0` (an active viewer is attached).
   */
  readonly lastViewerDetachAt: number;
  buildPreviewStatus(): WsServerMessage;
  /** True once the runner has definitive preview state (e.g. SSE connected to worker).
   *  When false, callers should not send buildPreviewStatus() to clients — let the
   *  runner emit the status itself when ready. */
  readonly previewStatusKnown: boolean;
  /** Wait until preview state is known (SSE connected + worker reported). Resolves
   *  immediately if already known. */
  waitForPreviewStatus(): Promise<void>;

  // Compose service management
  /**
   * Attach a ServiceManager for compose lifecycle events, or detach the current
   * one by passing `null` (used when a config change removes the `compose:`
   * block). Optional — not all runners have compose.
   */
  setServiceManager?(mgr: ServiceManager | null): void;

  /**
   * Re-read the workspace's `shipit.yaml` + compose file and apply any delta to
   * the live session (see `applyShipitConfigChange`). Optional — implemented by
   * container runners only.
   *
   * Called by the in-container config-file watcher and, critically, by
   * orchestrator-side workspace rewrites that the watcher cannot be relied on
   * to report — a rebase/sync onto the latest base can bring in a new
   * `shipit.yaml` and compose file wholesale.
   */
  reevaluateWorkspaceConfig?(): void;

  /**
   * docs/240 — connect to the session worker and, if it still has a turn in
   * flight (the orchestrator restarted mid-turn), adopt it: rebuild the agent
   * proxy + listeners, replay the turn's events from its start, and let the
   * normal post-turn commit / push / PR flow run off the replayed
   * `agent_result`. Resolves to whether this runner now owns a running turn.
   *
   * Optional — implemented by container runners only (an in-process runner
   * cannot outlive the orchestrator, so there is nothing to adopt).
   */
  resumeInFlightTurn?(): Promise<boolean>;

  // Dispatched turns (docs/150)
  /** Inject dependencies needed for server-initiated agent turns. */
  setSystemTurnDeps(deps: SystemTurnDeps): void;
  /** Synchronous trust admission used by dispatch and interactive WS preflight. */
  assertCanDispatch(): void;
  /**
   * Dispatch a new agent turn. The runner's send-or-queue entry point —
   * serves both server-internal callers (Fix CI, child-session spawn) and
   * user-clicked buttons routed through the HTTP dispatch endpoint.
   *
   * Behavior:
   *   - If running: enqueues the message (carrying every field, not just text).
   *   - If idle and SystemTurnDeps are set: starts a turn directly.
   *   - If idle and deps are not configured: falls back to enqueue; the next
   *     WS-initiated turn drains it.
   *
   * docs/150 — `dispatch` is the only writer to `runner.running` /
   * `runner.messageQueue` from a turn-start path; WS handlers delegate here
   * rather than reimplementing the queueing rule inline.
   *
   * docs/240 — takes a {@link PreparedDispatch}, never a bare
   * `AgentDispatchOptions`: a hand-built literal cannot be dispatched, which is
   * what makes a re-narrowing drain site (planning#257, planning#261) a compile error
   * instead of a review catch. Returns a {@link TurnHandle} whose `settled`
   * promise resolves exactly once with the turn's {@link TurnOutcome}.
   */
  dispatch(opts: PreparedDispatch): TurnHandle;
  /**
   * planning#257 — run `opts` as a server-dispatched turn NOW, bypassing the
   * send-or-queue decision. This is the queue-drain re-entry for entries tagged
   * `execution: "dispatched"`: whichever drain shifts them (the dispatched one or
   * the WS interactive one) hands them back to `runDispatchedTurn`, so the full
   * option set survives instead of being narrowed to text + attachments.
   *
   * Only valid when `canRunDispatchedTurn` is true (system-turn deps wired).
   */
  runDispatchedTurn(opts: PreparedDispatch): Promise<void>;
  /** True once `setSystemTurnDeps` has been called — i.e. `runDispatchedTurn` is usable. */
  readonly canRunDispatchedTurn: boolean;
  /**
   * planning#301 — arm the shared debounced post-turn push for this runner's
   * workspace, for a commit made OUTSIDE a turn.
   *
   * The one caller today is the sub-agent completion path
   * (`services/sub-agent-commit.ts`): a backgrounded `shipit agent run` routinely
   * outlives the turn that started it, so its edits are committed after
   * `postTurnCommit` has already fired and nothing else would ever push them.
   *
   * Deliberately delegates to `SystemTurnDeps.scheduleAutoPush` rather than
   * re-implementing a push: that closure (`schedulePushGit` in
   * `runner-registry-factory.ts`) is the SAME one `commitTurn` → `postTurnCommit`
   * pushes through, so any gate added to the post-turn push — the merged-PR gate
   * in particular — is inherited here for free instead of having to be added a
   * second time. A no-op until `setSystemTurnDeps` has run.
   */
  schedulePostTurnPush(): void;

  // Lifecycle
  onAgentFinished(): void;
  readonly disposed: boolean;
  /**
   * Dispose the runner. By default, this is refused if the agent is currently
   * running — lifecycle events (idle cleanup, transient WebSocket disconnects)
   * must never kill a running agent. Pass `{ force: true }` from a shutdown /
   * full-reset path that explicitly wants to tear down everything.
   *
   * `preserveAgent` additionally spares everything on the WORKER side (the
   * `/agent/kill` post and the sub-agent aborts), leaving the CLI running so
   * the next orchestrator can adopt its in-flight turn. Only the
   * orchestrator-shutdown path passes it — see docs/113 and
   * `ContainerSessionRunner.dispose`. It is a no-op for the local runner,
   * whose agent is a child of this very process.
   */
  dispose(opts?: { force?: boolean; preserveAgent?: boolean }): void;

  /**
   * Reconcile the local `running` flag with the actual agent state.
   *
   * Returns `true` if the agent is genuinely running, `false` otherwise. If
   * `running` is true locally but the agent has actually finished (e.g., the
   * orchestrator missed an `agent_done` SSE event because the connection
   * dropped, or the container was restarted), this method resets the flag and
   * emits a `session_status` recovery message.
   *
   * This is the safety net that prevents users from getting stuck in a state
   * where every new message gets queued but the queue never drains. Call it
   * before consulting `running` in `send_message` / `answer_question` paths.
   */
  verifyRunningState(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// SessionRunner — in-process runner (used by integration tests)
// ---------------------------------------------------------------------------

/**
 * In-process session runner. Used by integration tests where spawning
 * Docker containers is not practical. Production uses ContainerSessionRunner.
 */
export class SessionRunner extends EventEmitter<SessionRunnerEvents> implements SessionRunnerInterface {
  readonly sessionId: string;
  readonly sessionDir: string;

  private agent: AgentProcess | null = null;
  private _agentId: AgentId;
  private _isRunning = false;
  private _systemTurnInProgress = false;
  private _wasInterrupted = false;
  /** See `SessionRunnerInterface.turnEpoch`. */
  turnEpoch = 0;
  private _lastTurnErrored = false;
  private _guardedUnavailable = false;
  readonly awaitingPermissionIds = new Set<string>();
  private _backgroundTasks = new BackgroundTaskTracker();
  private _isStreamingActive = false;
  private _appliedPermissionMode: PermissionMode | undefined = undefined;
  private _appliedSpawnIdentity: string | undefined = undefined;
  private _accumulatedText = "";
  private _accumulatedToolUse: ClaudeContentBlockToolUse[] = [];
  private _turnSummary = "";
  private _chatMessageGroups: ChatMessageGroup[] = [];
  private _needsNewMessageGroup = true;
  private _steeredMessages: SteeredMessage[] = [];
  private _recordedCards: RecordedChatCard[] = [];
  private _messageQueue: QueuedMessage[] = [];
  /** planning#266 — see `SessionRunnerInterface.activeDeliveryId`. */
  activeDeliveryId: string | undefined;
  private _terminal: TerminalProcess | null = null;
  private _terminalOutputBuffer = "";
  private static readonly MAX_TERMINAL_BUFFER = 10_000;
  private _pushTimer: ReturnType<typeof setTimeout> | null = null;
  private _turnEventBuffer: WsServerMessage[] = [];
  private static readonly MAX_TURN_BUFFER = 1000;
  private static readonly MAX_QUEUE_SIZE = 50;
  lastPersistedBufferIndex = 0;
  readonly committedBodyIds = createCommittedBodyIds();
  private _viewerCount = 0;
  private _detectedPorts: number[] = [];
  private _disposed = false;
  pendingCommitLink: { commitHash: string; parentCommitHash: string } | null = null;
  private _subAgentSpawnsThisTurn = 0;
  /**
   * docs/144 — in-flight sub-agent run handles, cancelled on dispose. Keyed by
   * handle and valued by the agent being consulted, so planning#246 can name the
   * consult in the busy marker instead of only counting it.
   */
  private _subAgentHandles = new Map<SubAgentRunHandle, AgentId>();
  /** planning#246 — last announced `backgroundWorkDescriptions`, for change detection. */
  private _lastAnnouncedWork = "[]";

  /**
   * Per-session agent factory (see `SessionRunnerInterface.createAgent`).
   *
   * A container runner implements this as a method that proxies to its worker.
   * An in-process runner has nothing to proxy to and normally leaves it unset,
   * so callers fall through to the process-wide `agentFactory`. docs/150 —
   * `buildRunnerFactory` assigns it in `RUNTIME_MODE=local` so the spawn is
   * scoped to the provider account THIS session was routed to; there is no
   * per-session credentials mount in local mode to carry that for us.
   */
  createAgent?: (agentId: AgentId) => AgentProcess;

  constructor(opts: {
    sessionId: string;
    sessionDir: string;
    defaultAgentId: AgentId;
  }) {
    super();
    this.sessionId = opts.sessionId;
    this.sessionDir = opts.sessionDir;
    this._agentId = opts.defaultAgentId;
  }

  get running(): boolean { return this._isRunning; }
  set running(v: boolean) { this._isRunning = v; }
  get systemTurnInProgress(): boolean { return this._systemTurnInProgress; }
  set systemTurnInProgress(v: boolean) { this._systemTurnInProgress = v; }
  get wasInterrupted(): boolean { return this._wasInterrupted; }
  set wasInterrupted(v: boolean) { this._wasInterrupted = v; }
  get lastTurnErrored(): boolean { return this._lastTurnErrored; }
  set lastTurnErrored(v: boolean) { this._lastTurnErrored = v; }
  get guardedUnavailable(): boolean { return this._guardedUnavailable; }
  set guardedUnavailable(v: boolean) { this._guardedUnavailable = v; }
  get isStreamingActive(): boolean { return this._isStreamingActive; }
  set isStreamingActive(v: boolean) {
    this._isStreamingActive = v;
    // The tracker's liveness gate zeroes the task list without a resident
    // streaming process, so flipping this changes the marker even though no
    // task was touched.
    this.announceBackgroundWork();
  }
  // docs/235 — the count is gated on `isStreamingActive` inside the tracker: a
  // background task cannot outlive the CLI process, so without a resident
  // streaming process the answer is definitionally zero.
  get backgroundTaskCount(): number { return this._backgroundTasks.count(this._isStreamingActive); }
  get backgroundTaskDescriptions(): string[] { return this._backgroundTasks.descriptions(this._isStreamingActive); }
  // planning#298 — a live consult is a fact we own (the in-flight handle set), not a
  // reported hint, so it needs no `isStreamingActive` gate.
  get subAgentSpawnsInFlight(): number { return this._subAgentHandles.size; }
  get subAgentSpawnLabels(): string[] {
    return [...this._subAgentHandles.values()].map((id) => `${getAgentDisplayName(id)} consult`);
  }
  get backgroundWorkDescriptions(): string[] {
    return [...this.backgroundTaskDescriptions, ...this.subAgentSpawnLabels];
  }
  get agentBusy(): boolean {
    return this._isRunning || this.backgroundTaskCount > 0 || this.subAgentSpawnsInFlight > 0;
  }
  setBackgroundTasks(tasks: BackgroundTaskInfo[]): void {
    this._backgroundTasks.set(tasks);
    this.announceBackgroundWork();
  }
  clearBackgroundTasks(): void {
    this._backgroundTasks.clear();
    this.announceBackgroundWork();
  }
  /**
   * planning#246 — emit `background_work` when the marker's value actually changed.
   *
   * Deduped on the rendered value because the inputs are touched far more often
   * than they change: `isStreamingActive` is set at both ends of every turn, and
   * a clear on an already-empty tracker is the common case. The listener turns
   * each emit into an SSE frame to every connected browser, so a bare
   * pass-through would spend frames saying nothing. Convergence after a missed
   * frame is the connect snapshot's job, not this one's.
   */
  private announceBackgroundWork(): void {
    const next = JSON.stringify(this.backgroundWorkDescriptions);
    if (next === this._lastAnnouncedWork) return;
    this._lastAnnouncedWork = next;
    this.emit("background_work");
  }
  get appliedPermissionMode(): PermissionMode | undefined { return this._appliedPermissionMode; }
  set appliedPermissionMode(v: PermissionMode | undefined) { this._appliedPermissionMode = v; }
  get appliedSpawnIdentity(): string | undefined { return this._appliedSpawnIdentity; }
  set appliedSpawnIdentity(v: string | undefined) { this._appliedSpawnIdentity = v; }
  get accumulatedText(): string { return this._accumulatedText; }
  set accumulatedText(s: string) { this._accumulatedText = s; }
  get accumulatedToolUse(): ClaudeContentBlockToolUse[] { return this._accumulatedToolUse; }
  set accumulatedToolUse(blocks: ClaudeContentBlockToolUse[]) { this._accumulatedToolUse = blocks; }
  get turnSummary(): string { return this._turnSummary; }
  set turnSummary(s: string) { this._turnSummary = s; }
  get chatMessageGroups(): ChatMessageGroup[] { return this._chatMessageGroups; }
  set chatMessageGroups(groups: ChatMessageGroup[]) { this._chatMessageGroups = groups; }
  get needsNewMessageGroup(): boolean { return this._needsNewMessageGroup; }
  set needsNewMessageGroup(v: boolean) { this._needsNewMessageGroup = v; }
  get steeredMessages(): SteeredMessage[] { return this._steeredMessages; }
  set steeredMessages(m: SteeredMessage[]) { this._steeredMessages = m; }
  get recordedCards(): RecordedChatCard[] { return this._recordedCards; }
  set recordedCards(m: RecordedChatCard[]) { this._recordedCards = m; }
  get agentId(): AgentId { return this._agentId; }
  set agentId(id: AgentId) { this._agentId = id; }
  get subAgentSpawnsThisTurn(): number { return this._subAgentSpawnsThisTurn; }
  set subAgentSpawnsThisTurn(n: number) { this._subAgentSpawnsThisTurn = n; }

  /**
   * docs/144 — local/in-process sub-agent spawn (RUNTIME_MODE=local / tests).
   * Mirrors the worker's `/agent/spawn`: instantiate a fresh adapter via the
   * system-turn agent factory, stamp `SHIPIT_AGENT_DEPTH`, run to completion,
   * and return the accumulated text — without touching the runner's pinned
   * `agent` slot. Credentials are a no-op in local mode (docs/138).
   */
  async spawnSubAgent(req: SubAgentSpawnRequest): Promise<SubAgentRunResult> {
    const factory = this._systemTurnDeps?.agentFactory;
    if (!factory) {
      return { status: "error", text: "", truncated: false, durationMs: 0, costUsd: 0, error: "Sub-agent factory unavailable" };
    }
    const agent = factory(req.agentId);
    const runOpts = {
      prompt: req.prompt,
      cwd: this.sessionDir,
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.serviceRouting !== undefined ? { serviceRouting: req.serviceRouting } : {}),
      ...(req.reasoningEffort !== undefined ? { reasoningEffort: req.reasoningEffort } : {}),
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      ...(req.maxOutputChars !== undefined ? { maxOutputChars: req.maxOutputChars } : {}),
    };
    const handle = runAgentToCompletion(agent, runOpts, Date.now());
    this._subAgentHandles.set(handle, req.agentId);
    // planning#246 — synchronously, before the first await below, so the marker
    // already counts this consult by the time the caller resumes.
    this.announceBackgroundWork();
    const prev = process.env.SHIPIT_AGENT_DEPTH;
    try {
      process.env.SHIPIT_AGENT_DEPTH = String(req.depth + 1);
      agent.run(buildSubAgentRunParams(runOpts));
      if (prev === undefined) Reflect.deleteProperty(process.env, "SHIPIT_AGENT_DEPTH");
      else process.env.SHIPIT_AGENT_DEPTH = prev;
      return await handle.promise;
    } finally {
      this._subAgentHandles.delete(handle);
      this.announceBackgroundWork();
      try { agent.kill(); } catch { /* already exited */ }
    }
  }

  getAgent(): AgentProcess | null { return this.agent; }
  setAgent(a: AgentProcess | null): void {
    // planning#318 — a DIFFERENT, newer process taking this slot means the one being
    // pushed out will never settle its own turn (its terminal event, if it ever
    // arrives, is ignored as stale). Tell it, so `executeAgentTurn` can settle
    // the superseded turn as `interrupted`. Mirrors `ContainerSessionRunner`
    // (see `supersedeDisplacedAgent` there for the full rationale); only fired
    // for a replacement, never for `setAgent(null)`, which is the ordinary
    // end-of-turn teardown.
    if (a && this.agent && this.agent !== a) this.agent.emit("superseded");
    this.agent = a;
    // Dropping the agent reference normally means the next turn either reuses a
    // newly-set agent (which `runAgentWithMessage` re-tracks at spawn) or
    // spawns fresh — either way a stale applied mode could suppress a needed
    // control_request, so we reset it. EXCEPT while a persistent streaming
    // process is still alive (`isStreamingActive`): the CLI keeps its
    // spawn-time `--permission-mode` for life, so the applied mode is still
    // authoritative across proxy/ref churn (e.g. a reload). Clearing it there
    // would make the mode-change gate compare against `undefined` and never
    // free a plan-pinned CLI ("can't exit plan mode"). A genuine process exit
    // clears `isStreamingActive`, after which the reset runs as before.
    if (a === null && !this._isStreamingActive) {
      this._appliedPermissionMode = undefined;
      // Same rule for the spawn identity: while the streaming process is still
      // alive it is still running its spawn-time model, endpoint and credential,
      // so the drift check must keep comparing against it across proxy/ref churn.
      this._appliedSpawnIdentity = undefined;
    }
  }

  get messageQueue(): QueuedMessage[] { return this._messageQueue; }
  get queueLength(): number { return this._messageQueue.length; }
  enqueue(msg: QueuedMessage): number {
    if (this._messageQueue.length >= SessionRunner.MAX_QUEUE_SIZE) {
      throw new Error(`Message queue is full (max ${SessionRunner.MAX_QUEUE_SIZE})`);
    }
    this._messageQueue.push(msg);
    return this._messageQueue.length;
  }
  dequeue(): QueuedMessage | undefined { return this._messageQueue.shift(); }
  /** planning#266 — see `SessionRunnerInterface.hasDelivery`. */
  hasDelivery(deliveryId: string): boolean {
    if (this.activeDeliveryId === deliveryId) return true;
    return this._messageQueue.some((m) => m.deliveryId === deliveryId);
  }
  clearQueue(): void {
    // docs/240 — a discarded entry SETTLES rather than silently eating its
    // completion signal (see `settleDroppedQueueEntries`).
    settleDroppedQueueEntries(this._messageQueue, "queue cleared");
    this._messageQueue.length = 0;
  }
  getQueueSnapshot(): { text: string; position: number }[] {
    return this._messageQueue.map((item, idx) => ({ text: item.text, position: idx + 1 }));
  }

  getTerminal(): TerminalProcess | null { return this._terminal; }
  setTerminal(t: TerminalProcess | null): void { this._terminal = t; }
  appendTerminalOutput(data: string): void {
    this._terminalOutputBuffer += data;
    if (this._terminalOutputBuffer.length > SessionRunner.MAX_TERMINAL_BUFFER) {
      this._terminalOutputBuffer = this._terminalOutputBuffer.slice(-SessionRunner.MAX_TERMINAL_BUFFER);
    }
  }
  getTerminalOutputBuffer(): string { return this._terminalOutputBuffer; }
  clearTerminalOutputBuffer(): void { this._terminalOutputBuffer = ""; }

  getPushTimer(): ReturnType<typeof setTimeout> | null { return this._pushTimer; }
  setPushTimer(t: ReturnType<typeof setTimeout> | null): void { this._pushTimer = t; }
  clearPushTimer(): void {
    if (this._pushTimer) { clearTimeout(this._pushTimer); this._pushTimer = null; }
  }

  getTurnEventBuffer(): WsServerMessage[] { return [...this._turnEventBuffer]; }
  clearTurnEventBuffer(): void { this._turnEventBuffer = []; this.lastPersistedBufferIndex = 0; }
  emitMessage(msg: WsServerMessage): void {
    if (this._turnEventBuffer.length < SessionRunner.MAX_TURN_BUFFER) {
      this._turnEventBuffer.push(msg);
    } else if (this._turnEventBuffer.length === SessionRunner.MAX_TURN_BUFFER) {
      // Evict: keep first 10 (init/model_info) + most recent, then append
      const keep = 10;
      const recent = this._turnEventBuffer.length - keep;
      this._turnEventBuffer = [
        ...this._turnEventBuffer.slice(0, keep),
        ...this._turnEventBuffer.slice(recent),
        msg,
      ];
    }
    this.emit("message", msg);
  }

  get detectedPorts(): number[] { return this._detectedPorts; }
  set detectedPorts(ports: number[]) { this._detectedPorts = ports; }
  get viewerCount(): number { return this._viewerCount; }
  private _lastViewerDetachAt = 0;
  get lastViewerDetachAt(): number { return this._lastViewerDetachAt; }
  attachViewer(): void {
    this._viewerCount++;
    // Clear the detach timestamp on any attach — a viewer is back, and the
    // grace period only matters when no viewers are attached. If viewers
    // come and go later, the timestamp will be re-armed only when the LAST
    // one detaches (see detachViewer() below).
    this._lastViewerDetachAt = 0;
  }
  detachViewer(): void {
    this._viewerCount = Math.max(0, this._viewerCount - 1);
    // Arm the grace-period timer ONLY when the last viewer detaches AND it's
    // not already armed. Two safety properties:
    //   1. Multi-viewer: detaching one of several viewers does not start the
    //      grace period — the runner is still actively viewed.
    //   2. Defensive: a stray double-detach (e.g. test or buggy caller) when
    //      count is already 0 doesn't reset an existing timer, so the grace
    //      period can't be extended by repeated detach calls.
    if (this._viewerCount === 0 && this._lastViewerDetachAt === 0) {
      this._lastViewerDetachAt = Date.now();
    }
  }
  buildPreviewStatus(): WsServerMessage {
    return { type: "preview_status", running: false, port: 5173, url: "http://localhost:5173", sessionId: this.sessionId };
  }
  readonly previewStatusKnown: boolean = true;
  async waitForPreviewStatus(): Promise<void> { /* always known */ }

  private _systemTurnDeps: SystemTurnDeps | null = null;

  setSystemTurnDeps(deps: SystemTurnDeps): void {
    this._systemTurnDeps = deps;
  }

  assertCanDispatch(): void {
    const authorize = this._systemTurnDeps?.authorizeDispatch;
    if (!authorize) {
      if (process.env.NODE_ENV === "test") return;
      throw new AgentTurnAdmissionError(this.sessionId);
    }
    authorize(this.sessionId);
  }

  /** docs/240 — one shared send-or-queue implementation for both runners. */
  dispatch(opts: PreparedDispatch): TurnHandle {
    return dispatchOnRunner(this, this._systemTurnDeps, opts);
  }

  get canRunDispatchedTurn(): boolean { return this._systemTurnDeps !== null; }

  /** planning#301 — see `SessionRunnerInterface.schedulePostTurnPush`. */
  schedulePostTurnPush(): void {
    this._systemTurnDeps?.scheduleAutoPush(this.sessionDir);
  }

  async runDispatchedTurn(opts: PreparedDispatch): Promise<void> {
    const deps = this._systemTurnDeps!;
    await runDispatchedTurn(this, deps, this._agentId, opts, (agentId) => {
      const agent = deps.agentFactory(agentId);
      this.setAgent(agent);
      return agent;
    });
  }

  onAgentFinished(): void {
    if (!this._isRunning && this._messageQueue.length === 0) {
      this.emit("idle");
    }
  }

  /**
   * In-process: events from the agent are delivered synchronously by the
   * EventEmitter, so the local `_isRunning` flag is always in sync with the
   * agent's true state. There is no out-of-band channel that could miss
   * events. Just return the local flag.
   */
  async verifyRunningState(): Promise<boolean> {
    return this._isRunning;
  }

  get disposed(): boolean { return this._disposed; }
  dispose(opts?: { force?: boolean }): void {
    if (this._disposed) return;
    // Defensive: refuse to dispose a runner whose agent is currently running
    // unless the caller explicitly opts in (e.g., shutdown). This guarantees
    // that lifecycle events (idle cleanup, transient disconnects) never kill
    // a running agent. Callers that need unconditional teardown (shutdown)
    // pass `{ force: true }`.
    if (this._isRunning && !opts?.force) {
      console.log(`[session-runner:${this.sessionId}] dispose() skipped — agent is running`);
      return;
    }
    // planning#298 — same protection for a BACKGROUNDED sub-agent consult, mirroring
    // ContainerSessionRunner. The primary turn ends while the spawn keeps
    // running, so `_isRunning` is false and a lifecycle-driven teardown would
    // otherwise cancel a live review. An explicit `{ force: true }` still
    // proceeds and cancels the handles below.
    if (this._subAgentHandles.size > 0 && !opts?.force) {
      console.log(
        `[session-runner:${this.sessionId}] dispose() skipped — ${this._subAgentHandles.size} sub-agent spawn(s) in flight`,
      );
      return;
    }
    this._disposed = true;
    // docs/144 — cancel any in-flight sub-agent spawns before tearing down.
    for (const handle of this._subAgentHandles.keys()) {
      try { handle.cancel(); } catch { /* best-effort */ }
    }
    this._subAgentHandles.clear();
    if (this.agent) { this.agent.kill(); this.agent = null; }
    if (this._terminal) { this._terminal.kill(); this._terminal = null; }
    this.clearPushTimer();
    // docs/240 — settle anything the teardown throws away, so a consumer
    // awaiting a queued turn learns it was dropped instead of hanging forever.
    settleDroppedQueueEntries(this._messageQueue, "runner disposed");
    this._messageQueue.length = 0;
    this._turnEventBuffer = [];
    this._isRunning = false;
    this._isStreamingActive = false;
    this._backgroundTasks.clear();
    this._appliedPermissionMode = undefined;
    this._appliedSpawnIdentity = undefined;
    // planning#246 — the fields above were written directly rather than through
    // their setters, so say so before `removeAllListeners()` takes the channel
    // away. A disposed runner holds nothing outstanding, and the sidebar has no
    // other way to learn that: idle reclaim, rescue, restart and archive all
    // land here without a draining event of their own.
    this.announceBackgroundWork();
    this.emit("disposed");
    this.removeAllListeners();
  }
}

// ---------------------------------------------------------------------------
// SessionRunnerRegistry
// ---------------------------------------------------------------------------

/**
 * App-level registry of active session runners. One runner per session.
 * Manages lifecycle (create, get, dispose) and enforces resource limits.
 */
export type SessionRunnerFactory = (opts: {
  sessionId: string;
  sessionDir: string;
  defaultAgentId: AgentId;
  /** Absolute path to the per-repo dependency cache directory (container mount). */
  depCacheDir?: string;
}) => SessionRunnerInterface;

export class SessionRunnerRegistry {
  private runners = new Map<string, SessionRunnerInterface>();
  private _runnerFactory: SessionRunnerFactory;
  private _depCacheDirResolver?: (sessionId: string) => string | undefined;
  private _onRunnerIdle?: (sessionId: string) => void;
  private _onRunnerCreated?: (runner: SessionRunnerInterface) => void;

  constructor(opts?: {
    /**
     * Runner factory. Defaults to creating in-process SessionRunner instances
     * (used in tests). Production overrides with ContainerSessionRunner factory.
     */
    runnerFactory?: SessionRunnerFactory;
    /**
     * Optional resolver that returns the per-repo dependency cache directory.
     * Mounted into containers so npm/yarn/pnpm share cached downloads.
     */
    depCacheDirResolver?: (sessionId: string) => string | undefined;
    /**
     * Called when a runner transitions to idle (agent finished, queue empty).
     * Used by the orchestrator to enforce idle container limits.
     */
    onRunnerIdle?: (sessionId: string) => void;
    /**
     * Called after a runner is created. Used to inject SystemTurnDeps so
     * server-initiated turns (e.g., CI auto-fix) work without WS context.
     */
    onRunnerCreated?: (runner: SessionRunnerInterface) => void;
  }) {
    this._runnerFactory = opts?.runnerFactory ?? ((o) => new SessionRunner(o));
    this._depCacheDirResolver = opts?.depCacheDirResolver;
    this._onRunnerIdle = opts?.onRunnerIdle;
    this._onRunnerCreated = opts?.onRunnerCreated;
  }

  /** Get or create a runner for the given session. */
  getOrCreate(sessionId: string, sessionDir: string, defaultAgentId: AgentId): SessionRunnerInterface {
    let runner = this.runners.get(sessionId);
    if (runner && !runner.disposed) {
      return runner;
    }

    runner = this._runnerFactory({
      sessionId,
      sessionDir,
      defaultAgentId,
      depCacheDir: this._depCacheDirResolver?.(sessionId),
    });
    runner.on("disposed", () => this.runners.delete(sessionId));
    if (this._onRunnerIdle) {
      const cb = this._onRunnerIdle;
      runner.on("idle", () => cb(sessionId));
    }
    this._onRunnerCreated?.(runner);
    this.runners.set(sessionId, runner);
    return runner;
  }

  /** Get existing runner (if any). */
  get(sessionId: string): SessionRunnerInterface | undefined {
    const runner = this.runners.get(sessionId);
    if (runner?.disposed) {
      this.runners.delete(sessionId);
      return undefined;
    }
    return runner;
  }

  /** List all sessions with active (running) agents. */
  listActive(): string[] {
    return [...this.runners.entries()]
      .filter(([, r]) => r.running && !r.disposed)
      .map(([id]) => id);
  }

  /**
   * Dispose a specific runner. Refuses to dispose if the agent is running
   * (the underlying runner enforces this). Pass `{ force: true }` only from
   * shutdown / full-reset paths that explicitly need unconditional teardown.
   */
  dispose(sessionId: string, opts?: { force?: boolean; preserveAgent?: boolean }): void {
    this.runners.get(sessionId)?.dispose(opts);
  }

  /**
   * Dispose all runners (for full_reset / shutdown). Forced — kills running
   * agents, unless the caller passes `{ preserveAgent: true }`, which the
   * orchestrator-shutdown path does so the CLI in each container keeps working
   * and the next orchestrator can adopt its turn (docs/113 + docs/240). Full
   * reset does NOT: the user is wiping everything.
   */
  disposeAll(opts?: { preserveAgent?: boolean }): void {
    for (const runner of this.runners.values()) {
      runner.dispose({ force: true, ...(opts?.preserveAgent ? { preserveAgent: true } : {}) });
    }
    this.runners.clear();
  }

  /** Number of active runners. */
  get size(): number { return this.runners.size; }

  /**
   * Iterate over all session IDs with a registered runner. Used by the
   * missing-container reconciler to detect runners whose container has
   * vanished (Docker daemon restart, external `docker rm`, missed die
   * event during the health-monitor reconnect window).
   */
  ids(): string[] { return [...this.runners.keys()]; }
}
