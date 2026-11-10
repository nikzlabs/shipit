// eslint-disable-next-line no-restricted-imports -- useEffect: WebSocket message dispatch to stores (external system sync)
import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { InteractiveTerminalHandle } from "../components/InteractiveTerminal.js";
import type { WsServerMessage, WsClientMessage } from "../../server/shared/types.js";
import { useSessionStore } from "../stores/session-store.js";
import {
  createQueuedMessageStash,
  dispatchMessage,
  isForeignTranscriptMessage,
  TRANSCRIPT_CARD_ARRIVALS,
  TRANSCRIPT_CARD_UPDATES,
  type HandlerContext,
} from "./message-handlers/index.js";
import { announceArrivingVoiceNote } from "./message-handlers/voice-note.js";

/** A bubble drawn before the HTTP history load is wiped by it, so these wait for it. */
const WAITS_FOR_HISTORY: ReadonlySet<WsServerMessage["type"]> = new Set<WsServerMessage["type"]>([
  "agent_event",
  "sub_agent_spawn",
  "turn_snapshot",
  "system_user_message",
  // planning#691 — they add or move a user bubble too.
  "message_steered",
  "message_queued",
  "queue_updated",
  ...TRANSCRIPT_CARD_ARRIVALS,
  "fork_breadcrumb",
]);

function cardIdOf(data: WsServerMessage): string | undefined {
  const m = data as { cardId?: unknown; requestId?: unknown; card?: { cardId?: unknown } };
  const id = m.cardId ?? m.requestId ?? m.card?.cardId;
  return typeof id === "string" ? id : undefined;
}

/** An update waits only behind its own card's queued arrival, which holds the row it patches. */
function waitsForItsCard(data: WsServerMessage, pending: WsServerMessage[]): boolean {
  if (!TRANSCRIPT_CARD_UPDATES.has(data.type)) return false;
  const id = cardIdOf(data);
  return id !== undefined && pending.some((p) => TRANSCRIPT_CARD_ARRIVALS.has(p.type) && cardIdOf(p) === id);
}

export function useMessageHandler(params: {
  lastMessage: MessageEvent | null;
  drainMessages: () => MessageEvent[];
  send: (msg: WsClientMessage) => void;
  terminalRef: RefObject<InteractiveTerminalHandle | null>;
}): void {
  const { lastMessage, drainMessages, send, terminalRef } = params;
  const sessionId = useSessionStore((s) => s.sessionId);
  const historyLoaded = useSessionStore((s) => s.historyLoaded);

  // The queued-message stash must survive re-renders so a `queue_updated`

  const queuedMessageStashRef = useRef(createQueuedMessageStash());
  const pendingAgentEventsRef = useRef<WsServerMessage[]>([]);
  const pendingSessionIdRef = useRef<string | undefined>(sessionId);

  const ctx: HandlerContext = useMemo(() => ({
    terminalRef,
    queuedMessageStash: queuedMessageStashRef.current,
  }), [terminalRef]);

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (pendingSessionIdRef.current !== sessionId) {
      pendingAgentEventsRef.current = [];
      pendingSessionIdRef.current = sessionId;
    }
  }, [sessionId]);

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (!historyLoaded || pendingAgentEventsRef.current.length === 0) return;
    const pending = pendingAgentEventsRef.current;
    pendingAgentEventsRef.current = [];
    for (const data of pending) {
      dispatchMessage(ctx, data);
    }
  }, [historyLoaded, ctx]);

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {

    const messages = drainMessages();
    if (messages.length === 0) return;

    for (const msg of messages) {
      let data: WsServerMessage;
      try {
        data = JSON.parse(msg.data as string) as WsServerMessage;
      } catch {
        continue;
      }
      const pending = pendingAgentEventsRef.current;
      const waits = WAITS_FOR_HISTORY.has(data.type) || waitsForItsCard(data, pending);
      if (waits && !useSessionStore.getState().historyLoaded) {
        if (data.type === "voice_note" && !isForeignTranscriptMessage(data)) announceArrivingVoiceNote(data);
        pending.push(data);
        continue;
      }
      dispatchMessage(ctx, data);
    }
  }, [lastMessage, drainMessages, send, ctx]);
}
