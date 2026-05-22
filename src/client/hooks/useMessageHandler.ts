// eslint-disable-next-line no-restricted-imports -- useEffect: WebSocket message dispatch to stores (external system sync)
import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { InteractiveTerminalHandle } from "../components/InteractiveTerminal.js";
import type { WsServerMessage, WsClientMessage } from "../../server/shared/types.js";
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

  // The queued-message stash must survive re-renders so a `queue_updated`
  // arriving after `message_queued` can find the stashed entry. A module-level
  // Map would also work but a ref scopes it to this hook instance.
  const queuedMessageStashRef = useRef(createQueuedMessageStash());

  const ctx: HandlerContext = useMemo(() => ({
    terminalRef,
    queuedMessageStash: queuedMessageStashRef.current,
  }), [terminalRef]);

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    // Drain ALL messages that arrived since the last render. This prevents
    // message loss when React batches multiple setLastMessage() calls between
    // renders (common during compose stack startup bursts).
    const messages = drainMessages();
    if (messages.length === 0) return;

    for (const msg of messages) {
      let data: WsServerMessage;
      try {
        data = JSON.parse(msg.data as string) as WsServerMessage;
      } catch {
        continue;
      }
      dispatchMessage(ctx, data);
    }
  }, [lastMessage, drainMessages, send, ctx]);
}
