import type { RefObject } from "react";
import type { InteractiveTerminalHandle } from "../../components/InteractiveTerminal.js";
import type { WsServerMessage } from "../../../server/shared/types.js";
import type { ChatMessage } from "../../components/MessageList.js";

/**
 * Stash for queued messages removed from the conversation.
 *
 * When a `message_queued` arrives, the optimistically-added user message is
 * removed from the chat and stored here keyed by its text. When the message
 * is later dequeued for execution (`queue_updated` with `dequeued` set), the
 * stashed entry is re-appended at the correct position (end of the
 * conversation, after the just-completed assistant turn).
 *
 * The stash is module-level so it survives re-renders of the hook. The lone
 * instance lives in `./index.ts` and is threaded through `HandlerContext`.
 */
export type QueuedMessageStash = Map<string, ChatMessage>;

/**
 * Shared context object passed to every message handler.
 *
 * Built once per dispatched message by `useMessageHandler` so handlers do
 * not have to import stores themselves and so external dependencies
 * (terminal ref, notification dispatcher) are explicit.
 */
export interface HandlerContext {
  terminalRef: RefObject<InteractiveTerminalHandle | null>;
  /** Shared stash for queued user messages — see `QueuedMessageStash`. */
  queuedMessageStash: QueuedMessageStash;
}

/**
 * A message handler is a pure function that receives the shared context and
 * a discriminated-union variant of `WsServerMessage` narrowed to its
 * specific `type`. The handler dispatcher in `./index.ts` performs the
 * narrowing so individual handlers can be strongly typed without an `any`.
 */
export type Handler<T extends WsServerMessage = WsServerMessage> = (
  ctx: HandlerContext,
  data: T,
) => void;
