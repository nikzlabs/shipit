import type { WsServerMessage, ClaudeContentBlockText, ClaudeContentBlockToolUse, TurnUsage, PermissionMode, LogSource } from "../../shared/types.js";
import type { AgentEvent, AgentProcess } from "../../shared/types.js";
import type { AgentId, SubscriptionLimitsMap } from "../../shared/types.js";
import type { SessionRunnerInterface, QueuedMessage } from "../session-runner.js";
import type { ChatHistoryManager, PersistedPermissionRequest } from "../chat-history.js";
import type { SessionManager } from "../sessions.js";
import type { UsageManager } from "../usage.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import type { AgentAuthManager } from "../agent-auth-manager.js";
import { getContextWindowForModel, DEFAULT_CONTEXT_WINDOW_TOKENS } from "../../shared/agent-registry.js";
import type { VoiceNotePayload, VoiceNoteSource } from "../../shared/types/voice-note-types.js";
import { emitChatCard, emitNoticeInTurn, buildTurnMessages, persistTurnInProgress, updateRecordedCard } from "../chat-card-persistence.js";
import type { CompactionCard } from "../../shared/types.js";
import crypto from "node:crypto";
// Phase P6 (docs/201) — concern modules split out of this file. `wireAgentListeners`
// keeps the lifecycle wiring and delegates to these.
import {
  extractToolResults,
  stampToolDurations,
  cliPermissionModeToApplied,
  isWellFormedAskUserQuestion,
  createAgentToolTracker,
} from "./agent-event-normalizer.js";
import {
  accumulateAssistantGroups,
  attachSubagentAssistant,
  attachSubagentToolResults,
  attachToolResultsToGroup,
  requeueUndeliveredSteers,
} from "./agent-message-builder.js";
import { observeVoiceNotes } from "./agent-voice-handler.js";
import { wireAuthRequiredHandler } from "./agent-auth-handler.js";
import { normalizeAgentUsageLimitError } from "./agent-rate-limits.js";

// `buildTurnMessages` / `persistTurnInProgress` now live in
// `chat-card-persistence.ts` (co-located with `recordChatCard`, which shares
// the `recordedCards` interleaving contract, and so `emitChatCard` can persist
// without an import cycle). Re-exported here so existing importers
// (send-message, dispatch-steering, agent-execution, tests) keep their
// `./agent-listeners.js` import path unchanged.
export { buildTurnMessages, persistTurnInProgress } from "../chat-card-persistence.js";

// Phase P6 (docs/201) — these helpers were extracted into sibling concern
// modules. Re-exported here so existing importers (send-message,
// dispatch-steering, agent-execution, tests) keep their `./agent-listeners.js`
// import path unchanged.
export { extractToolResults, stampToolDurations } from "./agent-event-normalizer.js";
export { recordSteeredMessage, requeueUndeliveredSteers } from "./agent-message-builder.js";
export { normalizeAgentUsageLimitError } from "./agent-rate-limits.js";

/**
 * Context-light dependency set for `wireAgentListeners`. Lifted out of the
 * WS handler context (`FullCtx = ConnectionCtx & RunnerCtx & AppCtx`) so that
 * non-WS callers — system-dispatched turns, the rebase conflict-resolution
 * driver, child-session spawns — can share the same listener implementation.
 *
 * Keep this list minimal: anything in here is something the listener actually
 * needs to do its job. New per-turn signals belong in `WireListenersOpts`,
 * not here.
 */
export interface AgentListenerDeps {
  sessionManager: SessionManager;
  chatHistoryManager: ChatHistoryManager;
  usageManager: UsageManager;
  authManager: AuthManager;
  /**
   * Per-agent auth manager map. The `auth_required` handler looks up the
   * turn's backend and calls `.start()` on the matching manager — so a
   * Codex turn that fails on auth kicks off the Codex device flow, not
   * Claude OAuth. Optional for tests; falls back to the legacy Claude-only
   * `authManager.startOAuthFlow()` when absent. (docs/155 Phase 2c)
   */
  authManagers?: Map<AgentId, AgentAuthManager>;
  /** App-level SSE broadcaster (session_list, session_started, etc.). */
  sseBroadcast: (event: string, data: unknown) => void;
  /** Append a line to the per-session log buffer. */
  broadcastLog: (source: LogSource, text: string) => void;
  /** Model the caller wants the turn to start with (before agent_init confirms). */
  getSelectedModel: () => string | undefined;
  /** Optional: push a fresh rate-limit snapshot (any agent) to the subscription badge. */
  recordAgentRateLimits?: (
    agentId: AgentId,
    session: { usedPct: number | null; resetAt: string } | null,
    weekly: { usedPct: number | null; resetAt: string } | null,
  ) => void;
  /** Optional: latest subscription-limits snapshot, used to reclassify generic CLI errors. */
  getSubscriptionLimitsSnapshot?: () => SubscriptionLimitsMap;
  /**
   * docs/153 — fire-and-forget nudge to the orchestrator-owned Claude OAuth
   * refresher. Triggered from the session-level `auth_required` handler so a
   * stale per-session token is healed for the next turn. Optional — local
   * runtime and tests omit it. Kept as a direct ref for non-WS callers
   * (credentials sync); the WS-side `auth_required` handler routes through
   * the agent-keyed {@link onAgentAuthRequired} table instead. (docs/155)
   */
  nudgeClaudeOAuthRefresh?: () => void;
  /**
   * docs/155 — per-agent dispatch for the WS-level `auth_required` event.
   * Each backend that needs a side effect on auth failure (Claude: nudge the
   * OAuth refresher; Codex: a future device-flow restart) registers itself
   * at app-DI time and the listener becomes agent-agnostic. Optional — no-op
   * if the agent has no registered hook.
   */
  onAgentAuthRequired?: (agentId: AgentId) => void;
  /**
   * docs/163 — deliver a voice note through the router. Used by the source
   * observer to emit a *derived* headline when the agent reaches an
   * `AskUserQuestion` / `ExitPlanMode` interrupt without having authored one
   * via the built-in `voice_note` tool first (the fallback floor). Optional —
   * absent in tests / minimal setups, in which case derivation is skipped.
   */
  deliverVoiceNote?: (
    payload: VoiceNotePayload,
    runner: SessionRunnerInterface,
    source: VoiceNoteSource,
  ) => void;
}

/**
 * Default context window in tokens. Kept as a re-export for legacy call
 * sites; per-model windows are resolved via `getContextWindowForModel`.
 */
export const CONTEXT_WINDOW_TOKENS = DEFAULT_CONTEXT_WINDOW_TOKENS;

/**
 * Per-turn options accepted by `wireAgentListeners`. Anything that varies
 * between callers (WS-typed, system-dispatched, rebase resolution) belongs
 * here; long-lived dependencies (managers, broadcasters) live in
 * `AgentListenerDeps`.
 */
export interface WireListenersOpts {
  isNewSession: boolean;
  persistUserMessage: (sessionId: string) => void;
  fallbackTitle?: string;
  /**
   * Session ID captured at turn start — immune to session switches. The WS
   * paths capture this from `ctx.getActiveAppSessionId()` (URL-derived on the
   * per-session route); system-dispatched and rebase paths pass the runner's
   * sessionId directly. All call sites pass a value; the optional marker is
   * a vestige of an old test-ergonomics affordance and runtime requires it.
   */
  capturedSessionId?: string;
  /**
   * The permission mode this turn actually requested from the CLI (docs/138),
   * AFTER any guarded→auto downgrade. When this is `"guarded"`, the
   * `agent_init` handler reads `init.permissionMode` to confirm the
   * classifier engaged (`"auto"`) and, if not, sets the runner's volatile
   * `guardedUnavailable` flag and emits an inline fallback notice. Undefined /
   * non-guarded turns skip the check entirely.
   */
  requestedPermissionMode?: PermissionMode;
  /**
   * Called from the `error` handler after the runner has been cleaned up.
   * `runAgentWithMessage` uses this to drain the next queued message so a
   * transient /agent/start failure (e.g. 409 race) doesn't strand the rest
   * of the queue. Awaited so any recursive turn start is sequenced inside
   * the error handler.
   */
  onError?: () => Promise<void>;
  /**
   * docs/179 — synchronous gate the `auth_required` handler calls BEFORE it
   * kills the agent: returns true when the turn executor will auto-recover this
   * auth failure (a first attempt with a token healer wired). When true, the
   * handler SUPPRESSES the visible re-auth flow (no sign-in card, no OAuth
   * start) and defers to {@link recoverAuth}; calling it also flips the
   * executor's stand-down flag so the `done` teardown lets the recovery own all
   * terminal work. Absent → the handler always surfaces re-auth (legacy flow).
   */
  willRecoverAuth?: () => boolean;
  /**
   * docs/179 — async recovery the handler kicks off after teardown when
   * {@link willRecoverAuth} returned true: heal the OAuth token and re-dispatch
   * the turn once. Resolves true when recovery is handled (re-dispatched), false
   * when the heal failed — in which case the handler surfaces the sign-in card.
   */
  recoverAuth?: () => Promise<boolean>;
  /**
   * True when this turn is being run on a persistent streaming agent
   * (live steering active, docs/140). In streaming mode the CLI can
   * genuinely block on `AskUserQuestion` (the user's answer flows back via
   * `sendUserMessage`/NDJSON on stdin), so the orchestrator must NOT
   * interrupt on the tool — that would tear down the running turn instead
   * of letting the user steer their answer in.
   */
  useStreaming?: boolean;
}

/**
 * Wire up common agent event listeners shared across every entry point that
 * runs an agent turn: WS `send_message` / `answer_question`, system-dispatched
 * turns (Fix CI, child sessions, the `/agent/dispatch` HTTP route), and the
 * rebase conflict-resolution driver. All flows share the same message-group
 * accumulator (`runner.chatMessageGroups`) so tool calls + assistant text
 * round-trip through chat history identically regardless of caller.
 *
 * `runner` must be the registry-resolved reference (not a per-connection
 * `getRunner()` result) so the listener survives WS disconnects. `null` is
 * accepted only as a defensive fallback — the listener degrades to a no-op
 * for state mutations when it's null. Callers should resolve via the registry
 * (`resolveRunner` for WS, `host` for system flows) and pass the result here.
 */
export function wireAgentListeners(
  agent: AgentProcess,
  runner: SessionRunnerInterface | null,
  deps: AgentListenerDeps,
  opts: WireListenersOpts,
): void {
  if (!opts.capturedSessionId) {
    // The previous fallback in the agent_init branch called
    // `setActiveAppSessionId(event.sessionId)` — but `event.sessionId` is the
    // Claude CLI's internal session_id (e.g. `agent-init-1`), not an app
    // session UUID. Setting it as the active app session is always wrong.
    // All callers always set capturedSessionId, so reaching this state means
    // the call site is buggy — fail loudly rather than silently mis-routing.
    throw new Error("wireAgentListeners requires opts.capturedSessionId");
  }
  // Capture the model used for this turn — sourced from `agent_init` (what the
  // CLI actually picked) or falls back to the user-selected model. Used on
  // `agent_result` to attach the model to per-turn usage so the dial can
  // re-target context window when the user switches models mid-session.
  let turnModel: string | undefined = deps.getSelectedModel();
  // Helper: emit to all viewers via runner. If runner is unexpectedly null
  // (registry lookup failed before any viewer attached), the message has
  // nowhere good to go — log and drop rather than try a per-connection send,
  // which doesn't exist on every caller anyway.
  const emitToViewers = (msg: WsServerMessage) => {
    if (runner) {
      runner.emitMessage(msg);
    } else {
      console.warn(`[agent-listeners] dropping ${msg.type} — no runner attached`);
    }
  };

  // `agent_init` fires once per Claude CLI "session" — i.e. once per top-level
  // turn AND once per Task subagent (each subagent gets its own session_id and
  // emits its own init). The log entry is meant to mark the agent process
  // actually coming up, not every internal session boundary, so gate it to the
  // first init we see for this wired-agent invocation. Without the flag, a turn
  // that dispatches a few subagents prints a wall of misleading "Agent process
  // started" entries even though only one process started.
  let hasLoggedAgentStart = false;

  // docs/153 Fix 2 — agent_session_id persistence is deferred until we have
  // evidence the CLI produced usable output. agent_init fires *before* the
  // CLI tries to read the conversation jsonl, so persisting `event.sessionId`
  // at init time would overwrite a freshly-recovered id with a doomed
  // fresh-init UUID when `--resume` is about to fail with "No conversation
  // found". Stash the first init's session id here, flush it on the first
  // signal the turn is actually running (agent_assistant, or the canonical
  // agent_result write below), and short-circuit if we see the missing-
  // conversation stderr line.
  let pendingAgentSessionId: string | null = null;
  let agentSessionIdPersisted = false;
  let missingConversationDetected = false;
  const persistAgentSessionIdIfReady = (): void => {
    if (agentSessionIdPersisted) return;
    if (missingConversationDetected) return;
    if (!pendingAgentSessionId) return;
    const turnSessionId = opts.capturedSessionId;
    if (!turnSessionId) return;
    deps.sessionManager.setAgentSessionId(turnSessionId, pendingAgentSessionId);
    agentSessionIdPersisted = true;
  };

  // ---- Suppress auto-resolved AskUserQuestion tool_results ----
  //
  // The Claude CLI auto-resolves AskUserQuestion in both `-p` headless mode AND
  // `--input-format stream-json` (live steering) — see docs/140 and the
  // AskUserQuestion comment in the agent_assistant branch below. The orchestrator
  // interrupts on seeing the tool_use, but the interrupt is asynchronous (PTY
  // Ctrl+C or a streaming `control_request`), so the auto-resolved tool_result
  // can still reach the orchestrator before the turn ends.
  //
  // If that synthetic tool_result is forwarded to the client and attached to the
  // chat-history message group, the AskUserQuestion card renders as "answered":
  // `MessageList` sets `questionDisabled = !!el.result`, and `AskUserQuestion`
  // derives `submittedAnswers` from the auto-resolved content — graying out the
  // options and rendering the synthetic string as an Other answer. The user can
  // no longer click anything to actually answer.
  //
  // Track the well-formed AskUserQuestion tool_use_ids we interrupt and drop any
  // subsequent tool_result blocks that match them, both from the broadcast event
  // and from the persisted message group. The same set also tracks ExitPlanMode
  // ids under live steering — the streaming CLI auto-resolves that tool the same
  // way, which would otherwise flip the PlanApproval card to "Plan resolved" and
  // strip its Accept/Suggest buttons before the user could act (see the
  // ExitPlanMode block in the agent_assistant branch below).
  const suppressedToolResultIds = new Set<string>();

  // ---- MCP mid-turn crash detection (docs/088) + per-tool timing (docs/185) ----
  //
  // The CLI's init event covers cold-start liveness (ClaudeAdapter →
  // `mcp_status`), but doesn't say anything when a server dies mid-turn. The
  // tracker recovers that from tool-result errors (every MCP tool call is named
  // `mcp__<server>__<tool>`), records `id → name` and a first-observation start
  // for every tool_use, and emits `mcp_server_status state:"crashed"` (deduped
  // per-turn-per-server) on a matching `is_error` result. `toolUseStartTimes`
  // feeds `stampToolDurations`. State is per-wired-agent so it resets per turn.
  // See `createAgentToolTracker` in `agent-event-normalizer.ts`.
  const toolTracker = createAgentToolTracker(opts.capturedSessionId, emitToViewers);

  agent.on("log", (source: string, text: string) => {
    deps.broadcastLog(source as "stderr" | "stdout" | "server", text);
    // docs/153 Fix 2 — when the Claude CLI's stderr reports a missing
    // conversation for the `--resume <id>` we passed, the fresh init UUID
    // the CLI emits immediately afterwards is doomed: the process exits 1
    // with no usable output. Flip into "do not persist" state so the
    // listener stops the pending agent_session_id from clobbering the DB,
    // and surface a chat-level error so the user sees why the turn aborted
    // (vs. the previous silent loop).
    if (source === "stderr" && /No conversation found with session ID/i.test(text)) {
      if (!missingConversationDetected) {
        missingConversationDetected = true;
        pendingAgentSessionId = null;
        emitToViewers({
          type: "error",
          message: "Couldn't resume the previous conversation — it appears to have been moved or removed. Send your next message to start a fresh thread.",
        });
      }
    }
  });

  agent.on("event", (rawEvent: AgentEvent) => {
    let event = rawEvent;
    // Subscription rate-limits are account-wide telemetry, not chat content:
    // route them into the limits badge (which broadcasts its own SSE) and
    // stop — forwarding as an `agent_event` would just be noise for the chat
    // message grouping. Both Claude (via the CLI's `rate_limit_event` stream
    // messages) and Codex (via `account/rateLimits/updated`) feed this same
    // single callback — the orchestrator dispatches to the right provider.
    // See docs/135.
    if (event.type === "agent_rate_limits") {
      deps.recordAgentRateLimits?.(agent.agentId, event.session, event.weekly);
      return;
    }

    // docs/140 — a live steer the backend refused (Codex rejects `turn/steer`
    // during review / manual-compaction turns with `ActiveTurnNotSteerable`).
    // The message was already optimistically rendered + recorded as an
    // in-progress steered row; rather than let it vanish, drop that row and
    // re-queue the text so it runs as the next turn. Steerability is a
    // turn-level property (a non-steerable turn rejects EVERY steer for its
    // whole duration, and a steerable one accepts them all), so popping the
    // OLDEST pending steer per rejection both preserves send order and can't
    // re-queue a steer that actually landed. This is NOT chat content — handle
    // it and return before the message accumulator, exactly like rate-limits.
    if (event.type === "agent_steer_rejected") {
      const turnSessionId = opts.capturedSessionId;
      if (runner) {
        const pending = runner.steeredMessages;
        // Pop the oldest pending steer (FIFO). Its stored `text` is the raw
        // user message (not the assembled prompt the adapter echoes back), so
        // the re-queued bubble matches what the user typed.
        const dropped = pending[0];
        if (dropped) {
          runner.steeredMessages = pending.slice(1);
          // Re-persist the in-progress set without the dropped steer so a
          // reload doesn't show it twice (once here, once when the queued turn
          // runs and persists its own user row).
          if (turnSessionId) {
            persistTurnInProgress(deps.chatHistoryManager, runner, turnSessionId);
          }
        }
        // Re-queue the original text (+ best-effort attachments). The post-turn
        // drain feeds it as the next turn once the current (non-steerable) turn
        // ends. Fall back to the adapter-echoed text if there's no record.
        const requeueText = dropped?.text ?? event.text;
        const queued: QueuedMessage = { text: requeueText };
        if (dropped?.images && dropped.images.length > 0) queued.images = dropped.images;
        if (dropped?.files && dropped.files.length > 0) {
          queued.files = dropped.files.map((f) => ({ path: f.path }));
        }
        const position = runner.enqueue(queued);
        emitToViewers({ type: "message_queued", text: requeueText, position });
        deps.broadcastLog(
          "server",
          `Live steer rejected by ${agent.agentId} (turn not steerable) — re-queued for the next turn.`,
        );
      }
      return;
    }

    // docs/140 — a live steer's delivery ACK. The streaming CLI echoes every
    // user message it accepts into a turn (`--replay-user-messages`); matching
    // that echo against the steer we sent confirms the agent will act on it.
    // Mark the oldest un-delivered steer whose assembled prompt the CLI echoed
    // as delivered, so it is NOT re-queued at turn end (an un-acked steer fell
    // into the turn-end gap and IS re-queued — see `requeueUndeliveredSteers`).
    // NOT chat content (the inline bubble was rendered by `message_steered`) —
    // handle and return before the message accumulator, like steer-rejected.
    if (event.type === "agent_user_replay") {
      if (runner) {
        const steers = runner.steeredMessages;
        const echoed = event.text.trim();
        const idx = steers.findIndex(
          (s) => !s.delivered && s.assembledPrompt?.trim() === echoed,
        );
        if (idx >= 0) {
          const next = steers.slice();
          next[idx] = { ...next[idx], delivered: true };
          runner.steeredMessages = next;
        }
        // An unmatched echo is the initial turn prompt (also replayed) or a
        // steer with no recorded assembledPrompt — harmless to ignore.
      }
      return;
    }

    // docs/178 — context compaction in flight. Transient progress only: forward
    // an emit-only "Compacting…" indicator and stop before the message
    // accumulator (it has no place in the scrollback). Like rate-limits and
    // steer-rejected, this is not chat content. Both CLIs may compact
    // unsolicited mid-turn, so this can arrive with no user `/compact`.
    if (event.type === "agent_compaction_started") {
      const turnSessionId = opts.capturedSessionId;
      if (turnSessionId) {
        emitToViewers({
          type: "compaction_status",
          sessionId: turnSessionId,
          active: true,
          ...(event.trigger ? { trigger: event.trigger } : {}),
        });
      }
      return;
    }

    // docs/178 — compaction finished. This IS transcript content (the history
    // was replaced by a summary), so persist a card via `emitChatCard` (the one
    // supported way to add a transcript card off the agent-event stream — it
    // both emits live AND records in-band with the turn so it survives a
    // reconnect, a session switch, and a full reload). Also clears the transient
    // indicator. Return before the accumulator — the card is the record.
    if (event.type === "agent_compacted") {
      const turnSessionId = opts.capturedSessionId;
      if (turnSessionId && runner) {
        emitToViewers({ type: "compaction_status", sessionId: turnSessionId, active: false });
        const card: CompactionCard = {
          id: `compaction-${crypto.randomUUID()}`,
          createdAt: new Date().toISOString(),
          ...(event.trigger ? { trigger: event.trigger } : {}),
          ...(event.preTokens !== undefined ? { preTokens: event.preTokens } : {}),
          ...(event.postTokens !== undefined ? { postTokens: event.postTokens } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        };
        emitChatCard(
          runner,
          { type: "compaction_card", sessionId: turnSessionId, card },
          { role: "assistant", text: "", compaction: card },
          { chatHistoryManager: deps.chatHistoryManager, sessionId: turnSessionId },
        );
      }
      return;
    }

    // docs/193 / SHI-112 — an agent backend raised a gated action the user must
    // approve (sensitive-file edit, escalated command). This IS transcript
    // content: persist a pending card via `emitChatCard` so it survives a
    // reconnect / switch / reload, and the user can still answer it after a
    // reload (the worker holds the request). This block sits BEFORE the raw
    // `agent_event` broadcast below, so returning here means the bare
    // `agent_permission_request` event isn't double-sent — only the card. The
    // user's answer arrives as a `resolve_permission` WS message.
    if (event.type === "agent_permission_request") {
      const turnSessionId = opts.capturedSessionId;
      if (turnSessionId && runner) {
        const createdAt = new Date().toISOString();
        const card: PersistedPermissionRequest = {
          requestId: event.requestId,
          phase: "pending",
          toolName: event.toolName,
          ...(event.path ? { path: event.path } : {}),
          ...(event.summary ? { summary: event.summary } : {}),
          ...(event.agentId ? { agentId: event.agentId } : {}),
          createdAt,
        };
        emitChatCard(
          runner,
          {
            type: "permission_request_card",
            sessionId: turnSessionId,
            requestId: event.requestId,
            toolName: event.toolName,
            ...(event.path ? { path: event.path } : {}),
            ...(event.summary ? { summary: event.summary } : {}),
            ...(event.agentId ? { agentId: event.agentId } : {}),
            createdAt,
          },
          { role: "assistant", text: "", permissionPrompt: card },
          { chatHistoryManager: deps.chatHistoryManager, sessionId: turnSessionId },
        );

        // docs/193 (Thread C) — the agent is now BLOCKED awaiting this answer.
        // Broadcast a cross-session attention signal over the global SSE so a
        // user focused on another session sees "needs your approval" in the
        // sidebar, not just inside this session's transcript.
        runner.awaitingPermissionIds.add(event.requestId);
        deps.sseBroadcast("session_attention", {
          sessionId: turnSessionId,
          awaitingPermission: true,
        });
      }
      return;
    }

    // docs/193 — the user answered a permission request. Patch the persisted
    // card to its terminal state and emit the terminal WS message so the live
    // card flips. Driven by the broker's single resolution broadcast, keyed by
    // requestId.
    if (event.type === "agent_permission_resolved") {
      const turnSessionId = opts.capturedSessionId;
      if (turnSessionId && runner) {
        const phase = event.behavior === "allow" ? "approved" : "denied";
        // The permission card resolves MID-TURN — the agent is blocked awaiting
        // the answer, so the proposing-turn row is still in_progress. A DB-only
        // `updatePermissionCard` patch would be clobbered by the next
        // `replaceInProgress` rebuild from `recordedCards` (still holding the
        // pending snapshot), reverting the card to its Approve/Deny variant on
        // the next switch/reload. Patch the recorded card in place so every
        // rebuild — and the final end-of-turn persist — carries the terminal
        // phase, then flush. Fall back to the DB-row patch only if the card
        // isn't in this turn's recorded set (the proposing turn finalized).
        const requestId = event.requestId;
        const remembered = event.remembered;
        const patchedRecorded = updateRecordedCard(
          runner,
          (m) => m.permissionPrompt?.requestId === requestId,
          (m) => ({
            ...m,
            permissionPrompt: {
              ...m.permissionPrompt!,
              phase,
              ...(remembered ? { remembered: true } : {}),
            },
          }),
        );
        if (patchedRecorded) {
          persistTurnInProgress(deps.chatHistoryManager, runner, turnSessionId);
        } else {
          deps.chatHistoryManager.updatePermissionCard(turnSessionId, event.requestId, {
            phase,
            ...(event.remembered ? { remembered: true } : {}),
          });
        }
        runner.emitMessage({
          type: "permission_resolved",
          sessionId: turnSessionId,
          requestId: event.requestId,
          phase,
          ...(event.remembered ? { remembered: true } : {}),
        });

        // docs/193 (Thread C) — clear the cross-session attention signal once no
        // permission prompt is left outstanding for this session.
        runner.awaitingPermissionIds.delete(event.requestId);
        if (runner.awaitingPermissionIds.size === 0) {
          deps.sseBroadcast("session_attention", {
            sessionId: turnSessionId,
            awaitingPermission: false,
          });
        }
      }
      return;
    }

    if (event.type === "agent_result" && event.error) {
      event = {
        ...event,
        error: normalizeAgentUsageLimitError(
          agent.agentId,
          event.error,
          deps.getSubscriptionLimitsSnapshot?.(),
        ),
      };
    }

    // Drop auto-resolved tool_result blocks for AskUserQuestion calls we
    // interrupted. See `suppressedToolResultIds` declaration for why. If
    // filtering removes every block, skip the whole event — the client has
    // nothing to render and per-type handling below would no-op on empty
    // content anyway.
    if (event.type === "agent_tool_result" && suppressedToolResultIds.size > 0) {
      const content = (event as { content?: unknown[] }).content ?? [];
      const filtered = content.filter((b) => {
        if (typeof b !== "object" || b === null) return true;
        const id = (b as Record<string, unknown>).tool_use_id;
        return typeof id !== "string" || !suppressedToolResultIds.has(id);
      });
      if (filtered.length === 0) return;
      if (filtered.length !== content.length) {
        event = { ...event, content: filtered };
      }
    }

    // Derive per-tool execution time (docs/185) by stamping each tool_result
    // block with `now - <tool_use start>`. Done before the emit so the live
    // client and the persisted `toolResults` (built downstream via
    // `extractToolResults`) share one computed value from one source.
    if (event.type === "agent_tool_result") {
      event = stampToolDurations(event, toolTracker.toolUseStartTimes, Date.now());
    }

    const isInternalStreamCompletion =
      event.type === "agent_assistant" && event.isStreamCompletion;
    if (!isInternalStreamCompletion) {
      emitToViewers({ type: "agent_event", event });
    }

    if (event.type === "agent_init") {
      // Use the session ID captured at turn start — immune to session switches.
      // Guaranteed non-null by the assert at function entry.
      const turnSessionId = opts.capturedSessionId!;
      // Record "Agent process started" only when the agent actually
      // starts emitting events — the unconditional broadcastLog at the
      // run() call site fired even when the worker rejected a duplicate
      // /agent/start (HTTP 409), producing misleading multi-start log
      // entries when the orchestrator's defensive flow couldn't catch
      // a race. agent_init is emitted by both local adapters and the
      // proxy, so this works uniformly across runtime modes. Gated to
      // the first init per turn — see the `hasLoggedAgentStart` comment
      // above for why subsequent inits (subagents, streaming turn-2)
      // must not re-log.
      // docs/178 — the Claude CLI emits a SECOND `system/init` mid-stream after
      // it compacts context (and subagents each emit their own init). Only the
      // FIRST init per wired-agent is the real process start / the turn's
      // session+permission baseline; the guarded-mode availability check below
      // is gated on this so a post-compaction re-init can't flip
      // `guardedUnavailable` or re-emit a spurious downgrade notice. `pendingAgentSessionId`
      // already resists overwrite via `??=`, so the resume key is safe too.
      const isFirstInit = !hasLoggedAgentStart;
      if (!hasLoggedAgentStart) {
        hasLoggedAgentStart = true;
        deps.broadcastLog("server", "Agent process started");
      }
      // docs/153 Fix 2 — stash the init's sessionId; persist it lazily on
      // the first agent_assistant or agent_result so a `--resume` failure
      // (which always emits a *fresh* init UUID right before exiting) can't
      // overwrite the recovered id or a healthy session's prior id. Only the
      // top-level turn's first init is recorded — subagent inits emit their
      // own sessionIds which are not the resume key for the next turn.
      pendingAgentSessionId ??= event.sessionId;
      const session = deps.sessionManager.get(turnSessionId);
      if (session) {
        emitToViewers({ type: "session_started", session });
        deps.sseBroadcast("session_started", { session });
      }
      if (opts.isNewSession) {
        // docs/140 diag — see comment in agent-execution.ts persistUserMessage.
        console.log(`[persist-user] agent_init session=${turnSessionId} (isNewSession branch)`);
        opts.persistUserMessage(turnSessionId);
      }

      if (event.model) {
        turnModel = event.model;
        emitToViewers({
          type: "model_info",
          model: event.model,
          contextWindowTokens: getContextWindowForModel(event.model),
        });
      }

      // docs/138 — guarded-mode runtime availability detection. The init
      // event's `permissionMode` is the authoritative signal: `"auto"` means
      // the classifier engaged. We only check when this turn actually
      // requested guarded; for `auto`/`plan` the field is irrelevant.
      if (opts.requestedPermissionMode === "guarded" && runner && isFirstInit) {
        if (event.permissionMode === "auto") {
          // Engaged. Clear any stale unavailable flag (e.g. an admin
          // re-enabled auto mode since the last failed attempt this session).
          runner.guardedUnavailable = false;
        } else {
          // Requested but not engaged → non-transient unavailable (plan / admin
          // lock / unsupported model). The CLI already dropped to default for
          // this turn, so we let it complete in auto-equivalent and just label
          // it. Set the volatile flag so subsequent turns silently send auto.
          runner.guardedUnavailable = true;
          emitNoticeInTurn(
            runner,
            turnSessionId,
            "Guarded mode isn't available for this account or model, so this turn is running in auto mode (no command safety check). It needs a Max, Team, or Enterprise plan and a Sonnet or Opus model.",
            deps.chatHistoryManager,
            "warn",
          );
        }
      }

      // Plan-mode desync fix — resync `appliedPermissionMode` from the CLI's
      // authoritative `init.permissionMode`. A persistent streaming CLI keeps
      // its spawn-time `--permission-mode` for life, but the orchestrator's
      // `appliedPermissionMode` bookkeeping can drift (it's cleared on
      // `setAgent(null)` during proxy recreation on reload, and the client chip
      // falls back to "auto" after a reload). When it drifts to `undefined`
      // while the CLI is still pinned to `plan`, the between-turns mode-change
      // gate (send-message / turn-executor) compares "auto requested" against
      // "auto applied", skips the freeing `set_permission_mode` push, and the
      // session is permanently wedged ("can't exit plan mode"). The init event
      // is the CLI's own report of its current mode, so trust it over local
      // bookkeeping. Only act on a recognized CLI mode — adapters that don't
      // surface it (Codex) leave the bookkeeping untouched. Not gated on
      // `isFirstInit`: a post-compaction / post-`set_permission_mode` re-init
      // also carries the real mode, and resyncing from it is always safe.
      if (runner) {
        const synced = cliPermissionModeToApplied(event.permissionMode);
        if (synced !== "unrecognized") {
          runner.appliedPermissionMode = synced;
        }
      }
    }

    if (event.type === "agent_assistant") {
      // docs/153 Fix 2 — the CLI has produced an assistant content block,
      // so the resumed (or freshly-init'd) session is real. Persist the
      // top-level init's sessionId to the DB now. agent_result's persist
      // below is the authoritative final write; this earlier persist
      // guards the case where the process exits abnormally between first
      // assistant and result (network drop, OOM, etc.) — without it the
      // next turn's --resume would lose the rotation.
      persistAgentSessionIdIfReady();

      // Multiple text blocks within a single assistant event are distinct
      // preambles separated by tool_use blocks (common when a subagent runs
      // serial tool calls in one turn). Joining with "" runs them together
      // with no separator — "…cloaker.Now I have…". Use "\n\n" so each
      // preamble renders as its own paragraph under whitespace-pre-wrap.
      const text = (event.content ?? [])
        .filter((b): b is ClaudeContentBlockText => b.type === "text")
        .map((b) => b.text)
        .join("\n\n");

      const toolBlocks = (event.content ?? [])
        .filter((b): b is ClaudeContentBlockToolUse => b.type === "tool_use");

      // Stream completion (Codex deltas finished): replace turnSummary with
      // the FULL text, but skip accumulator/chat-group updates — the deltas
      // already populated those. Without this, turnSummary would be the last
      // tiny delta (often "."), which became the commit message.
      if (event.isStreamCompletion) {
        if (text && runner) runner.turnSummary = text;
        return;
      }

      // Record every tool_use this turn — including subagent (Task) ones,
      // since their children dispatch MCP tools whose failures we still want
      // attributed to the right server. See `createAgentToolTracker` at the
      // top of this function (docs/088 mid-turn crash detection).
      if (toolBlocks.length > 0) toolTracker.recordToolUses(toolBlocks);

      // Subagent (Task) events carry parentToolUseId. Route them under the
      // group that contains the parent Task tool, *not* into the main flow —
      // otherwise nested tool calls would corrupt the parent conversation.
      // (109 — subagent transparency)
      if (event.parentToolUseId && runner) {
        attachSubagentAssistant(runner, event.parentToolUseId, text, toolBlocks);
        return;
      }

      if (text && runner) {
        runner.turnSummary = text;
        runner.accumulatedText += text;
      }

      if (toolBlocks.length > 0 && runner) {
        runner.accumulatedToolUse = [...runner.accumulatedToolUse, ...toolBlocks];
      }

      // Claude can enter plan mode by calling EnterPlanMode during an otherwise
      // auto/default turn. In streaming mode that mutates the resident CLI
      // process, so the orchestrator's applied-mode bookkeeping must follow it;
      // otherwise approving the later ExitPlanMode card looks like auto→auto
      // and we skip the set_permission_mode(undefined) control request that
      // releases the process from plan mode.
      if (runner && toolBlocks.some((t) => t.name === "EnterPlanMode")) {
        runner.appliedPermissionMode = "plan";
      }

      // Track message groups for chat history (split at tool-result boundaries).
      // The accumulation + standalone-tool-merge logic lives in
      // `agent-message-builder.ts`.
      if ((text || toolBlocks.length > 0) && runner) {
        accumulateAssistantGroups(runner, text, toolBlocks);
      }

      // docs/163 — voice notes: deliver the authored card (sole deliverer, built
      // from the tool INPUT, rides this fast channel) and, as the fallback
      // floor, a derived headline when a top-level AskUserQuestion / ExitPlanMode
      // interrupt needs the user but no authored note fired this turn. Subagent
      // calls carry `parentToolUseId` and returned early above, so they aren't
      // observed — by design (a subagent shouldn't page the user). See
      // `observeVoiceNotes` in `agent-voice-handler.ts`.
      if (runner) {
        observeVoiceNotes(runner, toolBlocks, deps.deliverVoiceNote);
      }

      // The voice-note card's durable persist is owned by `routeVoiceNote` →
      // `emitChatCard` (docs/191): emitting a card now also persists the
      // in-progress turn in the same call, so there's no window where the card
      // lives only in the live array + `recordedCards`. No separate eager
      // persist is needed here.

      // AskUserQuestion blocking: the Claude CLI in `-p` (headless) mode has no
      // way to actually wait for a real user answer — without `--input-format
      // stream-json` there's no bidirectional channel — so the CLI auto-resolves
      // the tool call (typically with an empty/"no user" result) and the model
      // continues with whatever it had planned. From the user's POV the
      // AskUserQuestion card appears AND the agent has already moved on without
      // them pressing anything.
      //
      // Fix: when we see an AskUserQuestion tool_use at the top level, interrupt
      // the CLI so it can't act on the auto-resolved result. The card stays
      // rendered (we've already emitted the event and stored the message group).
      // When the user picks an answer, `handleAnswerQuestion` resumes with
      // `--resume` and the answer as the next prompt.
      //
      // We set `wasInterrupted = true` so the existing post-turn flow (see
      // agent-execution.ts) suppresses the spurious "exited without result"
      // error and skips the queue drain. Only fires for top-level events —
      // parentToolUseId-carrying (subagent) events have already returned above.
      //
      // Gate on well-formed input: when the model emits an AskUserQuestion
      // call with missing/malformed `questions` (e.g. an empty input object,
      // which the CLI's input validator rejects with InputValidationError),
      // the AskUserQuestion card can't render at all — the client checks
      // `Array.isArray(tool.input.questions)` before rendering. Interrupting
      // here would kill the turn before the model gets the validation error
      // back, stranding the user with no card and no progress. Skip the
      // interrupt for malformed calls so the CLI's auto-resolved error reaches
      // the model and it can retry within the same turn.
      //
      // docs/140 — live steering: the original assumption was that the CLI in
      // `--input-format stream-json` mode would genuinely block awaiting the
      // user's answer. In practice it auto-resolves the tool call the same way
      // headless `-p` mode does, so the model moved on before the user could
      // pick an answer. Interrupt in both modes. In streaming mode `interrupt()`
      // is a `control_request` that ends the turn with `error_during_execution`
      // while keeping the persistent process alive, so the answer can still
      // flow back via `sendUserMessage`/NDJSON in `handleAnswerQuestion`.
      if (runner && toolBlocks.some(isWellFormedAskUserQuestion)) {
        runner.wasInterrupted = true;
        // Remember the AskUserQuestion ids so we can drop the CLI's
        // auto-resolved tool_result for them — otherwise the client renders the
        // card as already-answered and the user can't click any option.
        for (const t of toolBlocks) {
          if (isWellFormedAskUserQuestion(t)) suppressedToolResultIds.add(t.id);
        }
        agent.interrupt();
        deps.broadcastLog("server", "Agent interrupted: waiting for AskUserQuestion answer");
      }

      // ExitPlanMode blocking (live steering only). In the one-shot `-p
      // --permission-mode plan` path the CLI ends the turn at ExitPlanMode (the
      // model has presented its plan and the headless process exits), so the
      // PlanApproval card renders with its Accept/Suggest buttons intact and
      // there is nothing to fix. The persistent streaming process behaves
      // differently: ExitPlanMode auto-resolves the same way AskUserQuestion
      // does (the CLI emits an `is_error` tool_result because there's no human
      // to approve the plan exit) and the model charges ahead in the SAME turn
      // — still in plan mode, so its Write/Edit/Bash calls are blocked and it
      // complains it "can't exit plan mode." Meanwhile the auto-resolved
      // tool_result flips the PlanApproval card to "Plan resolved" and disables
      // the buttons, so the user can never click "Accept & Execute" (which is
      // what actually switches the session out of plan mode).
      //
      // Fix: mirror the AskUserQuestion treatment under streaming. Interrupt so
      // the model stops at the plan boundary, and suppress the auto-resolved
      // tool_result so the card stays interactive. The user then clicks
      // "Accept & Execute" (switches the session to auto + sends a fresh
      // "Execute the plan" message) or "Suggest Changes" — both fresh turns,
      // consistent with every other turn boundary.
      if (opts.useStreaming && runner && toolBlocks.some((t) => t.name === "ExitPlanMode")) {
        runner.wasInterrupted = true;
        for (const t of toolBlocks) {
          if (t.name === "ExitPlanMode") suppressedToolResultIds.add(t.id);
        }
        agent.interrupt();
        deps.broadcastLog("server", "Agent interrupted: waiting for plan approval");
      }
    }

    // Mark a message-group boundary when tool results arrive so the
    // next agent_assistant starts a new chat history entry.
    if (event.type === "agent_tool_result") {
      const toolResults = extractToolResults(event);

      // docs/088 mid-turn crash detection: scan tool results for failures
      // attributable to a configured MCP server. Done BEFORE the subagent
      // routing fork below so failures inside Task children are caught too.
      // No-op when there are no errors / no MCP-prefixed names — cheap to
      // call on every result block.
      if (toolResults.length > 0) toolTracker.reportMcpCrashesFromResults(toolResults);

      // Subagent tool_result events: attach to the parent group's subagentEvents
      // and do NOT split the main message group. (109 — subagent transparency)
      if (event.parentToolUseId && runner && toolResults.length > 0) {
        attachSubagentToolResults(runner, event.parentToolUseId, toolResults);
        return;
      }

      if (runner) runner.needsNewMessageGroup = true;

      // Attach tool results to the current message group
      if (toolResults.length > 0 && runner) {
        attachToolResultsToGroup(runner, toolResults);
      }

      // Persist all accumulated message groups as in-progress, interleaving any
      // live-steered user messages at their recorded position (docs/140).
      const usageSessionId = opts.capturedSessionId;
      if (usageSessionId) {
        const inProgressMessages = buildTurnMessages(
          runner?.chatMessageGroups ?? [],
          runner?.steeredMessages ?? [],
          runner?.recordedCards ?? [],
          { inProgress: true },
        );
        deps.chatHistoryManager.replaceInProgress(usageSessionId, inProgressMessages);
        if (runner) runner.lastPersistedBufferIndex = runner.getTurnEventBuffer().length;
      }
    }

    if (event.type === "agent_result") {
      const turnSessionId = opts.capturedSessionId;
      if (turnSessionId) {
        // docs/153 Fix 2 — only write the result's sessionId when the turn
        // actually produced something. A `--resume <missing-id>` turn emits
        // both agent_init AND agent_result with fresh, useless UUIDs before
        // exiting; the stderr scan above sets `missingConversationDetected`
        // which we honor here. agentSessionIdPersisted is also `true` after
        // the first assistant for healthy turns, so this stays the canonical
        // rotation write for those.
        if (!missingConversationDetected) {
          deps.sessionManager.setAgentSessionId(turnSessionId, event.sessionId);
          agentSessionIdPersisted = true;
        }
        deps.sessionManager.track(turnSessionId);
        deps.sseBroadcast("session_list", { sessions: deps.sessionManager.list() });
      }

      // docs/138 — surface guarded-mode classifier blocks inline so a guarded
      // turn never fails silently. A single block doesn't abort (the model
      // re-routes); the CLI ends a headless run only after its 3-consecutive /
      // 20-total threshold, at which point the turn produces an early/empty
      // result with these denials populated. Either way we summarize the
      // blocked tool(s) and offer next steps. Model self-refusals are NOT
      // classifier denials and never reach this array.
      //
      // Gate on `requestedPermissionMode === "guarded"`: the CLI can populate
      // `permission_denials[]` in non-guarded turns too (e.g. headless `-p`
      // auto-resolves an `AskUserQuestion` call because there's no human to
      // answer), and attributing those to "Guarded mode" was misleading the
      // user. In `auto`/`plan` mode the classifier isn't engaged, so any
      // denials in the result event are not classifier blocks and we don't
      // surface this notice.
      if (
        event.permissionDenials?.length
        && turnSessionId
        && runner
        && opts.requestedPermissionMode === "guarded"
      ) {
        const blockedTools = [...new Set(event.permissionDenials.map((d) => d.toolName))].join(", ");
        const count = event.permissionDenials.length;
        // Recorded in-band (not emit-only) so the blocked-actions summary
        // survives a reload. It fires before this turn's final persist below,
        // so buildTurnMessages interleaves it at the turn's end.
        emitNoticeInTurn(
          runner,
          turnSessionId,
          `Guarded mode blocked ${count} action${count === 1 ? "" : "s"} (${blockedTools}) as potentially unsafe. ` +
            "Rephrase with a narrower scope, run the command yourself, or switch to auto mode for this action.",
          deps.chatHistoryManager,
          "warn",
        );
      }

      const usageSessionId = turnSessionId ?? event.sessionId;

      // If the backend reported the real context window for this turn's
      // model (e.g. Opus 4.7 → 1_000_000), re-emit `model_info` with the
      // authoritative value. This overrides whatever `agent_init` derived
      // from the static `MODEL_CONTEXT_WINDOWS` map.
      if (event.contextWindow && turnModel) {
        emitToViewers({
          type: "model_info",
          model: turnModel,
          contextWindowTokens: event.contextWindow,
        });
      }

      // Build the per-turn usage record for the live `turn_usage_update` emit.
      // Per-turn data is no longer attached to chat-history messages — the
      // canonical per-turn series is owned by `UsageManager` and rehydrated
      // from there via `GET /api/sessions/:id/history` (see B in the
      // ContextDial cost-display unification).
      let perTurnUsage: TurnUsage | undefined;
      const hasUsageTelemetry =
        event.cost?.totalUsd !== undefined
        || event.tokens?.input !== undefined
        || event.tokens?.output !== undefined;
      if (hasUsageTelemetry) {
        perTurnUsage = {
          inputTokens: event.tokens?.input ?? 0,
          outputTokens: event.tokens?.output ?? 0,
          costUsd: event.cost?.totalUsd ?? 0,
          durationMs: event.durationMs,
          timestamp: new Date().toISOString(),
        };
        if (event.tokens?.cacheRead !== undefined) perTurnUsage.cacheRead = event.tokens.cacheRead;
        if (event.tokens?.cacheWrite !== undefined) perTurnUsage.cacheCreate = event.tokens.cacheWrite;
        if (turnModel) perTurnUsage.model = turnModel;
        // `contextTokens` is the real context-window occupancy at turn end
        // (last iteration's input + cache). Distinct from `inputTokens +
        // cacheRead + cacheCreate`, which sums over every iteration and
        // dramatically overstates context for tool-heavy turns.
        if (event.contextTokens !== undefined) perTurnUsage.contextTokens = event.contextTokens;
      }

      if (perTurnUsage) {
        // Some backends, including Codex app-server, report authoritative token
        // usage but no dollar cost. Persist those turns with a zero-dollar
        // value so session turn counts, token history, and rehydration still
        // work; do not estimate pricing here.
        deps.usageManager.record(
          usageSessionId,
          perTurnUsage.costUsd,
          event.durationMs ?? 0,
          event.tokens?.input,
          event.tokens?.output,
          {
            cacheRead: event.tokens?.cacheRead,
            cacheCreate: event.tokens?.cacheWrite,
            model: turnModel,
            contextTokens: event.contextTokens,
          },
        );
        const sessionUsage = deps.usageManager.getSessionUsage(usageSessionId);
        if (sessionUsage) {
          const tokenTotals = deps.usageManager.getSessionTokenTotals(usageSessionId);
          emitToViewers({
            type: "usage_update",
            sessionId: sessionUsage.sessionId,
            totalCostUsd: sessionUsage.totalCostUsd,
            totalDurationMs: sessionUsage.totalDurationMs,
            turnCount: sessionUsage.turnCount,
            lastTurnInputTokens: event.tokens?.input,
            lastTurnOutputTokens: event.tokens?.output,
            cumulativeInputTokens: tokenTotals?.cumulativeInputTokens,
            cumulativeOutputTokens: tokenTotals?.cumulativeOutputTokens,
          });
          if (perTurnUsage) {
            emitToViewers({
              type: "turn_usage_update",
              sessionId: sessionUsage.sessionId,
              turn: perTurnUsage,
              totalCostUsd: sessionUsage.totalCostUsd,
              turnCount: sessionUsage.turnCount,
            });
          }
        }
      }

      // docs/140 — recover any live steer the CLI never acknowledged this turn
      // (one that fell into the turn-end gap: written to stdin while `running`
      // was still true, but the model had already finished and never applied or
      // echoed it). Re-queue it BEFORE the finalize below so the un-acked steer
      // is excluded from this turn's rows and instead runs as the next turn via
      // the executor's post-turn drain — an automatic resend rather than a lost
      // message. No-op off the live-steer path.
      if (runner) requeueUndeliveredSteers(runner, emitToViewers);

      // Persist each message group as a separate assistant entry so that
      // reloaded chat history shows the same message boundaries as live
      // streaming. Per-turn usage is no longer attached to the last group —
      // the per-turn cost/token series lives in `usage_turns` and is fetched
      // alongside chat history by the `/history` HTTP endpoint.
      const finalMessages = buildTurnMessages(
        runner?.chatMessageGroups ?? [],
        runner?.steeredMessages ?? [],
        runner?.recordedCards ?? [],
        { inProgress: false },
      );
      deps.chatHistoryManager.replaceInProgress(usageSessionId, finalMessages);
      deps.chatHistoryManager.finalizeInProgress(usageSessionId);
      if (runner) runner.lastPersistedBufferIndex = runner.getTurnEventBuffer().length;

      // If `postTurnCommit` ran earlier in this turn (e.g. the codex CLI's
      // first `turn/completed` arrived BEFORE the final assistant text events)
      // but couldn't link the commit because there were no in_progress=0 rows
      // yet, the link info was stashed on the runner. Apply it now that the
      // rows actually exist. This is the second half of the fix described in
      // `postTurnCommit` (see `opts.runner` there).
      if (runner?.pendingCommitLink) {
        const { commitHash, parentCommitHash } = runner.pendingCommitLink;
        const updatedId = deps.chatHistoryManager.updateLastMessage(usageSessionId, {
          commitHash,
          parentCommitHash,
        });
        if (updatedId !== null) {
          runner.pendingCommitLink = null;
          const messageIndex = deps.chatHistoryManager.indexOfMessageId(usageSessionId, updatedId);
          if (messageIndex >= 0) {
            emitToViewers({
              type: "commit_linked",
              messageIndex,
              commitHash,
              parentCommitHash,
            });
          }
        }
      }

      // docs/182 — record the turn's terminal error state definitively at
      // completion (true when this result carries an error that wasn't a
      // deliberate interrupt; false on a clean finish). Mirrored to the session
      // row so it survives an orchestrator restart, and read by the
      // child-session readiness check so `shipit session wait` resolves a
      // distinct `error` outcome instead of a false `idle`. Writing on every
      // completion means a child that errored then succeeded on a follow-up turn
      // clears the flag without a separate reset.
      const turnErrored = Boolean((event as { error?: unknown }).error) && !runner?.wasInterrupted;
      if (runner) runner.lastTurnErrored = turnErrored;
      if (turnSessionId) deps.sessionManager.setLastTurnErrored(turnSessionId, turnErrored);

      // Mark turn as complete immediately — don't wait for async post-turn
      // work (git commit, PR lifecycle) in the "done" handler. This closes
      // the timing window where a reconnecting viewer sees running=true.
      // Use runner directly (not ctx) so this works even after WS disconnect.
      if (runner) {
        runner.running = false;
        runner.clearTurnEventBuffer();
      }
      if (turnSessionId) {
        emitToViewers({
          type: "session_status",
          sessionId: turnSessionId,
          running: false,
          queueLength: runner?.queueLength ?? 0,
        });
      }
    }
  });

  // docs/179 — `auth_required` handling (auth-failure recovery / token refresh)
  // lives in `agent-auth-handler.ts`. It reads only turn-start-captured values
  // (`opts.capturedSessionId`, the resolved `runner`) and emits via
  // `emitToViewers`, preserving the WS-lifecycle invariant.
  wireAuthRequiredHandler(agent, runner, deps, opts, emitToViewers);

  agent.on("error", async (err: Error) => {
    console.error("[agent] process error:", err.message);
    deps.broadcastLog("server", `Agent process error: ${err.message}`);
    emitToViewers({ type: "error", message: `Agent process error: ${err.message}` });
    const turnSessionId = opts.capturedSessionId;
    if (turnSessionId) {
      // Preserve whatever partial turn the agent produced before it errored.
      // Mirrors the agent_result path: persist the accumulated message groups
      // and finalize them, *then* append the error message. The old code
      // called clearInProgress() here, which deleted the entire in-progress
      // turn — so a crash mid-turn wiped all of the agent's work from the UI
      // on the next history load.
      // Pass empty steers (this path historically drops them) but keep recorded
      // cards so a voice note / bug-report card recorded before the crash isn't
      // lost on reload — the card is folded in at its true position, same as a
      // clean finalize.
      const partialMessages = buildTurnMessages(
        runner?.chatMessageGroups ?? [],
        [],
        runner?.recordedCards ?? [],
        { inProgress: false },
      );
      deps.chatHistoryManager.replaceInProgress(turnSessionId, partialMessages);
      deps.chatHistoryManager.finalizeInProgress(turnSessionId);
      deps.chatHistoryManager.append(turnSessionId, {
        role: "assistant",
        text: `Error: ${err.message}`,
        isError: true,
      });
    }
    // Clear runner state so a stuck `running=true` doesn't make this runner
    // permanently undisposable. Some adapter paths emit `error` without a
    // follow-up `done` (e.g. spawn failure in claude.ts:94, agent_error SSE
    // event from the worker without a subsequent agent_done) — without this
    // reset, `runner.dispose()`'s running-guard would refuse forever.
    // Setting running=false also lets the periodic idle enforcer reclaim the
    // session normally. Emit `idle` if appropriate so post-cleanup proceeds.
    if (runner) {
      // Identity-guard: only clear the runner's agent ref if it still points
      // at us. A later turn may already have replaced it; clobbering to null
      // would silently drop every subsequent SSE event from that turn.
      if (runner.getAgent() === agent) {
        runner.setAgent(null);
        // docs/140 — streaming process is gone; reset the gate.
        runner.isStreamingActive = false;
      }
      runner.running = false;
      // docs/182 — a process-level error is a terminal turn error: record it on
      // the runner and persist it so `shipit session wait` reports `error`
      // (exit 3) even after an orchestrator restart loses the in-memory flag.
      runner.lastTurnErrored = true;
      if (turnSessionId) deps.sessionManager.setLastTurnErrored(turnSessionId, true);
      // docs/163 — the errored turn has just been finalized into chat history
      // (replaceInProgress + finalize + the error row above). Clear the
      // turn-event replay buffer so a subsequent WS reconnect doesn't re-emit
      // those same events on top of the already-persisted turn. Without this,
      // the buffer stays dirty (lastPersistedBufferIndex only advances on
      // tool-result / agent_result boundaries, never on the error path), and
      // every reconnect — including a browser reload — replays the completed
      // turn a second time, producing a duplicate that survives reload. This
      // mirrors the clean-completion path in the `agent_result` handler.
      runner.clearTurnEventBuffer();
      if (turnSessionId) {
        emitToViewers({
          type: "session_status",
          sessionId: turnSessionId,
          running: false,
          queueLength: runner.queueLength,
          error: `Agent process error: ${err.message}`,
        });
      }
      runner.onAgentFinished();
    }
    if (turnSessionId) {
      deps.sseBroadcast("session_agent_finished", { sessionId: turnSessionId });
    }

    // Drain the next queued message so a transient /agent/start failure
    // (e.g. 409 race with the previous turn's worker-side cleanup) doesn't
    // strand the rest of the queue. The drain helper will set running=true
    // and start a fresh agent when it shifts a message off.
    if (opts.onError) {
      try {
        await opts.onError();
      } catch (drainErr) {
        console.error("[agent] error-path drain failed:", drainErr);
      }
    }
  });
}
