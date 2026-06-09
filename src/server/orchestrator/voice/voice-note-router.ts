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
import type { SessionRunnerInterface } from "../session-runner.js";
import { emitChatCard } from "../chat-card-persistence.js";
import type {
  VoiceNotePayload,
  VoiceNoteSource,
  VoiceNoteContext,
} from "../../shared/types/voice-note-types.js";
import { VOICE_WEBHOOK_BODY_VERSION } from "../../shared/types/voice-note-types.js";
import { getErrorMessage } from "../../shared/utils.js";

/**
 * Max attention-grabbing notes per turn. Beyond this, notes still render but
 * are downgraded to silent so an over-narrating agent can't spam the user.
 */
export const MAX_ATTENTION_NOTES_PER_TURN = 3;

/**
 * The namespaced name of the built-in `voice_note` tool as it appears in the
 * agent event stream (`mcp__<server>__<tool>`, server `shipit-voice`). The
 * orchestrator matches this to deliver an authored note's native card the
 * instant it OBSERVES the call — without waiting for the slower bridge → worker
 * → orchestrator HTTP relay (see `agent-listeners.ts`). Keep in sync with
 * `mcp-voice-bridge.ts` (`name: "shipit-voice"`, tool `"voice_note"`).
 */
export const VOICE_NOTE_TOOL_NAME = "mcp__shipit-voice__voice_note";

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

/**
 * Keep only the known display-only context fields, all strings. The agent
 * supplies this (via the tool input or the relay body); we don't trust
 * arbitrary shapes onto the webhook / WS message. Shared by the HTTP relay
 * route and the event-stream observation so both sanitize identically.
 */
export function sanitizeVoiceContext(input: unknown): VoiceNoteContext | undefined {
  if (!input || typeof input !== "object") return undefined;
  const src = input as Record<string, unknown>;
  const out: VoiceNoteContext = {};
  for (const key of ["repo", "prUrl", "prTitle", "sessionName"] as const) {
    const v = src[key];
    if (typeof v === "string" && v.trim()) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
    // Emit AND persist in one call (docs/163). Voice notes arrive off the
    // agent-event stream, so `buildTurnMessages` never captures them on its own;
    // `emitChatCard` records the card on the runner (anchored after the
    // persistable groups so far) so it folds into the turn's rebuilt batch and
    // lands where the tool was issued instead of floating above the whole turn
    // on reload — and it can't be emit-only (the recurring ephemeral-card bug).
    emitChatCard(
      runner,
      { type: "voice_note", sessionId, ...voiceNote },
      { role: "assistant", text: "", voiceNote },
    );
    result.native = true;
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
