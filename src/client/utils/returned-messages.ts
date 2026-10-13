/**
 * docs/330-stop-returns-queued-messages — the client half of "a Stop returns the queued
 * messages to the input box". The server keeps the messages until a viewer answers that its
 * input box has them, so nothing here may answer before the draft is saved.
 */

import type { WsReturnedQueueMessage } from "../../server/shared/types.js";
import { useSessionStore } from "../stores/session-store.js";

/** Hands the server's list to the composer of its session. */
export function offerReturnedMessages(sessionId: string, messages: WsReturnedQueueMessage[]): void {
  if (messages.length === 0) return;
  const session = useSessionStore.getState();
  const returned = new Set(messages.map((m) => m.id));
  // An empty snapshot keeps a row that this browser predicted; a returned message has no row.
  if (session.queuedMessages.some((q) => q.requestId !== undefined && returned.has(q.requestId))) {
    session.setQueuedMessages((prev) =>
      prev
        .filter((q) => q.requestId === undefined || !returned.has(q.requestId))
        .map((q, i) => ({ ...q, position: i + 1 })));
  }
  // A message still on its way at the Stop has its send's bubble and no queue row.
  if (session.messages.some((m) => m.role === "user" && m.clientRequestId && returned.has(m.clientRequestId))) {
    session.setMessages((prev) =>
      prev.filter((m) => !(m.role === "user" && m.clientRequestId && returned.has(m.clientRequestId))));
  }
  session.setReturnedToComposer({ sessionId, messages });
}

/**
 * What this tab has put into its input box. Per tab, as the input box is: a second tab of
 * the same session takes the messages into its own. `block` is the returned text at the
 * head of the input box, so that a message that returns later goes after it.
 */
interface ReturnedRecord {
  ids: string[];
  block: string;
}

const RECORD_KEY_PREFIX = "shipit-returned:";

function readRecord(sessionId: string): ReturnedRecord {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(RECORD_KEY_PREFIX + sessionId) ?? "null") as
      Partial<ReturnedRecord> | null;
    return {
      ids: Array.isArray(parsed?.ids) ? parsed.ids.filter((id): id is string => typeof id === "string") : [],
      block: typeof parsed?.block === "string" ? parsed.block : "",
    };
  } catch {
    return { ids: [], block: "" };
  }
}

function writeRecord(sessionId: string, record: ReturnedRecord): void {
  try {
    sessionStorage.setItem(RECORD_KEY_PREFIX + sessionId, JSON.stringify(record));
  } catch {
    // sessionStorage may be unavailable
  }
}

/**
 * The returned text goes before what the user was writing, and after returned text that is
 * still at the head of the input box, so the messages keep the order they were sent in.
 */
export function placeReturnedText(
  current: string,
  added: string,
  block: string,
): { text: string; block: string } {
  if (block !== "" && current.startsWith(block)) {
    const head = `${block}\n\n${added}`;
    return { text: head + current.slice(block.length), block: head };
  }
  return { text: current.trim() === "" ? added : `${added}\n\n${current}`, block: added };
}

export interface ReturnedToInput {
  /** The input box's new text; `null` when no message is new to this tab. */
  text: string | null;
  files: string[];
  /** Every id of the list, to answer the server with: an answer can be lost. */
  ids: string[];
}

/** Records the messages for this tab, so that a list which arrives again adds nothing. */
export function takeReturnedMessages(
  sessionId: string,
  messages: WsReturnedQueueMessage[],
  current: string,
): ReturnedToInput {
  const record = readRecord(sessionId);
  const applied = new Set(record.ids);
  const fresh = messages.filter((m) => !applied.has(m.id));
  const added = fresh.map((m) => m.text).filter((t) => t.trim() !== "").join("\n\n");
  const placed = added === "" ? { text: current, block: record.block } : placeReturnedText(current, added, record.block);
  // The server offers every message until it is answered, and never one it was answered for.
  const offered = new Set(messages.map((m) => m.id));
  writeRecord(sessionId, {
    ids: [...record.ids.filter((id) => offered.has(id)), ...fresh.map((m) => m.id)],
    block: placed.block,
  });
  return {
    text: added === "" ? null : placed.text,
    files: fresh.flatMap((m) => (m.files ?? []).map((f) => f.path)),
    ids: messages.map((m) => m.id),
  };
}
