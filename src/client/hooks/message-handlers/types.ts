import type { RefObject } from "react";
import type { InteractiveTerminalHandle } from "../../components/InteractiveTerminal.js";
import type { WsServerMessage } from "../../../server/shared/types.js";
import type { ChatMessage } from "../../components/MessageList.js";

export type QueuedMessageStash = Map<string, ChatMessage>;

export interface HandlerContext {
  terminalRef: RefObject<InteractiveTerminalHandle | null>;

  queuedMessageStash: QueuedMessageStash;
}

export type Handler<T extends WsServerMessage = WsServerMessage> = (
  ctx: HandlerContext,
  data: T,
) => void;
