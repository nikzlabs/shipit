// eslint-disable-next-line no-restricted-imports -- useEffect: WebSocket message dispatch to stores (external system sync)
import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { InteractiveTerminalHandle } from "../components/InteractiveTerminal.js";
import type { WsServerMessage, WsClientMessage } from "../../server/shared/types.js";
import { useSessionStore } from "../stores/session-store.js";
import {
  createQueuedMessageStash,
  dispatchMessage,
  type HandlerContext,
} from "./message-handlers/index.js";

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
]);

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
      if (WAITS_FOR_HISTORY.has(data.type) && !useSessionStore.getState().historyLoaded) {
        pendingAgentEventsRef.current.push(data);
        continue;
      }
      dispatchMessage(ctx, data);
    }
  }, [lastMessage, drainMessages, send, ctx]);
}
