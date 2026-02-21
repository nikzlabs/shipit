import { useEffect, useRef, type Dispatch, type SetStateAction, type MutableRefObject } from "react";
import type { WsClientMessage, SessionInfo } from "../../server/types.js";
import type { ChatMessage } from "../components/MessageList.js";
import type { StreamingActivity } from "../components/StreamingIndicator.js";
import type { TemplateInfo } from "../components/TemplateSelector.js";
import type { AgentOption } from "../components/AgentPicker.js";
import type { BootstrapData } from "../../server/services/index.js";
import { getSavedAgentId } from "../utils/local-storage.js";

export function useConnectionSync(params: {
  status: string;
  send: (msg: WsClientMessage) => void;
  apiGet: <T>(path: string) => Promise<T>;
  sessionIdRef: MutableRefObject<string | undefined>;
  historyLoadedRef: MutableRefObject<boolean>;
  templates: TemplateInfo[];
  isLoading: boolean;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setActivity: Dispatch<SetStateAction<StreamingActivity | undefined>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  prStatus: { checks: { state: string } } | null;
  setPrStatus: Dispatch<SetStateAction<{ url: string; number: number; title: string; baseBranch: string; headBranch: string; insertions: number; deletions: number; checks: { state: "pending" | "success" | "failure" | "none"; total: number; passed: number; failed: number; pending: number }; autoMergeEnabled: boolean; mergeable: boolean } | null>>;
  // Bootstrap state setters
  setSessions: Dispatch<SetStateAction<SessionInfo[]>>;
  setAgentList: Dispatch<SetStateAction<AgentOption[]>>;
  setTemplates: Dispatch<SetStateAction<TemplateInfo[]>>;
  setGithubStatus: Dispatch<SetStateAction<{ authenticated: boolean; username?: string; avatarUrl?: string }>>;
  setImportSearchResults: Dispatch<SetStateAction<Array<{ fullName: string; description: string | null; private: boolean; defaultBranch: string; cloneUrl: string }>>>;
  setGitIdentity: Dispatch<SetStateAction<{ name: string; email: string }>>;
  setHasSystemPrompt: Dispatch<SetStateAction<boolean>>;
  setSystemPromptContent: Dispatch<SetStateAction<string>>;
}): void {
  const {
    status, send, apiGet, sessionIdRef, historyLoadedRef, isLoading,
    setIsLoading, setActivity, setMessages, prStatus, setPrStatus,
    setSessions, setAgentList, setTemplates, setGithubStatus,
    setImportSearchResults, setGitIdentity, setHasSystemPrompt, setSystemPromptContent,
  } = params;

  // Track whether bootstrap has been fetched for this page load
  const bootstrapFetchedRef = useRef(false);

  // Fetch bootstrap data via HTTP — fires once on mount, before WS connects.
  // Replaces the sequential WS messages: list_sessions, list_agents,
  // list_templates, github_get_status (plus get_global_settings).
  useEffect(() => {
    if (bootstrapFetchedRef.current) return;
    bootstrapFetchedRef.current = true;

    fetch("/api/bootstrap")
      .then((res) => {
        if (!res.ok) throw new Error(`Bootstrap failed: ${res.status}`);
        return res.json() as Promise<BootstrapData>;
      })
      .then((data) => {
        setSessions(data.sessions);
        setAgentList(data.agents);
        setTemplates(data.templates as TemplateInfo[]);
        setGithubStatus({
          authenticated: data.githubStatus.authenticated,
          username: data.githubStatus.username,
          avatarUrl: data.githubStatus.avatarUrl,
        });
        if (data.githubRepos.length > 0) {
          setImportSearchResults(data.githubRepos);
        }
        setGitIdentity(data.settings.gitIdentity);
        setHasSystemPrompt(data.settings.systemPrompt.length > 0);
        setSystemPromptContent(data.settings.systemPrompt);
      })
      .catch((err) => {
        console.error("[bootstrap] Failed to fetch initial data:", err);
      });
  }, [setSessions, setAgentList, setTemplates, setGithubStatus, setImportSearchResults, setGitIdentity, setHasSystemPrompt, setSystemPromptContent]);

  // On WebSocket connect, restore chat history for the saved session.
  // Chat history must still go through WS because it activates the session
  // (attaches runner, starts file watcher, etc.).
  useEffect(() => {
    if (status === "open" && !historyLoadedRef.current && sessionIdRef.current) {
      historyLoadedRef.current = true;
      send({ type: "get_chat_history", sessionId: sessionIdRef.current });
    }
    if (status === "open") {
      // Restore saved agent preference on connect (per-connection WS state)
      const savedAgent = getSavedAgentId();
      if (savedAgent !== "claude") {
        send({ type: "set_agent", agentId: savedAgent });
      }
    }
    if (status === "closed") {
      historyLoadedRef.current = false;
    }
  }, [status, send, sessionIdRef, historyLoadedRef]);

  // Fetch PR status on session load via HTTP
  useEffect(() => {
    if (status === "open" && sessionIdRef.current) {
      const sid = sessionIdRef.current;
      apiGet<{ pr: Parameters<typeof setPrStatus>[0] }>(`/api/sessions/${sid}/pr/status`)
        .then((data) => setPrStatus(data.pr))
        .catch(() => { /* session may not have a PR */ });
    }
  }, [status, sessionIdRef, apiGet, setPrStatus]);

  // Poll PR status while CI is pending
  useEffect(() => {
    if (prStatus?.checks.state === "pending" && sessionIdRef.current) {
      const sid = sessionIdRef.current;
      const interval = setInterval(() => {
        apiGet<{ pr: Parameters<typeof setPrStatus>[0] }>(`/api/sessions/${sid}/pr/status`)
          .then((data) => setPrStatus(data.pr))
          .catch(() => { /* ignore polling errors */ });
      }, 30_000);
      return () => clearInterval(interval);
    }
  }, [prStatus?.checks.state, sessionIdRef, apiGet, setPrStatus]);

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
