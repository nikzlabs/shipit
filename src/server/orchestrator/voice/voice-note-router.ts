/**
 * Voice-note router (docs/163).
 *
 * One router behind the single agent-facing voice primitive. It takes a
 * payload `{ summary, needsAttention, context }` plus the user's delivery
 * setting and fans out to:
 *
 *   - the **native** sink — `runner.emitMessage` of a `voice_note` WS message
 *     (buffers into the turn-event log, survives reconnects); the client
 *     decides whether to autoplay based on `needsAttention` + hands-free mode.
 *   - the **external** sink — a `POST` of `{ v: 1, summary, needsAttention,
 *     context }` to the user's webhook with `Authorization: Bearer <token>`.
 *
 * Invariants enforced here (server-side, source-agnostic):
 *   - `needsAttention: false` → a *silent* native bubble (no webhook). A chatty
 *     agent costs nothing.
 *   - per-turn cap on attention-grabbing notes: beyond the cap a note still
 *     renders, but its attention is downgraded (no autoplay-eligible flag, no
 *     webhook) so an over-narrating agent can't spam chimes / pushes.
 *
 * The delivery mechanism never leaks to the agent — it always calls the same
 * tool; *this* module is where "the user chooses the mechanism" lives.
 */

import type { CredentialStore } from "../credential-store.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import type {
  VoiceNotePayload,
  VoiceNoteSource,
} from "../../shared/types/voice-note-types.js";
import { VOICE_WEBHOOK_BODY_VERSION } from "../../shared/types/voice-note-types.js";
import { getErrorMessage } from "../../shared/utils.js";

/**
 * Max attention-grabbing notes per turn. Beyond this, notes still render but
 * are downgraded to silent so an over-narrating agent can't spam the user.
 */
export const MAX_ATTENTION_NOTES_PER_TURN = 3;

interface VoiceTurnState {
  /** True once an *authored* note (the built-in tool) routed this turn. */
  authored: boolean;
  /** Count of attention-grabbing notes routed this turn (for the cap). */
  attentionCount: number;
}

// Per-turn voice state keyed by runner. A WeakMap keeps both runner
// implementations (SessionRunner, ContainerSessionRunner) untouched — the
// state is owned by the voice module, not the runner contract. Reset at turn
// start via `resetVoiceNoteTurnState` (called from `resetRunnerTurnState`).
const turnStates = new WeakMap<object, VoiceTurnState>();

function stateFor(runner: object): VoiceTurnState {
  let s = turnStates.get(runner);
  if (!s) {
    s = { authored: false, attentionCount: 0 };
    turnStates.set(runner, s);
  }
  return s;
}

/** Reset per-turn voice state. Called from `resetRunnerTurnState`. */
export function resetVoiceNoteTurnState(runner: object): void {
  turnStates.delete(runner);
}

/**
 * True when an authored voice note has already fired this turn — the source
 * observer in `agent-listeners` reads this to suppress a *derived* fallback
 * headline (authored-first; derive only as the floor).
 */
export function hasAuthoredVoiceNoteThisTurn(runner: object): boolean {
  return turnStates.get(runner)?.authored ?? false;
}

export interface RouteVoiceNoteDeps {
  runner: SessionRunnerInterface;
  sessionId: string;
  credentialStore: CredentialStore;
  /**
   * Persists the native card so it survives a history reload (WS reconnect /
   * refresh / restart). Optional: tests and minimal setups omit it, in which
   * case the card still renders live but isn't durable.
   */
  chatHistoryManager?: ChatHistoryManager;
  /** Where this note came from (authored / derived). */
  source: VoiceNoteSource;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable id factory (synthetic note id). */
  idFactory?: () => string;
  /** Injectable clock (ISO string). */
  now?: () => string;
}

export interface RouteVoiceNoteResult {
  /** The synthetic note id used for the native bubble + playback cache. */
  id: string;
  /** Whether a native voice_note WS message was emitted. */
  native: boolean;
  /** Whether a webhook POST was attempted. */
  webhook: boolean;
  /** Webhook POST outcome, when attempted. */
  webhookStatus?: number;
  webhookError?: string;
  /** Effective attention after the per-turn cap (drives audio + webhook). */
  attention: boolean;
  /** True when the per-turn attention cap downgraded this note to silent. */
  capped: boolean;
}

let fallbackCounter = 0;

function defaultId(): string {
  try {
    return `voice-${crypto.randomUUID()}`;
  } catch {
    // Environments without webcrypto (older test harnesses): a monotonic
    // counter keyed id is still unique enough for the playback cache.
    fallbackCounter += 1;
    return `voice-${fallbackCounter}`;
  }
}

/**
 * Route one voice-note payload to the configured sinks. Source-agnostic: the
 * built-in tool's HTTP handler and the derived AskUserQuestion / ExitPlanMode
 * observer both call this.
 */
export async function routeVoiceNote(
  payload: VoiceNotePayload,
  deps: RouteVoiceNoteDeps,
): Promise<RouteVoiceNoteResult> {
  const { runner, sessionId, credentialStore, source } = deps;
  const id = (deps.idFactory ?? defaultId)();
  const nowIso = (deps.now ?? (() => new Date().toISOString()))();

  const state = stateFor(runner);
  if (source === "authored") state.authored = true;

  // Per-turn attention cap. A `needsAttention: false` note is silent by
  // construction; an attention note past the cap is downgraded to silent.
  let attention = payload.needsAttention;
  let capped = false;
  if (attention) {
    state.attentionCount += 1;
    if (state.attentionCount > MAX_ATTENTION_NOTES_PER_TURN) {
      attention = false;
      capped = true;
    }
  }

  const mode = credentialStore.getVoiceDeliveryMode();
  const result: RouteVoiceNoteResult = {
    id,
    native: false,
    webhook: false,
    attention,
    capped,
  };

  // ---- Native sink ----
  if (mode === "native" || mode === "both") {
    const voiceNote = {
      id,
      headline: payload.summary,
      needsAttention: attention,
      kind: source,
      createdAt: nowIso,
    };
    runner.emitMessage({ type: "voice_note", sessionId, ...voiceNote });
    result.native = true;

    // Persist the card so it survives a history reload. Voice notes arrive off
    // the agent-event stream, so `buildTurnMessages` never captures them — the
    // live append would otherwise be wiped by the next loadSessionHistory.
    // Finalized (not in_progress) so the turn-end `replaceInProgress` keeps it.
    deps.chatHistoryManager?.append(sessionId, { role: "assistant", text: "", voiceNote });
  }

  // ---- External (webhook) sink ----
  // Gated on effective attention: an FYI / silent note is not pushed out.
  if ((mode === "external" || mode === "both") && attention) {
    const webhook = credentialStore.getVoiceWebhook();
    if (webhook) {
      result.webhook = true;
      const doFetch = deps.fetchImpl ?? fetch;
      try {
        const res = await doFetch(webhook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(webhook.token ? { Authorization: `Bearer ${webhook.token}` } : {}),
          },
          body: JSON.stringify({
            v: VOICE_WEBHOOK_BODY_VERSION,
            summary: payload.summary,
            needsAttention: payload.needsAttention,
            ...(payload.context ? { context: payload.context } : {}),
          }),
        });
        result.webhookStatus = res.status;
        if (!res.ok) {
          result.webhookError = `webhook returned HTTP ${res.status}`;
        }
      } catch (err) {
        result.webhookError = getErrorMessage(err);
      }
    }
  }

  return result;
}
