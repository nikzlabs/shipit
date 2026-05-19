// eslint-disable-next-line no-restricted-imports -- useEffect: WebSocket message dispatch to stores (external system sync)
import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { InteractiveTerminalHandle } from "../components/InteractiveTerminal.js";
import type { WsServerMessage, WsClientMessage } from "../../server/shared/types.js";
import { useSessionStore } from "../stores/session-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import type { NotifyContext } from "./useNotification.js";
import { parseRepoLabel } from "../utils/repo-label.js";
import {
  createQueuedMessageStash,
  dispatchMessage,
  type HandlerContext,
} from "./message-handlers/index.js";

export function useMessageHandler(params: {
  lastMessage: MessageEvent | null;
  drainMessages: () => MessageEvent[];
  send: (msg: WsClientMessage) => void;
  terminalRef: RefObject<InteractiveTerminalHandle | null>;
  notify: (msg: string, context?: NotifyContext) => void;
}): void {
  const { lastMessage, drainMessages, send, terminalRef, notify } = params;

  // The queued-message stash must survive re-renders so a `queue_updated`
  // arriving after `message_queued` can find the stashed entry. A module-level
  // Map would also work but a ref scopes it to this hook instance.
  const queuedMessageStashRef = useRef(createQueuedMessageStash());

  // Build the shared context once per render. The `buildNotifyContext`
  // closure intentionally reads store state lazily (at notify-time, not
  // build-time) so it always reflects the latest session/repo.
  const ctx: HandlerContext = useMemo(() => ({
    terminalRef,
    notify,
    buildNotifyContext: (): NotifyContext => {
      const session = useSessionStore.getState();
      const currentSession = session.sessions.find((s) => s.id === session.sessionId);
      const repoUrl = currentSession?.remoteUrl ?? useRepoStore.getState().activeRepoUrl;
      return {
        sessionName: currentSession?.title,
        repoLabel: repoUrl ? parseRepoLabel(repoUrl) : undefined,
      };
    },
    queuedMessageStash: queuedMessageStashRef.current,
  }), [terminalRef, notify]);

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    // Drain ALL messages that arrived since the last render. This prevents
    // message loss when React batches multiple setLastMessage() calls between
    // renders (common during compose stack startup bursts).
    const messages = drainMessages();
    if (messages.length === 0) return;

    for (const msg of messages) {
      let data: WsServerMessage;
      try {
        data = JSON.parse(msg.data as string) as WsServerMessage;
      } catch {
        continue;
      }
      dispatchMessage(ctx, data);
    }
  }, [lastMessage, drainMessages, send, ctx]);
}
