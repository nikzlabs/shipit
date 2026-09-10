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

export const VOICE_NOTE_TOOL_NAME = "mcp__shipit__voice_note";

interface VoiceTurnState {
  authored: boolean;
  authoredPayloads: Map<string, { id: string; path: "observation" | "bridge" }>;
}

const turnStates = new WeakMap<object, VoiceTurnState>();

function stateFor(runner: object): VoiceTurnState {
  let s = turnStates.get(runner);
  if (!s) {
    s = { authored: false, authoredPayloads: new Map() };
    turnStates.set(runner, s);
  }
  return s;
}

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

export function resetVoiceNoteTurnState(runner: object): void {
  turnStates.delete(runner);
}

export function hasAuthoredVoiceNoteThisTurn(runner: object): boolean {
  return turnStates.get(runner)?.authored ?? false;
}

export interface RouteVoiceNoteDeps {
  runner: SessionRunnerInterface;
  sessionId: string;
  credentialStore: CredentialStore;
  chatHistoryManager: InProgressPersister;
  source: VoiceNoteSource;
  authoredPath?: "observation" | "bridge";
  fetchImpl?: typeof fetch;
  idFactory?: () => string;
  now?: () => string;
}

export interface RouteVoiceNoteResult {
  id: string;
  native: boolean;
  webhook: boolean;
  webhookStatus?: number;
  webhookError?: string;
  duplicate: boolean;
}

let fallbackCounter = 0;

function defaultId(): string {
  try {
    return `voice-${crypto.randomUUID()}`;
  } catch {
    fallbackCounter += 1;
    return `voice-${fallbackCounter}`;
  }
}

export async function routeVoiceNote(
  payload: VoiceNotePayload,
  deps: RouteVoiceNoteDeps,
): Promise<RouteVoiceNoteResult> {
  const { runner, sessionId, credentialStore, source, chatHistoryManager } = deps;
  const state = stateFor(runner);
  if (source === "authored") {
    state.authored = true;
    // Record before awaiting the webhook so observation and bridge delivery cannot race.
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

  if (mode === "native" || mode === "both") {
    const voiceNote = {
      id,
      headline: payload.summary,
      kind: source,
      createdAt: nowIso,
    };
    emitChatCard(
      runner,
      { type: "voice_note", sessionId, ...voiceNote },
      { role: "assistant", text: "", voiceNote },
      { chatHistoryManager, sessionId },
    );
    result.native = true;
  }

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
            // Retained for v1 receiver compatibility.
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
