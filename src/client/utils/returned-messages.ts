/**
 * docs/330-stop-returns-queued-messages — the client half of "a Stop returns the queued
 * messages to the input box". The server keeps the messages until a viewer answers that its
 * input box has them, so nothing here may answer before the draft is saved.
 */

import type { WsReturnedQueueMessage } from "../../server/shared/types.js";
import { useSessionStore } from "../stores/session-store.js";
import {
  addReturnedMessageIds,
  getReturnedMessageIds,
  getSavedDraftMessage,
  saveDraftMessage,
} from "./local-storage.js";

/** Hands the server's list to the composer of its session. */
export function offerReturnedMessages(sessionId: string, messages: WsReturnedQueueMessage[]): void {
  if (messages.length === 0) return;
  const session = useSessionStore.getState();
  // An empty snapshot keeps a row that this browser predicted; a returned message has no row.
  const returned = new Set(messages.map((m) => m.id));
  if (session.queuedMessages.some((q) => q.requestId !== undefined && returned.has(q.requestId))) {
    session.setQueuedMessages((prev) =>
      prev
        .filter((q) => q.requestId === undefined || !returned.has(q.requestId))
        .map((q, i) => ({ ...q, position: i + 1 })));
  }
  session.setReturnedToComposer({ sessionId, messages });
}

/** The returned messages go before what the user was writing. */
export function prependReturnedText(current: string, returned: string): string {
  if (returned === "") return current;
  return current.trim() === "" ? returned : `${returned}\n\n${current}`;
}

export interface ReturnedDraft {
  /** The text of the messages that this browser had not put into the draft yet. */
  text: string;
  files: string[];
  /** Every id of the list, to answer the server with: an answer can be lost. */
  ids: string[];
}

/**
 * Saves the messages into the session's draft and records them, so that a list which arrives
 * a second time adds nothing. `draftKey` is absent when the composer does not save a draft.
 */
export function takeReturnedIntoDraft(
  sessionId: string,
  draftKey: string | undefined,
  messages: WsReturnedQueueMessage[],
): ReturnedDraft {
  const applied = new Set(getReturnedMessageIds(sessionId));
  const fresh = messages.filter((m) => !applied.has(m.id));
  const text = fresh.map((m) => m.text).filter((t) => t.trim() !== "").join("\n\n");
  if (draftKey && text !== "") {
    saveDraftMessage(draftKey, prependReturnedText(getSavedDraftMessage(draftKey) ?? "", text));
  }
  addReturnedMessageIds(sessionId, fresh.map((m) => m.id));
  return {
    text,
    files: fresh.flatMap((m) => (m.files ?? []).map((f) => f.path)),
    ids: messages.map((m) => m.id),
  };
}
