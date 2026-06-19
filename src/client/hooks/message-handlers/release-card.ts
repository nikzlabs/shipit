import type { WsReleaseCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/171 — the release lifecycle card as a persisted transcript card. The
 * `ReleaseStatusPoller` emits this on every phase transition (propose, tagged,
 * gating → released/failed, cancelled). Unlike the issue-write/bug-report cards
 * there is no client store: the full `ReleaseStatusSummary` rides on the chat
 * message, so we upsert it directly into the transcript keyed by `cardId`.
 *
 * Upsert (not append): the first transition creates the inline card; every later
 * one patches the SAME message's `releaseCard` so the card advances and collapses
 * in place rather than duplicating. Idempotent on a turn-event-buffer replay
 * (reconnect) and consistent with the persisted copy rehydrated from history.
 */
export const handleReleaseCard: Handler<WsReleaseCard> = (_ctx, data) => {
  useSessionStore.getState().setMessages((prev) => {
    const idx = prev.findIndex((m) => m.releaseCard?.cardId === data.card.cardId);
    if (idx === -1) {
      return [...prev, { role: "assistant" as const, text: "", releaseCard: data.card }];
    }
    const next = prev.slice();
    next[idx] = { ...next[idx], releaseCard: data.card };
    return next;
  });
};
