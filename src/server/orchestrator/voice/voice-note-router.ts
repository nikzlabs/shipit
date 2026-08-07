/**
 * Voice-note router (docs/163).
 *
 * One router behind the single agent-facing voice primitive. It takes a
 * payload `{ summary, context }` plus the user's delivery setting and fans out
 * to:
 *
 *   - the **native** sink — `runner.emitMessage` of a `voice_note` WS message
 *     (buffers into the turn-event log, survives reconnects); the client
 *     decides whether to autoplay based on hands-free mode.
 *   - the **external** sink — a `POST` of `{ v: 1, summary, needsAttention,
 *     context }` to the user's webhook with `Authorization: Bearer <token>`.
 *     `needsAttention` is a constant `true` kept for `v: 1` receiver compat.
 *
 * A voice note always means "the agent needs the user", so both sinks always
 * fire. The former `needsAttention: false` mode and the per-turn attention cap
 * were removed: a silent note duplicated on-screen prose with no audio and no
 * webhook, and the cap was redundant with the client's 20s chime debounce while
 * being actively inverted against latest-wins playback — it silenced the newest
 * note and left stale speech playing. See docs/163.
 *
 * The delivery mechanism never leaks to the agent — it always calls the same
 * tool; *this* module is where "the user chooses the mechanism" lives.
 */

import type { CredentialStore } from "../credential-store.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import { emitChatCard, type InProgressPersister } from "../chat-card-persistence.js";
import type {
  VoiceNotePayload,
  VoiceNoteSource,
  VoiceNoteContext,
} from "../../shared/types/voice-note-types.js";
import { VOICE_WEBHOOK_BODY_VERSION } from "../../shared/types/voice-note-types.js";
import { getErrorMessage } from "../../shared/utils.js";

/**
 * The namespaced name of the built-in `voice_note` tool as it appears in the
 * agent event stream (`mcp__<server>__<tool>`, server `shipit`). The
 * orchestrator matches this to deliver an authored note's native card the
 * instant it OBSERVES the call — without waiting for the slower bridge → worker
 * → orchestrator HTTP relay (see `agent-listeners.ts`). Keep in sync with the
 * consolidated `mcp-shipit-bridge` (`name: "shipit"`, tool `"voice_note"`; planning#130).
 */
export const VOICE_NOTE_TOOL_NAME = "mcp__shipit__voice_note";

interface VoiceTurnState {
  /** True once an *authored* note (the built-in tool) routed this turn. */
  authored: boolean;
  /** Authored payloads already delivered, regardless of whether they arrived
   * through event-stream observation or the HTTP bridge fallback. */
  authoredPayloads: Map<string, { id: string; path: "observation" | "bridge" }>;
}

// Per-turn voice state keyed by runner. A WeakMap keeps both runner
// implementations (SessionRunner, ContainerSessionRunner) untouched — the
// state is owned by the voice module, not the runner contract. Reset at turn
// start via `resetVoiceNoteTurnState` (called from `resetRunnerTurnState`).
const turnStates = new WeakMap<object, VoiceTurnState>();

function stateFor(runner: object): VoiceTurnState {
  let s = turnStates.get(runner);
  if (!s) {
    s = { authored: false, authoredPayloads: new Map() };
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
  /**
   * Chat-history sink so the native card is persisted in-band the instant it
   * fires (docs/191). `emitChatCard` writes the in-progress turn through this,
   * closing the reconnect window where the card would otherwise flicker out.
   */
  chatHistoryManager: InProgressPersister;
  /** Where this note came from (authored / derived). */
  source: VoiceNoteSource;
  /** Which authored-tool transport reached the router. Used only to collapse
   * the event observation and HTTP fallback for the same call. */
  authoredPath?: "observation" | "bridge";
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
  /** The same authored call was already delivered through the other path. */
  duplicate: boolean;
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
  const { runner, sessionId, credentialStore, source, chatHistoryManager } = deps;
  const state = stateFor(runner);
  if (source === "authored") {
    state.authored = true;
    // The event stream is the preferred low-latency path, while the bridge is
    // a reliability fallback for adapters that don't surface MCP tool calls in
    // an observable assistant event. Both carry the same sanitized payload, so
    // suppress whichever path arrives second. Mark synchronously before any
    // webhook await so racing paths cannot double-send.
    const fingerprint = JSON.stringify({
      summary: payload.summary,
      context: payload.context ?? null,
    });
    const path = deps.authoredPath ?? "observation";
    const existing = state.authoredPayloads.get(fingerprint);
    if (existing && existing.path !== path) {
      state.authoredPayloads.delete(fingerprint);
      return {
        id: existing.id,
        native: false,
        webhook: false,
        duplicate: true,
      };
    }
    const id = (deps.idFactory ?? defaultId)();
    state.authoredPayloads.set(fingerprint, { id, path });
  }

  const id = source === "authored"
    ? state.authoredPayloads.get(JSON.stringify({
        summary: payload.summary,
        context: payload.context ?? null,
      }))!.id
    : (deps.idFactory ?? defaultId)();
  const nowIso = (deps.now ?? (() => new Date().toISOString()))();

  const mode = credentialStore.getVoiceDeliveryMode();
  const result: RouteVoiceNoteResult = {
    id,
    native: false,
    webhook: false,
    duplicate: false,
  };

  // ---- Native sink ----
  if (mode === "native" || mode === "both") {
    const voiceNote = {
      id,
      headline: payload.summary,
      kind: source,
      createdAt: nowIso,
    };
    // Emit AND persist in one call (docs/163, docs/191). Voice notes arrive off
    // the agent-event stream, so `buildTurnMessages` never captures them on its
    // own; `emitChatCard` records the card on the runner (anchored after the
    // persistable groups so far) so it folds into the turn's rebuilt batch and
    // lands where the tool was issued instead of floating above the whole turn
    // on reload — and it persists the in-progress turn immediately, so it can't
    // be emit-only and can't flicker out on a mid-turn reconnect.
    emitChatCard(
      runner,
      { type: "voice_note", sessionId, ...voiceNote },
      { role: "assistant", text: "", voiceNote },
      { chatHistoryManager, sessionId },
    );
    result.native = true;
  }

  // ---- External (webhook) sink ----
  if (mode === "external" || mode === "both") {
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
            // Constant `true`: every note is attention-worthy now. Kept in the
            // body so existing `v: 1` receivers that branch on it keep working.
            needsAttention: true,
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
