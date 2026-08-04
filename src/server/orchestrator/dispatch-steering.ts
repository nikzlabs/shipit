/**
 * Shared live-steering decision for the two "send a message to a session"
 * entry points (docs/163).
 *
 * ShipIt has two divergent paths that hand a user message to a runner:
 *
 *   1. The WS path — `handleSendMessage` (ws-handlers/send-message.ts), used
 *      when the user types in the chat panel.
 *   2. The dispatch path — `runner.dispatch(...)`, used by every programmatic
 *      caller: agent-spawned child messages (`sendChildMessage`), quick
 *      sessions, CI auto-fix, and the WS path's own "not steering" fall-through.
 *
 * Before this module the steer-or-queue decision lived ONLY in the WS handler.
 * The dispatch path unconditionally enqueued a message that arrived mid-turn —
 * so a `shipit session message` sent while a steering-capable, streaming turn
 * was running was queued (and, if the turn then ended abnormally, never
 * delivered) instead of being injected into the running turn.
 *
 * `shouldSteerMessage` is the single predicate both paths consult, so they
 * cannot drift apart again. `trySteerDispatch` is the dispatch-side action:
 * when the predicate says "steer" and a resident streaming agent exists, it
 * injects the message via `sendUserMessage`, records it in chat history at its
 * true transcript position, and broadcasts `message_steered` — mirroring the
 * WS handler's steer branch.
 */

import { recordSteeredMessage, persistTurnInProgress } from "./ws-handlers/agent-listeners.js";
import type {
  SessionRunnerInterface,
  AgentDispatchOptions,
  SystemTurnDeps,
} from "./session-runner.js";
import { formatAgentInterfacePrompt } from "../shared/agent-interface-sdk/protocol.js";
import { formatSessionMessagePrompt } from "./session-message-origin.js";

/**
 * Inputs to the live-steering gate. These are exactly the conditions the WS
 * handler checked inline before this was extracted (docs/140 + docs/146):
 *
 *   - `steeringCapable` — the active adapter advertises `supportsSteering`.
 *   - `liveSteering` — the user has the live-steering setting on.
 *   - `streamingActive` — the resident process is actually a streaming process
 *     (the static capability can be true while the resident process is a
 *     one-shot PTY — e.g. the toggle was flipped on mid-turn).
 *   - `systemTurnInProgress` — a system-driven turn (rebase resolution, etc.)
 *     is running; steering an unrelated message into it would derail it.
 *
 * The caller is responsible for the `running` precondition (both paths only
 * reach here while the runner reports a turn in flight) and for confirming a
 * resident agent reference exists.
 */
export interface SteerDecisionInputs {
  steeringCapable: boolean;
  liveSteering: boolean;
  streamingActive: boolean;
  systemTurnInProgress: boolean;
}

/**
 * The single steer-or-queue predicate. `true` ⇒ inject the message into the
 * running turn; `false` ⇒ queue it for the next turn.
 */
export function shouldSteerMessage(i: SteerDecisionInputs): boolean {
  return (
    i.steeringCapable &&
    i.liveSteering &&
    i.streamingActive &&
    !i.systemTurnInProgress
  );
}

/**
 * A dispatch that MUST run as its own turn can never be steered into someone
 * else's, no matter what the running turn looks like (SHI-254).
 *
 * Two markers make a dispatch unsteerable:
 *
 *   - `systemTurn` — the incoming turn is system-driven (a notify-on-merge
 *     wake-turn, a rebase resolution, a CI auto-fix). `shouldSteerMessage` only
 *     consults `systemTurnInProgress`, i.e. whether the CURRENTLY RUNNING turn
 *     is a system turn — it says nothing about the incoming one. Without this
 *     guard a wake-turn arriving during an ordinary streaming user turn was
 *     injected into that turn: the system instruction landed mid-context in
 *     someone else's turn, violating docs/196's "delivery never preempts a
 *     running turn" invariant.
 *   - `onTurnComplete` — a completion callback only fires from a real turn's
 *     teardown (`executeAgentTurn`). The steer path returns `true` BEFORE any
 *     enqueue, so a steered dispatch drops the callback entirely: docs/196's
 *     merge watch then never advanced past `merge-observed` and `reconcilePending`
 *     re-fired it on every orchestrator restart (the duplicate-notification bug).
 *
 * No production caller relies on either being steerable: every `systemTurn`
 * dispatch (wake-session, rebase-driver, CI auto-fix) either awaits
 * `onTurnComplete` or explicitly wants steering suppressed for its duration.
 */
export function isSteerableDispatch(opts: AgentDispatchOptions): boolean {
  return !opts.systemTurn && !opts.onTurnComplete;
}

/**
 * Dispatch-path steer attempt. Returns `true` when the message was injected
 * into the running turn (so the caller must NOT enqueue), `false` when the
 * caller should fall back to enqueuing.
 *
 * Mirrors the WS handler's steer branch: `sendUserMessage` into the resident
 * streaming process, persist the steered row at its true transcript position,
 * and broadcast `message_steered` to every viewer. Dispatch callers send
 * text-only prompts (child messages, CI-fix, quick session), so we steer the
 * raw text; attachment-carrying sends only originate on the WS path, which
 * does its own richer steer before ever reaching `dispatch`.
 */
export function trySteerDispatch(
  runner: SessionRunnerInterface,
  opts: AgentDispatchOptions,
  deps: SystemTurnDeps,
): boolean {
  // SHI-254 — a system turn / a turn someone is awaiting is never steerable,
  // regardless of the running turn's shape. Checked FIRST so no steer-policy
  // wiring can talk us out of it.
  if (!isSteerableDispatch(opts)) return false;
  // No steer policy wired (minimal test setups) ⇒ legacy enqueue behavior.
  if (!deps.steerInputs) return false;
  const { liveSteering, steeringCapable } = deps.steerInputs();

  if (
    !shouldSteerMessage({
      steeringCapable,
      liveSteering,
      streamingActive: runner.isStreamingActive,
      systemTurnInProgress: runner.systemTurnInProgress,
    })
  ) {
    return false;
  }

  // Predicate passed but no resident process to talk to (e.g. the gate said
  // streaming but the ref was cleared by a concurrent terminal event). Fall
  // back to the queue rather than dropping the message.
  const agent = runner.getAgent();
  if (!agent) return false;

  // docs/138 + docs/140 — mirror turn-executor's reuseExistingAgent branch:
  // the persistent streaming CLI keeps its spawn-time `--permission-mode` for
  // life, so push a `set_permission_mode` control_request before the steered
  // send when the requested mode differs from what's applied. Without this a
  // dispatch-steered message (e.g. a plan-approval relayed programmatically)
  // stays pinned to plan mode. `undefined` is the CLI's no-flag "auto"
  // default; skip the push when the mode already matches.
  if (runner.appliedPermissionMode !== opts.permissionMode && agent.setPermissionMode) {
    agent.setPermissionMode(opts.permissionMode);
    runner.appliedPermissionMode = opts.permissionMode;
  }

  const surfacedText = opts.agentInterface
    ? formatAgentInterfacePrompt(opts.text, opts.agentInterface)
    : opts.text;
  const agentText = opts.messageOrigin
    ? formatSessionMessagePrompt(surfacedText, opts.messageOrigin)
    : surfacedText;
  agent.sendUserMessage(agentText);

  // Record + persist the steered message so it survives a reload at the spot
  // the user sent it (docs/140), then broadcast to all viewers. The dispatch
  // path steers the raw text (no assembled context), so that text is exactly
  // what the CLI echoes — pass it as `assembledPrompt` for delivery-ack +
  // turn-end-gap re-queue (docs/140).
  recordSteeredMessage(runner, opts.text, {
    assembledPrompt: agentText,
    ...(opts.agentInterface ? { agentInterface: opts.agentInterface } : {}),
    ...(opts.messageOrigin ? { messageOrigin: opts.messageOrigin } : {}),
  });
  persistTurnInProgress(deps.listenerDeps.chatHistoryManager, runner, runner.sessionId);
  runner.emitMessage({
    type: "message_steered",
    text: opts.text,
    sessionId: runner.sessionId,
    ...(opts.agentInterface ? { agentInterface: opts.agentInterface } : {}),
    ...(opts.messageOrigin ? { messageOrigin: opts.messageOrigin } : {}),
  });
  return true;
}
