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

      // is wiped by the load that follows — the very "my message never showed

      if (
        (data.type === "agent_event" || data.type === "sub_agent_spawn" || data.type === "turn_snapshot"
          || data.type === "system_user_message") &&
        !useSessionStore.getState().historyLoaded
      ) {
        pendingAgentEventsRef.current.push(data);
        continue;
      }
      dispatchMessage(ctx, data);
    }
  }, [lastMessage, drainMessages, send, ctx]);
}
