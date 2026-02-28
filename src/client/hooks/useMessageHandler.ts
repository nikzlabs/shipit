import { useEffect, type MutableRefObject } from "react";
import type { ChatMessage, ToolResultBlock } from "../components/MessageList.js";
import { activityFromTool } from "../components/StreamingIndicator.js";
import type { InteractiveTerminalHandle } from "../components/InteractiveTerminal.js";
import type {
  WsServerMessage, WsUsageUpdate, WsModelInfo,
  WsChatHistoryMessage,
  AgentEvent, AgentContentBlock, WsClientMessage,
  WsMessageQueued, WsQueueUpdated,
} from "../../server/shared/types.js";
import { PERMISSION_MODE_KEY, SIDEBAR_COLLAPSED_KEY, AGENT_PREFERENCE_KEY } from "../utils/local-storage.js";
import { useSessionStore } from "../stores/session-store.js";
import { useGitStore } from "../stores/git-store.js";
import { useFileStore } from "../stores/file-store.js";
import { usePreviewStore } from "../stores/preview-store.js";
import { useTerminalStore } from "../stores/terminal-store.js";
import { useThreadStore } from "../stores/thread-store.js";
import { useDeployStore } from "../stores/deploy-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useRepoStore } from "../stores/repo-store.js";

export function useMessageHandler(params: {
  lastMessage: MessageEvent | null;
  send: (msg: WsClientMessage) => void;
  terminalRef: MutableRefObject<InteractiveTerminalHandle | null>;
  notify: (msg: string) => void;
  navigate: (path: string, opts?: { replace?: boolean }) => void;
}): void {
  const { lastMessage, send, terminalRef, notify, navigate } = params;

  useEffect(() => {
    if (!lastMessage) return;

    let data: WsServerMessage;
    try {
      data = JSON.parse(lastMessage.data) as WsServerMessage;
    } catch {
      return;
    }

    const session = useSessionStore.getState();
    const git = useGitStore.getState();
    const file = useFileStore.getState();
    const preview = usePreviewStore.getState();
    const terminal = useTerminalStore.getState();
    const thread = useThreadStore.getState();
    const deploy = useDeployStore.getState();
    const settings = useSettingsStore.getState();
    const ui = useUiStore.getState();

    if (data.type === "preview_status") {
      preview.setStatus({
        running: data.running,
        port: data.port,
        url: data.url,
        source: data.source,
        detectedPorts: data.detectedPorts,
      });
      const currentPort = usePreviewStore.getState().selectedPort;
      if (currentPort !== null) {
        const allAvailable = [...(data.detectedPorts ?? [])];
        if (data.source === "vite" || data.source === "managed") allAvailable.push(data.port);
        if (!allAvailable.includes(currentPort)) {
          preview.setSelectedPort(null);
        }
      }
    }

    if (data.type === "agent_event") {
      const event = data.event as AgentEvent;

      if (event.type === "agent_assistant") {
        const textBlocks = (event.content ?? [])
          .filter((b: AgentContentBlock): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");

        const toolUseBlocks = (event.content ?? [])
          .filter((b: AgentContentBlock): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => b.type === "tool_use");

        if (toolUseBlocks.length > 0) {
          const lastTool = toolUseBlocks[toolUseBlocks.length - 1];
          session.setActivity(activityFromTool(lastTool.name, lastTool.input));
        } else if (textBlocks) {
          session.setActivity({ label: "Thinking..." });
        }

        if (textBlocks || toolUseBlocks.length > 0) {
          session.setMessages((prev) => {
            const last = prev[prev.length - 1];
            const canMerge = last && last.role === "assistant" && last.streaming
              && !(last.toolResults && last.toolResults.length > 0);
            if (canMerge) {
              return [
                ...prev.slice(0, -1),
                {
                  role: "assistant" as const,
                  text: last.text + textBlocks,
                  toolUse: [...(last.toolUse ?? []), ...toolUseBlocks],
                  toolResults: last.toolResults,
                  streaming: true,
                },
              ];
            }
            const closed = last && last.role === "assistant" && last.streaming
              ? [...prev.slice(0, -1), { ...last, streaming: false }]
              : prev;
            return [
              ...closed,
              {
                role: "assistant" as const,
                text: textBlocks,
                toolUse: toolUseBlocks,
                streaming: true,
              },
            ];
          });
        }
      }

      if (event.type === "agent_tool_result") {
        session.setActivity({ label: "Processing results..." });

        const results: ToolResultBlock[] = [];
        for (const block of (event.content ?? []) as Record<string, unknown>[]) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const rawContent = block.content;
            let content: string;
            if (typeof rawContent === "string") {
              content = rawContent;
            } else if (rawContent == null) {
              content = "";
            } else {
              content = JSON.stringify(rawContent);
            }
            if (content.length > 1_000_000) {
              content = content.slice(0, 1_000_000) + "\n... (output truncated — exceeded 1MB)";
            }
            results.push({
              toolUseId: String(block.tool_use_id),
              content,
              isError: (block.is_error as boolean) ?? false,
            });
          }
        }

        if (results.length > 0) {
          session.setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant") {
              const existingResults = last.toolResults ?? [];
              return [
                ...prev.slice(0, -1),
                { ...last, toolResults: [...existingResults, ...results] },
              ];
            }
            return prev;
          });
        }
      }

      if (event.type === "agent_result") {
        session.setIsLoading(false);
        session.setActivity(undefined);
        notify("The agent has finished responding.");
        session.setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant") {
            return [...prev.slice(0, -1), { ...last, streaming: false }];
          }
          return prev;
        });
      }
    }

    if (data.type === "error") {
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
          { role: "assistant", text: `Error: ${data.message}`, streaming: false, isError: true },
        ];
      });
    }

    if (data.type === "git_log") {
      git.setCommits(data.commits);
    }

    if (data.type === "git_committed") {
      const prevHash = useGitStore.getState().commits[0]?.hash;
      if (prevHash) {
        git.setLastCommitPair({ from: prevHash, to: data.hash });
        git.setTurnDiff(null);
      }
      git.prependCommit({ hash: data.hash, message: data.message, date: new Date().toISOString(), author: "ShipIt" });
      const currentRightTab = useUiStore.getState().rightTab;
      const currentSessionId = useSessionStore.getState().sessionId;
      if (currentRightTab === "files" && currentSessionId) {
        const currentViewingFile = useFileStore.getState().viewingFile;
        if (currentViewingFile) {
          fetch(`/api/sessions/${currentSessionId}/files/${currentViewingFile}?tree=true`)
            .then((r) => r.json())
            .then((d) => {
              useFileStore.getState().setTree(d.tree);
              useFileStore.getState().setViewingFileContent(d.content);
              useFileStore.getState().setViewingFileBinary(d.isBinary ?? false);
            }).catch(() => {});
        } else {
          fetch(`/api/sessions/${currentSessionId}/files`)
            .then((r) => r.json())
            .then((d) => useFileStore.getState().setTree(d.tree))
            .catch(() => {});
        }
      }
    }

    if (data.type === "auth_required") {
      session.setAuthUrl(data.url ?? "");
      session.setIsLoading(false);
      session.setActivity(undefined);
    }

    if (data.type === "auth_complete") {
      session.setAuthUrl(null);
    }

    if (data.type === "agent_list") {
      ui.setAgentList(data.agents);
    }

    if (data.type === "global_settings") {
      git.setIdentity({ name: data.gitIdentity.name, email: data.gitIdentity.email });
      settings.setSystemPromptContent(data.systemPrompt);
      settings.setHasSystemPrompt(data.systemPrompt.length > 0);
      ui.setAgentList(data.agents);
    }

    if (data.type === "git_identity_required") {
      git.setIdentityNeeded(true);
    }

    if (data.type === "session_list") {
      session.setSessions(data.sessions);
    }

    if (data.type === "session_started") {
      session.setSessionId(data.session.id);
      navigate(`/session/${data.session.id}`, { replace: true });
      session.setSessions((prev) => {
        const exists = prev.some((s) => s.id === data.session.id);
        if (exists) {
          return prev.map((s) => (s.id === data.session.id ? data.session : s));
        }
        return [data.session, ...prev];
      });
      fetch(`/api/sessions/${data.session.id}/threads`)
        .then((r) => r.json())
        .then((d) => {
          useThreadStore.getState().setThreads(d.threads);
          useThreadStore.getState().setActiveThreadId(d.activeThreadId);
        })
        .catch(() => {});
    }

    if (data.type === "file_tree") {
      file.setTree(data.tree);
    }

    if (data.type === "files_changed") {
      const paths: string[] = data.paths;
      const sid = useSessionStore.getState().sessionId;
      const currentRightTab = useUiStore.getState().rightTab;
      const currentViewingFile = useFileStore.getState().viewingFile;

      if (sid) {
        const needsTree = currentRightTab === "files";
        const needsFile = currentViewingFile && paths.some((p) => currentViewingFile.endsWith(p));

        if (needsTree && needsFile) {
          fetch(`/api/sessions/${sid}/files/${currentViewingFile}?tree=true`)
            .then((r) => r.json())
            .then((d) => {
              useFileStore.getState().setTree(d.tree);
              useFileStore.getState().setViewingFileContent(d.content);
              useFileStore.getState().setViewingFileBinary(d.isBinary ?? false);
            }).catch(() => {});
        } else if (needsTree) {
          fetch(`/api/sessions/${sid}/files`)
            .then((r) => r.json())
            .then((d) => useFileStore.getState().setTree(d.tree))
            .catch(() => {});
        } else if (needsFile) {
          fetch(`/api/sessions/${sid}/files/${currentViewingFile}`)
            .then((r) => r.json())
            .then((d) => {
              useFileStore.getState().setViewingFileContent(d.content);
              useFileStore.getState().setViewingFileBinary(d.isBinary ?? false);
            })
            .catch(() => {});
        }
      }

    }

    if (data.type === "chat_history") {
      const loaded: ChatMessage[] = data.messages.map((m: WsChatHistoryMessage) => ({
        role: m.role, text: m.text, toolUse: m.toolUse, images: m.images, files: m.files, isError: m.isError, streaming: false,
      }));
      session.setMessages(loaded);
    }

    if (data.type === "template_applied") {
      ui.setShowTemplates(false);
      const sid = useSessionStore.getState().sessionId;
      if (sid) {
        fetch(`/api/sessions/${sid}/files`)
          .then((r) => r.json())
          .then((d) => useFileStore.getState().setTree(d.tree))
          .catch(() => {});
      }
    }

    if (data.type === "github_status") {
      settings.setGithubStatus({
        authenticated: data.authenticated,
        username: data.username,
        avatarUrl: data.avatarUrl,
      });
    }

    if (data.type === "model_info") {
      const info = data as WsModelInfo;
      ui.setModelInfo({ model: info.model, contextWindowTokens: info.contextWindowTokens });
    }

    if (data.type === "usage_update") {
      const update = data as WsUsageUpdate;
      ui.setCurrentSessionUsage({
        sessionId: update.sessionId,
        totalCostUsd: update.totalCostUsd,
        totalDurationMs: update.totalDurationMs,
        turnCount: update.turnCount,
      });
      if (update.cumulativeInputTokens !== undefined) {
        ui.setContextTokens(update.cumulativeInputTokens);
      }
      if (update.lastTurnInputTokens !== undefined || update.lastTurnOutputTokens !== undefined) {
        ui.setTurnTokens((prev) => [
          ...prev,
          {
            inputTokens: update.lastTurnInputTokens,
            outputTokens: update.lastTurnOutputTokens,
            costUsd: update.totalCostUsd - prev.reduce((sum, t) => sum + t.costUsd, 0),
            durationMs: update.totalDurationMs - prev.reduce((sum, t) => sum + t.durationMs, 0),
          },
        ]);
      }
    }

    if (data.type === "thread_list") {
      thread.setThreads(data.threads);
      thread.setActiveThreadId(data.activeThreadId);
    }

    if (data.type === "thread_forked") {
      const currentThreads = useThreadStore.getState().threads;
      thread.setThreads([...currentThreads.map((t) => ({ ...t, isActive: false })), data.thread]);
      thread.setActiveThreadId(data.thread.id);
      const loaded: ChatMessage[] = data.messages.map((m: WsChatHistoryMessage) => ({
        role: m.role, text: m.text, toolUse: m.toolUse, images: m.images, isError: m.isError, streaming: false,
      }));
      session.setMessages(loaded);
    }

    if (data.type === "thread_switched") {
      const currentThreads = useThreadStore.getState().threads;
      thread.setThreads(currentThreads.map((t) => ({ ...t, isActive: t.id === data.thread.id })));
      thread.setActiveThreadId(data.thread.id);
      const loaded: ChatMessage[] = data.messages.map((m: WsChatHistoryMessage) => ({
        role: m.role, text: m.text, toolUse: m.toolUse, images: m.images, isError: m.isError, streaming: false,
      }));
      session.setMessages(loaded);
    }

    if (data.type === "deploy_status") {
      deploy.setStatus(data.phase);
      deploy.setLastUrl(null);
      deploy.setLastError(null);
    }

    if (data.type === "deploy_complete") {
      deploy.setStatus("complete");
      deploy.setLastUrl(data.url);
      deploy.setLastError(null);
    }

    if (data.type === "deploy_error") {
      deploy.setStatus("error");
      deploy.setLastError(data.message);
    }

    if (data.type === "message_queued") {
      const queued = data as WsMessageQueued;
      session.setQueuedMessages((prev) => [...prev, { text: queued.text, position: queued.position }]);
      session.setMessages((prev) => [...prev, { role: "user" as const, text: queued.text, queued: true, queuePosition: queued.position }]);
    }

    if (data.type === "queue_updated") {
      const update = data as WsQueueUpdated;
      session.setQueuedMessages(update.queue);
      if (update.queue.length === 0) {
        session.setMessages((prev) =>
          prev.map((m) => (m.queued ? { ...m, queued: false, queuePosition: undefined } : m))
        );
      } else {
        const queueTexts = new Set(update.queue.map((q) => q.text));
        session.setMessages((prev) =>
          prev.map((m) => {
            if (!m.queued) return m;
            if (!queueTexts.has(m.text)) return { ...m, queued: false, queuePosition: undefined };
            const queueItem = update.queue.find((q) => q.text === m.text);
            return queueItem ? { ...m, queuePosition: queueItem.position } : m;
          })
        );
      }
    }

    if (data.type === "full_reset_complete") {
      try {
        localStorage.removeItem("shipit-theme");
        localStorage.removeItem(PERMISSION_MODE_KEY);
        localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
        localStorage.removeItem(AGENT_PREFERENCE_KEY);
        localStorage.removeItem("vibe-panel-split");
      } catch { /* localStorage may be unavailable */ }
      window.location.reload();
      return;
    }

    if (data.type === "claude_interrupted") {
      session.setIsLoading(false);
      session.setActivity(undefined);
      session.setQueuedMessages([]);
      session.setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          return [...prev.slice(0, -1), { ...last, streaming: false, text: last.text + "\n\n_(Interrupted by user)_" }];
        }
        return prev;
      });
    }

    if (data.type === "log_entry") {
      terminal.addEntry({ source: data.source, text: data.text, timestamp: data.timestamp });
    }

    if (data.type === "clear_logs") {
      terminal.clearEntries();
    }

    if (data.type === "preview_config_missing") {
      preview.setConfigMissing(true);
    }

    if (data.type === "preview_config_error") {
      preview.setConfigMissing(false);
      ui.setToast({ message: `Preview config error: ${data.message}` });
    }

    if (data.type === "install_status") {
      preview.setInstallStatus({ status: data.status, message: data.message });
      if (data.status === "complete") {
        setTimeout(() => usePreviewStore.getState().setInstallStatus(null), 1000);
      }
    }

    if (data.type === "preview_status" && data.running) {
      preview.setConfigMissing(false);
      preview.setInstallStatus(null);
    }

    if (data.type === "turn_diff") {
      git.setTurnDiff({ fromCommit: data.fromCommit, toCommit: data.toCommit, files: data.files, stats: data.stats });
    }

    if (data.type === "terminal_output") {
      terminalRef.current?.write(data.data);
    }

    if (data.type === "terminal_exit") {
      terminal.setShellStarted(false);
    }

    if (data.type === "session_status") {
      session.setActiveRunnerSessions((prev) => {
        const next = new Set(prev);
        if (data.running) { next.add(data.sessionId); } else { next.delete(data.sessionId); }
        return next;
      });
      if (data.sessionId === useSessionStore.getState().sessionId) {
        session.setIsLoading(data.running);
      }
    }

    if (data.type === "session_agent_started") {
      session.setActiveRunnerSessions((prev) => { const next = new Set(prev); next.add(data.sessionId); return next; });
    }

    if (data.type === "session_agent_finished") {
      session.setActiveRunnerSessions((prev) => { const next = new Set(prev); next.delete(data.sessionId); return next; });
    }

    // ---- Repo messages ----
    if (data.type === "repo_status") {
      useRepoStore.getState().updateRepoStatus(data.url, data.status);
    }

    if (data.type === "repo_warm_ready") {
      useRepoStore.getState().updateRepoWarmSession(data.url, data.sessionId);
    }

    if (data.type === "repo_list") {
      useRepoStore.getState().setRepos(data.repos);
    }
  }, [lastMessage, send, terminalRef, notify, navigate]);
}
