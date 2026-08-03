import type { WsServerMessage } from "../../shared/types.js";
import type { AgentProcess } from "../../shared/types.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import { emitChatCard } from "../chat-card-persistence.js";
import type { AgentListenerDeps, WireListenersOpts } from "./agent-listeners.js";

/**
 * The one actionable sentence a user gets when a turn dies on authentication.
 * Exported so tests assert against the constant instead of a pasted copy.
 */
export const AGENT_NOT_AUTHENTICATED_MESSAGE =
  "This agent is not authenticated. Open Settings → Agents to sign in, then resend your message.";

/**
 * `auth_required` handling — auth-failure recovery / token refresh (docs/179),
 * extracted from `agent-listeners.ts` (Phase P6 split, docs/201). Decides
 * synchronously whether the executor will auto-recover a stale-token 401 (stay
 * quiet, heal + re-dispatch) or whether to surface the re-auth flow, then tears
 * the failed turn's agent down. No behavior change — the listener registers this
 * as its `auth_required` handler.
 *
 * `runner` is the registry-resolved reference (or null fallback). `emitToViewers`
 * and the per-connection-state capture (`opts.capturedSessionId`) are passed in
 * so this preserves the WS-lifecycle invariant: it reads only values captured at
 * turn start, never `ctx.getX()`.
 */
export function wireAuthRequiredHandler(
  agent: AgentProcess,
  runner: SessionRunnerInterface | null,
  deps: AgentListenerDeps,
  opts: WireListenersOpts,
  emitToViewers: (msg: WsServerMessage) => void,
): void {
  // docs/179 — turn-scoped idempotence latch. `StreamingClaudeProcess` already
  // raises `auth_required` at most once per turn, but that guarantee covers one
  // emitter; this handler must be safe against a duplicate from anywhere,
  // because everything below is destructive or user-visible exactly once —
  // it kills the turn's agent, and on the surface path emits an error bubble,
  // nudges the refresher, and broadcasts `session_agent_finished`.
  //
  // Crucially this is NOT the same as making `willRecoverAuth` return false on
  // a second call: `false` means "will not recover", which routes the duplicate
  // into `surfaceReauth()` and pops a sign-in card *during* a recovery that is
  // about to succeed silently. A duplicate must do nothing at all.
  //
  // Safe as a per-turn closure: `agent-execution.ts` calls
  // `existingAgent.removeAllListeners()` before re-wiring a reused process, so
  // exactly one of these handlers is registered per turn.
  let handledThisTurn = false;

  agent.on("auth_required", () => {
    if (handledThisTurn) return;
    handledThisTurn = true;

    const turnSession = opts.capturedSessionId
      ? deps.sessionManager.get(opts.capturedSessionId)
      : null;
    const failingAgentId = turnSession?.agentId;
    const turnSessionId = opts.capturedSessionId;

    // docs/179 — decide SYNCHRONOUSLY (before the teardown below kills the agent
    // and triggers the executor's `done` handler) whether this auth failure
    // will be auto-recovered. `willRecoverAuth` returns true only for a first-
    // attempt turn with a token healer wired, and flips the executor's stand-
    // down flag so the `done` teardown defers to the recovery. When true we
    // stay quiet — no sign-in card, no OAuth flow — and let `recoverAuth` heal
    // the token and re-dispatch the turn. A transient stale-token 401 thus
    // recovers without the user seeing anything or re-sending.
    const willRecover = opts.willRecoverAuth?.() ?? false;

    /**
     * Emit + persist the "not authenticated" row. `emitChatCard` needs a runner
     * (it records the row on `runner.recordedCards` so `buildTurnMessages`
     * interleaves it at its true transcript position) and a session id; without
     * either we can only fall back to the legacy emit, which is what the code
     * did unconditionally before.
     *
     * `finalizeInProgress` after the emit is load-bearing on THIS path and only
     * this one: `emitChatCard` persists the row as `in_progress=1`, and the
     * auth path is the one turn ending that never finalizes — `turn-executor`'s
     * `done` skips `onInterruptedTurn` when `sawAuthRequired` (it defers to
     * "the listener already owns the visible row", which is us). Left
     * in-progress, the row — and any partial output beside it — is deleted by
     * the next turn's `replaceInProgress`, i.e. the docs/156 erasure bug.
     */
    const persistAuthErrorRow = (): void => {
      if (!runner || !turnSessionId) {
        emitToViewers({ type: "error", message: AGENT_NOT_AUTHENTICATED_MESSAGE });
        return;
      }
      emitChatCard(
        runner,
        { type: "error", message: AGENT_NOT_AUTHENTICATED_MESSAGE, sessionId: turnSessionId },
        { role: "assistant", text: `Error: ${AGENT_NOT_AUTHENTICATED_MESSAGE}`, isError: true },
        { chatHistoryManager: deps.chatHistoryManager, sessionId: turnSessionId },
      );
      deps.chatHistoryManager.finalizeInProgress(turnSessionId);
    };

    // The visible re-auth flow: tell the user (in the affected session only)
    // to re-authenticate via Settings, nudge the per-agent silent refresher,
    // and mark the turn ended.
    const surfaceReauth = (): void => {
      console.log("[server] Agent CLI requires authentication; prompting re-auth via Settings");
      // We no longer auto-launch the interactive OAuth flow on a mid-turn 401.
      // It broadcast the verification URL over a global SSE event, popping a
      // blocking sign-in overlay in every open browser window. Instead, surface
      // an actionable error in this session and let the per-agent refresher
      // attempt a silent heal (which, on a genuine revocation, broadcasts
      // `agent_auth_failed reason:revoked` → the "Sign in" toast that opens
      // Settings → Agents).
      //
      // PERSISTED, not merely emitted (CLAUDE.md "Chat transcript content MUST
      // be persisted"). `emitToViewers` → `runner.emitMessage` is transport
      // only: it broadcasts to attached viewers and buffers into the per-turn
      // event log. In the production incident this notice was the user's ONLY
      // signal that their turn had died, and it reached nobody — no viewer was
      // attached at the failure instant, and idle-cleanup disposed the runner
      // five seconds later, taking the replay buffer with it. The user saw a
      // prompt with no reply and no error, twice. `emitChatCard` broadcasts,
      // records the row in-band, and writes it to chat history in one call, so
      // it now survives a detached viewer, a session switch, and a reload.
      persistAuthErrorRow();
      // docs/153, docs/155 — let the per-agent module decide its side effect on
      // auth failure (Claude nudges the silent OAuth refresher; others register
      // their own hook or none). The listener doesn't know the agent — that's
      // the point of the table. This is the silent token refresh, NOT the
      // interactive login overlay we removed above.
      if (failingAgentId) {
        deps.onAgentAuthRequired?.(failingAgentId);
      }
      if (runner && turnSessionId) {
        emitToViewers({
          type: "session_status",
          sessionId: turnSessionId,
          running: false,
          queueLength: runner.queueLength,
        });
      }
      if (turnSessionId) {
        deps.sseBroadcast("session_agent_finished", { sessionId: turnSessionId });
      }
    };

    // Tear the failed turn's agent down. An auth failure ends the turn, but a
    // persistent streaming agent (live steering) does NOT exit on a failed
    // result, so the worker never clears `this.agent` and the runner is left
    // with `running=true` — the next turn then 409s with "Agent already
    // running". Killing the worker agent + clearing the runner's ref makes the
    // failure recoverable. See docs/142 (Problem B1). Kill is fire-and-forget;
    // the proxy surfaces any failure via the Logs panel, not the chat.
    agent.kill();
    if (runner) {
      // Identity-guard: a concurrent turn may have replaced the runner's
      // agent ref already; only clear if it's still our process.
      if (runner.getAgent() === agent) {
        runner.setAgent(null);
        // docs/140 — streaming process is gone; reset the gate.
        runner.isStreamingActive = false;
      }
      // docs/179 — on the recovery path leave `running` set: the turn is about
      // to be re-dispatched, so flipping it (and emitting running=false) would
      // make the client flicker out of its loading state. The re-dispatch
      // resets turn state. On the surface path, the teardown below clears it.
      if (!willRecover) runner.running = false;
    }

    if (willRecover && opts.recoverAuth) {
      // docs/179 — quiet path: heal + re-dispatch. If the heal genuinely fails
      // (token revoked / rate-limited), fall back to the visible re-auth flow.
      // Fire-and-forget: `auth_required` is a sync event handler.
      // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget in a sync event handler
      void opts.recoverAuth().then(
        (handled) => {
          if (!handled) surfaceReauth();
        },
        (err: unknown) => {
          // recoverAuth owns its own errors and resolves false on a failed heal;
          // a rejection here is unexpected. Fail open — surface the sign-in card
          // rather than leaving the turn wedged behind an unhandled rejection.
          console.error("[server] docs/179 auth recovery rejected unexpectedly:", err);
          surfaceReauth();
        },
      );
      return;
    }
    surfaceReauth();
  });
}
