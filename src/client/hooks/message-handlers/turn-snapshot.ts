import type { WsTurnSnapshot } from "../../../server/shared/types.js";
import type { ChatMessage } from "../../components/MessageList.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleTurnSnapshot: Handler<WsTurnSnapshot> = (_ctx, data) => {
  const session = useSessionStore.getState();
  const isFinal = data.final === true;
  const snapshot = data.messages.map((m, i): ChatMessage => ({
    ...(m as unknown as ChatMessage),

    inProgress: !isFinal,

    // A system notice is the exception: it is complete when emitted and is never

    // `agent-event.ts` refuses that merge, but a row that is never written to

    streaming: !isFinal && i === data.messages.length - 1 && m.notice !== true,
  }));
  session.setMessages((prev) => [...prev.filter((m) => !m.inProgress), ...snapshot]);
};
