import { useEffect, useRef } from "react";
import type { WsClientMessage } from "../../server/shared/types.js";
import type { ChatMessage } from "../components/MessageList.js";
import type { BootstrapData } from "../../server/orchestrator/services/index.js";
import { getSavedAgentId } from "../utils/local-storage.js";
import { useSessionStore } from "../stores/session-store.js";
import { useGitStore } from "../stores/git-store.js";
import { useFileStore } from "../stores/file-store.js";
import { useThreadStore } from "../stores/thread-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { usePrStore } from "../stores/pr-store.js";
import { useRepoStore } from "../stores/repo-store.js";

export function useConnectionSync(params: {
  status: string;
  send: (msg: WsClientMessage) => void;
}): void {
  const { status, send } = params;

  const historyLoadedRef = useRef(false);
  const bootstrapFetchedRef = useRef(false);

  // Fetch bootstrap data via HTTP — fires once on mount
  useEffect(() => {
    if (bootstrapFetchedRef.current) return;
    bootstrapFetchedRef.current = true;

    fetch("/api/bootstrap")
      .then((res) => {
        if (!res.ok) throw new Error(`Bootstrap failed: ${res.status}`);
        return res.json() as Promise<BootstrapData>;
      })
      .then((data) => {
        useSessionStore.getState().setSessions(data.sessions);
        if (data.repos) useRepoStore.getState().setRepos(data.repos);
        useUiStore.getState().setAgentList(data.agents);
        useUiStore.getState().setTemplates(data.templates);
        useSettingsStore.getState().setGithubStatus({
          authenticated: data.githubStatus.authenticated,
          username: data.githubStatus.username,
          avatarUrl: data.githubStatus.avatarUrl,
        });
        useGitStore.getState().setIdentity(data.settings.gitIdentity);
        useSettingsStore.getState().setHasSystemPrompt(data.settings.systemPrompt.length > 0);
        useSettingsStore.getState().setSystemPromptContent(data.settings.systemPrompt);
        useUiStore.getState().setBootstrapLoaded(true);
      })
      .catch((err) => {
        console.error("[bootstrap] Failed to fetch initial data:", err);
        useUiStore.getState().setBootstrapLoaded(true);
      });
  }, []);

  // On WebSocket connect, restore session
  useEffect(() => {
    if (status === "open" && !historyLoadedRef.current && useSessionStore.getState().sessionId) {
      historyLoadedRef.current = true;
      const sessionId = useSessionStore.getState().sessionId!;
      fetch(`/api/sessions/${sessionId}/history`)
        .then((res) => res.json())
        .then((data) => {
          useSessionStore.getState().setMessages(
            data.messages.map((m: { role: string; text: string; toolUse?: unknown[]; images?: unknown[]; files?: unknown[]; isError?: boolean }) => ({ ...m, streaming: false } as ChatMessage)),
          );
          useGitStore.getState().setCommits(data.commits);
          useFileStore.getState().setTree(data.fileTree);
          useThreadStore.getState().setThreads(data.threads);
          useThreadStore.getState().setActiveThreadId(data.activeThreadId);
        })
        .catch((err) => console.error("[api] Failed to load session history:", err));
      send({ type: "activate_session", sessionId });
    }
    if (status === "open") {
      const savedAgent = getSavedAgentId();
      if (savedAgent !== "claude") {
        send({ type: "set_agent", agentId: savedAgent });
      }
    }
    if (status === "closed") {
      historyLoadedRef.current = false;
    }
  }, [status, send]);

  // Fetch PR status on session load
  const prStatusFetchedRef = useRef(false);
  useEffect(() => {
    if (status === "open" && useSessionStore.getState().sessionId) {
      if (prStatusFetchedRef.current) return;
      prStatusFetchedRef.current = true;
      const sid = useSessionStore.getState().sessionId!;
      usePrStore.getState().fetchStatus(sid).catch(() => { /* session may not have a PR */ });
    }
    if (status === "closed") {
      prStatusFetchedRef.current = false;
    }
  }, [status]);

  // Poll PR status while CI is pending
  const prChecksState = usePrStore((s) => s.status?.checks.state);
  useEffect(() => {
    if (prChecksState === "pending" && useSessionStore.getState().sessionId) {
      const sid = useSessionStore.getState().sessionId!;
      const interval = setInterval(() => {
        usePrStore.getState().fetchStatus(sid).catch(() => {});
      }, 30_000);
      return () => clearInterval(interval);
    }
  }, [prChecksState]);

  // Handle WebSocket disconnection during streaming
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const wasOpen = prevStatusRef.current === "open";
    prevStatusRef.current = status;

    if (wasOpen && status === "closed" && useSessionStore.getState().isLoading) {
      const session = useSessionStore.getState();
      session.setIsLoading(false);
      session.setActivity(undefined);
      session.setMessages((prev) => {
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
  }, [status]);
}
