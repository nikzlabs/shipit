// eslint-disable-next-line no-restricted-imports -- useEffect: bootstrap spinner timer (setTimeout cleanup) + browser event bridge for restore-rewind
import { useState, useEffect, type RefObject } from "react";
import type { InteractiveTerminalHandle } from "../components/InteractiveTerminal.js";
import type { WsClientMessage } from "../../server/shared/types.js";
import { useConnectionSync } from "./useConnectionSync.js";
import { useMessageHandler } from "./useMessageHandler.js";
import { useFileStore } from "../stores/file-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useSessionStore } from "../stores/session-store.js";

/**
 * App bootstrap wiring: per-session WS connect handling (`useConnectionSync`),
 * the delayed bootstrap-loading spinner, the WS message dispatcher
 * (`useMessageHandler`), and the `shipit:restore-rewind` browser-event bridge.
 *
 * The global SSE subscription (`useServerEvents`) and the per-session WS
 * connection (`useSessionWebSocket`) stay in App — they must register their
 * effects ahead of the other top-level hooks, and their return values
 * (`send`/`status`/api handles) are consumed all over App — so they are passed
 * in here rather than relocated.
 */
export function useAppBootstrap(params: {
  status: string;
  send: (msg: WsClientMessage) => void;
  lastMessage: MessageEvent | null;
  drainMessages: () => MessageEvent[];
  terminalRef: RefObject<InteractiveTerminalHandle | null>;
  bootstrapLoaded: boolean;
}): { showBootstrapSpinner: boolean } {
  const { status, send, lastMessage, drainMessages, terminalRef, bootstrapLoaded } = params;

  useConnectionSync({ status, send, onSessionConnect: (sid: string) => {
    void useFileStore.getState().hydrateUploads(sid);
    // Load user-invocable skills for the composer's `/` autocomplete (doc 138).
    void useFileStore.getState().fetchSkills(sid, useUiStore.getState().activeAgentId).catch(() => {});
    // Re-fetch docs if the docs tab is currently active. loadSessionHistory()
    // populates the file tree and commit log but not docs, so without this a
    // session switch leaves the DocsViewer stuck on "No docs found" until the
    // user clicks Refresh.
    if (useUiStore.getState().rightTab === "docs") {
      void useFileStore.getState().fetchDocs(sid).catch(() => {});
    }
  } });

  // Delayed spinner for bootstrap loading gate — only show after 1s
  const [showBootstrapSpinner, setShowBootstrapSpinner] = useState(false);
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (bootstrapLoaded) return;
    const timer = setTimeout(() => setShowBootstrapSpinner(true), 1000);
    return () => clearTimeout(timer);
  }, [bootstrapLoaded]);

  useMessageHandler({
    lastMessage,
    drainMessages,
    send,
    terminalRef,
  });

  // eslint-disable-next-line no-restricted-syntax -- browser event bridges toast/topbar actions to the active WS sender
  useEffect(() => {
    const handleRestore = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      const targetSessionId = detail?.sessionId ?? useSessionStore.getState().sessionId;
      if (targetSessionId) send({ type: "rewind_restore_request", sessionId: targetSessionId });
    };
    window.addEventListener("shipit:restore-rewind", handleRestore);
    return () => window.removeEventListener("shipit:restore-rewind", handleRestore);
  }, [send]);

  return { showBootstrapSpinner };
}
