import type {
  WsRepoSessionProposalCard,
  WsRepoSessionProposalUpdate,
} from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleRepoSessionProposalCard: Handler<WsRepoSessionProposalCard> = (_ctx, data) => {
  useSessionStore.getState().setMessages((prev) =>
    prev.some((m) => m.repoSessionProposal?.cardId === data.card.cardId)
      ? prev
      : [...prev, { role: "assistant" as const, text: "", repoSessionProposal: data.card }],
  );
};

/**
 * Shared by the WS update and by the start request's own response: a session
 * whose runner has been reclaimed emits nothing, and the click must still be
 * visible without a reload.
 */
export function applyRepoSessionProposalUpdate(
  data: Omit<WsRepoSessionProposalUpdate, "type" | "sessionId">,
): void {
  useSessionStore.getState().setMessages((prev) => {
    const index = prev.findIndex((m) => m.repoSessionProposal?.cardId === data.cardId);
    if (index < 0) return prev;
    const card = prev[index].repoSessionProposal!;
    // `started` is terminal: a late `starting` must never reopen it.
    if (card.state === "started" && data.state !== "started") return prev;
    const next = prev.slice();
    next[index] = {
      ...next[index],
      repoSessionProposal: {
        ...card,
        state: data.state,
        ...(data.startedSessionId ? { startedSessionId: data.startedSessionId } : {}),
        ...(data.startedAt ? { startedAt: data.startedAt } : {}),
        errorMessage: data.errorMessage,
      },
    };
    return next;
  });
}

export const handleRepoSessionProposalUpdate: Handler<WsRepoSessionProposalUpdate> = (
  _ctx,
  data,
) => applyRepoSessionProposalUpdate(data);
