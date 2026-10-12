import { getContainerFreshness } from "../container-freshness.js";
import { fillPromptTokens, loadPrompt } from "../load-prompt.js";
import type { SessionContainerManager } from "../session-container.js";
import type { InboxMessage, SessionInboxStore } from "../session-inbox-store.js";
import { formatSessionMessagePrompt } from "../session-message-origin.js";
import type { NoticeDelivery } from "../turn-settlement.js";

const INBOX_NOTICE = loadPrompt(import.meta.url, "./session-inbox-notice.md");
const INBOX_INLINE = loadPrompt(import.meta.url, "./session-inbox-inline.md");

/** The prompt of the turn ShipIt starts so that the notice has a prompt to ride. */
export const INBOX_TURN_TEXT = loadPrompt(import.meta.url, "./session-inbox-turn.md").trim();

function waiting(unread: number): string {
  return unread === 1 ? "1 unread message waits" : `${unread} unread messages wait`;
}

export function buildInboxNotice(unread: number): string {
  return fillPromptTokens(INBOX_NOTICE, { WAITING: waiting(unread) }).trim();
}

/** A message as the agent reads it: an agent's text carries the frame that names its sender. */
export function renderInboxMessage(message: InboxMessage): string {
  return message.origin ? formatSessionMessagePrompt(message.body, message.origin) : message.body;
}

export function inboxMessageHeader(message: Pick<InboxMessage, "id" | "createdAt">): string {
  return `--- message ${message.id} · sent ${message.createdAt}`;
}

export function buildInlineInboxNotice(messages: readonly InboxMessage[]): string {
  return fillPromptTokens(INBOX_INLINE, {
    WAITING: waiting(messages.length),
    MESSAGES: messages.map((m) => `${inboxMessageHeader(m)}\n${renderInboxMessage(m)}`).join("\n\n"),
  }).trim();
}

/**
 * A container older than the running ShipIt can lack the `inbox` command. Its agent is not
 * told to run it: the notice carries the messages.
 */
export function containerPredatesShipIt(
  containerManager: Pick<SessionContainerManager, "get"> | null | undefined,
  sessionId: string,
): boolean {
  const container = containerManager?.get(sessionId);
  if (!container) return false;
  return getContainerFreshness(container.workerBuildId, process.env.SHIPIT_BUILD_ID).state === "stale";
}

export interface InboxNotice extends NoticeDelivery {
  readonly notice: string;
}

/**
 * docs/328-session-message-inbox — the notice that rides the next turn's prompt, or `null`
 * when nothing is owed. `delivered()` records the messages the notice COVERED, so one that
 * arrives during the turn is told by the next. With `inline`, the notice is the messages
 * themselves, and its receipt marks them read.
 */
export function prepareInboxNotice(
  store: Pick<SessionInboxStore, "owed" | "unread" | "markNotified" | "markRead">,
  sessionId: string,
  opts: { inline?: boolean } = {},
): InboxNotice | null {
  let notice: string;
  let through: number;
  try {
    const owed = store.owed(sessionId);
    if (!owed) return null;
    // The receipt of an inline notice marks what the notice showed, and no more.
    const shown = opts.inline ? store.unread(sessionId) : [];
    through = shown.at(-1)?.id ?? owed.through;
    notice = opts.inline ? buildInlineInboxNotice(shown) : buildInboxNotice(owed.unread);
  } catch (err) {
    // A turn must never fail to start over a notice; the next turn tries again.
    console.error(`[session-inbox] reading the inbox of ${sessionId} failed:`, err);
    return null;
  }
  return {
    notice,
    delivered() {
      try {
        if (opts.inline) store.markRead(sessionId, through);
        else store.markNotified(sessionId, through);
      } catch (err) {
        console.error(`[session-inbox] marking ${sessionId}'s inbox as told failed:`, err);
      }
    },
  };
}
