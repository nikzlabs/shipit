import type { WsBugReportCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useBugReportStore } from "../../stores/bug-report-store.js";
import type { Handler } from "./types.js";

export const handleBugReportCard: Handler<WsBugReportCard> = (_ctx, data) => {
  useBugReportStore.getState().upsertCard({
    cardId: data.cardId,
    title: data.title,
    body: data.body,
    stage2Ran: data.stage2Ran,
    producer: data.producer,
    ...(data.filedAs ? { filedAs: data.filedAs } : {}),
  });

  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.bugReport?.cardId === data.cardId)) return;

  session.setMessages((prev) =>
    prev.some((m) => m.bugReport?.cardId === data.cardId)
      ? prev
      : [
          ...prev,
          {
            role: "assistant" as const,
            text: "",
            bugReport: { cardId: data.cardId },
          },
        ],
  );
};
