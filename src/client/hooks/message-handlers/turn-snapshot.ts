import type { WsTurnSnapshot } from "../../../server/shared/types.js";
import type { ChatMessage } from "../../components/MessageList.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * The running turn's transcript, rebuilt from the runner at the instant this
 * viewer attached (WS connect / session switch back / reconnect).
 *
 * Rebuilding a running turn used to stitch two independently-sampled sources:
 * the `GET /history` DB snapshot plus a cursor-sliced replay of the server's
 * turn-event buffer. Those are sampled at different times — the history fetch
 * is a round trip that lands before or after the attach depending on latency —
 * so a tool-result boundary landing between them either erased a slice of the
 * turn from the transcript (history read first: the slice was in neither half)
 * or duplicated it (attach first: it was in both). Nothing repaired it, so the
 * viewer sat on a wrong transcript until the next reload. That is the "switch
 * to another session mid-turn, switch back, and the earlier messages are gone"
 * report.
 *
 * So this REPLACES the running turn's rows rather than appending to them: the
 * snapshot is authoritative for everything up to the attach, and every later
 * event arrives live on the same socket. A history baseline that is stale in
 * either direction converges here.
 *
 * `useMessageHandler` queues this behind `historyLoaded` alongside agent
 * events, so it always lands on top of the history baseline and ahead of the
 * live events that followed it on the wire.
 */
export const handleTurnSnapshot: Handler<WsTurnSnapshot> = (_ctx, data) => {
  const session = useSessionStore.getState();
  const isFinal = data.final === true;
  const snapshot = data.messages.map((m, i): ChatMessage => ({
    ...(m as unknown as ChatMessage),
    // A finished turn's rows are finalized in chat history, so drop the marking
    // rather than leaving them eligible for a later snapshot's replace.
    inProgress: !isFinal,
    // Only the last row of a RUNNING turn is still being written to; the
    // earlier groups are closed. Mirrors how the live path opens and closes
    // bubbles.
    //
    // A system notice is the exception: it is complete when emitted and is never
    // written to incrementally. Every `emitNoticeInTurn` fires at turn start,
    // before the agent has produced any assistant content, so a viewer attaching
    // in that gap gets a snapshot whose ONLY row is the notice — and marking it
    // `streaming` invites the live path to merge the agent's first text into it.
    // `agent-event.ts` refuses that merge, but a row that is never written to
    // has no business claiming to be open in the first place.
    streaming: !isFinal && i === data.messages.length - 1 && m.notice !== true,
  }));
  session.setMessages((prev) => [...prev.filter((m) => !m.inProgress), ...snapshot]);
};
