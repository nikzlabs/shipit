import type { WsBugReportCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useBugReportStore } from "../../stores/bug-report-store.js";
import type { Handler } from "./types.js";

/**
 * docs/164 — the redacted bug-report consent card. Seed the card payload into
 * the bug-report store (keyed by cardId so a later filed/failed update can swap
 * it in place) and append a marker chat message so it renders inline at the
 * point in the transcript where the agent proposed the report.
 */
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
  session.setMessages((prev) => [
    ...prev,
    {
      role: "assistant" as const,
      text: "",
      bugReport: { cardId: data.cardId },
    },
  ]);
};
