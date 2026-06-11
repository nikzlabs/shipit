import type { WsChildMergedCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/196 — render a `ChildMergedCard` inline in the PARENT's chat when a child
 * session it armed a notify-on-merge watch on has its PR merge (or close without
 * merging).
 *
 * The card is BOTH persisted in chat history (appended server-side from the
 * PR-poller event) AND buffered into the turn-event log, so a reconnect can
 * deliver it twice (once from `loadSessionHistory`, once from the buffer
 * replay) — dedupe by the stable `cardId`. The static payload passes straight
 * through to the message (no client store).
 */
export const handleChildMergedCard: Handler<WsChildMergedCard> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.childMerged?.cardId === data.card.cardId)) return;
  session.setMessages((prev) =>
    prev.some((m) => m.childMerged?.cardId === data.card.cardId)
      ? prev
      : [
          ...prev,
          {
            role: "assistant" as const,
            text: "",
            childMerged: {
              cardId: data.card.cardId,
              childSessionId: data.card.childSessionId,
              childTitle: data.card.childTitle,
              ...(data.card.branch ? { branch: data.card.branch } : {}),
              outcome: data.card.outcome,
              prNumber: data.card.prNumber,
              prUrl: data.card.prUrl,
              ...(data.card.prTitle ? { prTitle: data.card.prTitle } : {}),
              ...(data.card.mergeSha ? { mergeSha: data.card.mergeSha } : {}),
              createdAt: data.card.createdAt,
            },
          },
        ],
  );
};
