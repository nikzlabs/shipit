import type { WsSessionReportCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/233 (planning#243) — render a `SessionReportCard` inline when a child
 * reports up to its parent. A sibling relation can occur only while rehydrating
 * legacy cards from the removed cohort-broadcast path.
 *
 * The card is BOTH persisted in chat history (appended server-side, since the
 * report arrives outside any of THIS session's turns) AND buffered into the
 * turn-event log, so a reconnect can deliver it twice (once from
 * `loadSessionHistory`, once from the buffer replay) — dedupe by the stable
 * `cardId`. The static payload passes straight through to the message (no
 * client store).
 */
export const handleSessionReportCard: Handler<WsSessionReportCard> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.sessionReport?.cardId === data.card.cardId)) return;
  session.setMessages((prev) =>
    prev.some((m) => m.sessionReport?.cardId === data.card.cardId)
      ? prev
      : [
          ...prev,
          {
            role: "assistant" as const,
            text: "",
            sessionReport: {
              cardId: data.card.cardId,
              fromSessionId: data.card.fromSessionId,
              fromTitle: data.card.fromTitle,
              ...(data.card.fromBranch ? { fromBranch: data.card.fromBranch } : {}),
              relation: data.card.relation,
              severity: data.card.severity,
              ...(data.card.subject ? { subject: data.card.subject } : {}),
              body: data.card.body,
              createdAt: data.card.createdAt,
            },
          },
        ],
  );
};
