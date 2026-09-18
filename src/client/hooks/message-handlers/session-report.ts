import type { WsSessionReportCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

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
