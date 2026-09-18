import type { WsError } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import {
  dropPredictedQueueEntry,
  restorePredictedQueueEntries,
} from "../../utils/predicted-queue.js";
import type { Handler } from "./types.js";

export const handleError: Handler<WsError> = (_ctx, data) => {
  const session = useSessionStore.getState();
  session.setIsLoading(false);
  session.setActivity(undefined);
  // An error ends the send a predicted row was waiting on, and MOST refusals
  // carry no request id to correlate with — an unresolvable attachment, an
  // absent workspace, a refused agent. Put the message back in the transcript,
  // above the error, which is where an un-predicted send leaves it. The
  // untrusted-repo branch below is the one refusal that means the opposite: it
  // deletes the message, so its row is dropped rather than restored.
  if (!(data.code === "repository_untrusted" && data.requestId)) {
    restorePredictedQueueEntries();
  }
  session.setMessages((prev) => {
    const withoutRejected = data.code === "repository_untrusted" && data.requestId
      ? prev.filter((m) => m.clientRequestId !== data.requestId)
      : prev;
    const updated = withoutRejected.map((m) =>
      m.role === "assistant" && m.streaming ? { ...m, streaming: false } : m
    );
    return [
      ...updated,
      { role: "assistant", text: `Error: ${data.message}`, streaming: false, isError: true },
    ];
  });
  if (data.code === "repository_untrusted" && data.requestId) {
    // The message was refused, so a queue row predicted for it has nothing left
    // to reconcile against and would otherwise sit above the composer forever.
    dropPredictedQueueEntry(data.requestId);
    session.setPendingWsMessage(undefined);
    if (data.sessionId) {
      session.setActiveRunnerSessions((prev) => {
        const next = new Set(prev);
        next.delete(data.sessionId!);
        return next;
      });
    }
  }
};
