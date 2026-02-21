import { useEffect, useRef, type Dispatch, type SetStateAction, type MutableRefObject } from "react";
import type { WsClientMessage } from "../../server/types.js";
import type { ChatMessage } from "../components/MessageList.js";
import type { StreamingActivity } from "../components/StreamingIndicator.js";
import type { TemplateInfo } from "../components/TemplateSelector.js";
import { getSavedAgentId } from "../utils/local-storage.js";

export function useConnectionSync(params: {
  status: string;
  send: (msg: WsClientMessage) => void;
  sessionIdRef: MutableRefObject<string | undefined>;
  historyLoadedRef: MutableRefObject<boolean>;
  templates: TemplateInfo[];
  isLoading: boolean;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setActivity: Dispatch<SetStateAction<StreamingActivity | undefined>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  prStatus: { checks: { state: string } } | null;
}): void {
  const { status, send, sessionIdRef, historyLoadedRef, templates, isLoading, setIsLoading, setActivity, setMessages, prStatus } = params;

  // On WebSocket connect, restore chat history for the saved session + check GitHub status
  useEffect(() => {
    if (status === "open" && !historyLoadedRef.current && sessionIdRef.current) {
      historyLoadedRef.current = true;
      send({ type: "get_chat_history", sessionId: sessionIdRef.current });
    }
    if (status === "open") {
      send({ type: "github_get_status" });
      send({ type: "list_sessions" });
      send({ type: "list_agents" });
      // Restore saved agent preference on connect
      const savedAgent = getSavedAgentId();
      if (savedAgent !== "claude") {
        send({ type: "set_agent", agentId: savedAgent });
      }
    }
    if (status === "closed") {
      historyLoadedRef.current = false;
    }
  }, [status, send, sessionIdRef, historyLoadedRef]);

  // Fetch PR status on session load
  useEffect(() => {
    if (status === "open" && sessionIdRef.current) {
      send({ type: "get_pr_status" });
    }
  }, [status, send, sessionIdRef]);

  // Poll PR status while CI is pending
  useEffect(() => {
    if (prStatus?.checks.state === "pending") {
      const interval = setInterval(() => {
        send({ type: "get_pr_status" });
      }, 30_000);
      return () => clearInterval(interval);
    }
  }, [prStatus?.checks.state, send]);

  // Request templates when connected (needed by both the template picker and NewRepoDialog)
  useEffect(() => {
    if (status === "open" && templates.length === 0) {
      send({ type: "list_templates" });
    }
  }, [status, templates.length, send]);

  // Handle WebSocket disconnection during streaming
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const wasOpen = prevStatusRef.current === "open";
    prevStatusRef.current = status;

    if (wasOpen && status === "closed" && isLoading) {
      setIsLoading(false);
      setActivity(undefined);
      setMessages((prev) => {
        // Mark any streaming assistant message as no longer streaming
        const last = prev[prev.length - 1];
        const updated =
          last && last.role === "assistant" && last.streaming
            ? [...prev.slice(0, -1), { ...last, streaming: false }]
            : prev;
        return [
          ...updated,
          {
            role: "assistant" as const,
            text: "Error: Connection lost while the agent was responding. Your message may be incomplete.",
            streaming: false,
            isError: true,
          },
        ];
      });
    }
  }, [status, isLoading, setIsLoading, setActivity, setMessages]);
}
