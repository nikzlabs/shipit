// eslint-disable-next-line no-restricted-imports -- useEffect: WebSocket message dispatch to stores (external system sync)
import { useEffect, type RefObject } from "react";
import type { ChatMessage, ToolResultBlock } from "../components/MessageList.js";
import { activityFromTool } from "../components/StreamingIndicator.js";
import type { InteractiveTerminalHandle } from "../components/InteractiveTerminal.js";
import type {
  WsServerMessage,
  WsChatHistoryMessage,
  AgentContentBlock, WsClientMessage,
} from "../../server/shared/types.js";
import { PERMISSION_MODE_KEY, SIDEBAR_COLLAPSED_KEY, AGENT_PREFERENCE_KEY } from "../utils/local-storage.js";
import { useSessionStore } from "../stores/session-store.js";
import { useGitStore } from "../stores/git-store.js";
import { useFileStore } from "../stores/file-store.js";
import { usePreviewStore } from "../stores/preview-store.js";
import { useTerminalStore } from "../stores/terminal-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { usePrStore } from "../stores/pr-store.js";

/**
 * Stash for queued messages removed from the conversation.
 * When a message is queued, it's removed from the messages array and stored here.
 * When dequeued for execution, it's retrieved and appended at the correct position.
 */
const queuedMessageStash = new Map<string, ChatMessage>();

export function useMessageHandler(params: {
  lastMessage: MessageEvent | null;
  drainMessages: () => MessageEvent[];
  send: (msg: WsClientMessage) => void;
  terminalRef: RefObject<InteractiveTerminalHandle | null>;
  notify: (msg: string) => void;
}): void {
  const { lastMessage, drainMessages, send, terminalRef, notify } = params;

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
      processMessage(data, { terminalRef, notify });
    }
  }, [lastMessage, drainMessages, send, terminalRef, notify]);
}

function processMessage(
  data: WsServerMessage,
  deps: {
    terminalRef: RefObject<InteractiveTerminalHandle | null>;
    notify: (msg: string) => void;
  },
): void {
    const { terminalRef, notify } = deps;
    const session = useSessionStore.getState();
    const git = useGitStore.getState();
    const file = useFileStore.getState();
    const preview = usePreviewStore.getState();
    const terminal = useTerminalStore.getState();
    const settings = useSettingsStore.getState();
    const ui = useUiStore.getState();

    if (data.type === "preview_status") {
      // Discard stale preview_status from a previous session's WS connection.
      // During session switching, React may batch a setLastMessage() from the
      // closing WS and process it after stores have been reset for the new session.
      const currentSessionId = session.sessionId;
      if (data.sessionId && currentSessionId && data.sessionId !== currentSessionId) {
        return;
      }
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
      const event = data.event;

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

          if (toolUseBlocks.some((b) => b.name === "ExitPlanMode")) {
            notify("The agent has a plan ready for review.");
          }
        } else if (textBlocks) {
          session.setActivity({ label: "Thinking..." });
        }

        if (textBlocks || toolUseBlocks.length > 0) {
          session.setMessages((prev) => {
            const last = prev[prev.length - 1];
            const canMerge = last?.role === "assistant" && last.streaming
              && !(last.toolResults && last.toolResults.length > 0);
            // Standalone tools like ExitPlanMode and AskUserQuestion should stay
            // with the preceding assistant text even after tool results arrive.
            // Without this, the PlanApproval card renders in an empty bubble
            // disconnected from the plan text when the agent does research
            // (Read, Grep, etc.) between writing the plan and calling ExitPlanMode.
            const STANDALONE_MERGE = new Set(["ExitPlanMode", "AskUserQuestion"]);
            const isStandaloneOnly = !textBlocks && toolUseBlocks.length > 0
              && toolUseBlocks.every((t) => STANDALONE_MERGE.has(t.name));
            const forceMerge = isStandaloneOnly
              && last?.role === "assistant" && last.streaming;
            if (canMerge || forceMerge) {
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
            const closed = prev.map((m) =>
              m.role === "assistant" && m.streaming ? { ...m, streaming: false } : m
            );
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
            } else if (rawContent === null || rawContent === undefined) {
              content = "";
            } else {
              content = JSON.stringify(rawContent);
            }
            if (content.length > 1_000_000) {
              content = `${content.slice(0, 1_000_000)  }\n... (output truncated — exceeded 1MB)`;
            }
            results.push({
              toolUseId: block.tool_use_id as string,
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
        session.setMessages((prev) =>
          prev.map((m) =>
            m.role === "assistant" && m.streaming ? { ...m, streaming: false } : m
          )
        );
      }
    }

    if (data.type === "error") {
      session.setIsLoading(false);
      session.setActivity(undefined);
      session.setMessages((prev) => {
        const updated = prev.map((m) =>
          m.role === "assistant" && m.streaming ? { ...m, streaming: false } : m
        );
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
          useFileStore.getState().fetchFileWithTree(currentSessionId, currentViewingFile).catch((err: unknown) => console.warn("[file-refresh]", err));
        } else {
          useFileStore.getState().fetchTree(currentSessionId).catch((err: unknown) => console.warn("[file-refresh]", err));
        }
      }
    }

    if (data.type === "commit_linked") {
      session.setMessages((prev) => prev.map((m, i) =>
        i === data.messageIndex
          ? { ...m, commitHash: data.commitHash, parentCommitHash: data.parentCommitHash }
          : m
      ));
    }

    if (data.type === "rollback_complete") {
      const { messageIndex, mode, parentCommitHash } = data as { messageIndex: number; mode: string; parentCommitHash: string };
      if (mode === "code") {
        // Code-only rollback: insert a divider after the rolled-back message
        session.setMessages((prev) => {
          const updated = [...prev];
          // Insert a system-style divider message after the target
          const divider = {
            role: "assistant" as const,
            text: `Code rolled back to ${parentCommitHash.slice(0, 7)}. The changes from the previous response have been reverted.`,
            isError: false,
            streaming: false,
          };
          updated.splice(messageIndex + 1, 0, divider);
          return updated;
        });
      } else {
        // Code + chat rollback: mark messages after messageIndex as rolled back
        session.setMessages((prev) => prev.map((m, i) =>
          i > messageIndex ? { ...m, rolledBack: true } : m
        ));
      }
      // Refresh git history and file tree
      const currentSessionId = useSessionStore.getState().sessionId;
      if (currentSessionId) {
        useFileStore.getState().fetchTree(currentSessionId).catch((err: unknown) => console.warn("[file-refresh]", err));
      }
    }

    if (data.type === "rewind_complete") {
      const { messageIndex } = data as { messageIndex: number };
      // Remove the target user message and everything after it
      session.setMessages((prev) => prev.slice(0, messageIndex));
      // Refresh file tree
      const currentSessionId = useSessionStore.getState().sessionId;
      if (currentSessionId) {
        useFileStore.getState().fetchTree(currentSessionId).catch((err: unknown) => console.warn("[file-refresh]", err));
      }
    }

    if (data.type === "session_forked") {
      const { sessionName } = data as { sessionId: string; sessionName: string };
      // Add a notification-style message in current chat
      session.setMessages((prev) => [
        ...prev,
        {
          role: "assistant" as const,
          text: `Session forked as "${sessionName}". Switch to it from the sidebar.`,
          streaming: false,
        },
      ]);
    }

    // auth_required, auth_complete, and agent_list are now delivered via SSE
    // (useServerEvents hook). Only handle session-scoped auth here if needed.
    if (data.type === "auth_required") {
      session.setIsLoading(false);
      session.setActivity(undefined);
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

    // session_list is now delivered via SSE (useServerEvents hook)

    if (data.type === "session_started") {
      // No-op: handled elsewhere
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
          useFileStore.getState().fetchFileWithTree(sid, currentViewingFile).catch((err: unknown) => console.warn("[file-refresh]", err));
        } else if (needsTree) {
          useFileStore.getState().fetchTree(sid).catch((err: unknown) => console.warn("[file-refresh]", err));
        } else if (needsFile) {
          useFileStore.getState().refreshFileContent(sid, currentViewingFile).catch((err: unknown) => console.warn("[file-refresh]", err));
        }
      }

    }

    if (data.type === "chat_history") {
      const loaded: ChatMessage[] = data.messages.map((m: WsChatHistoryMessage) => ({
        role: m.role, text: m.text, toolUse: m.toolUse, toolResults: m.toolResults, images: m.images, files: m.files, isError: m.isError, streaming: false,
        commitHash: m.commitHash, parentCommitHash: m.parentCommitHash, uploadPaths: m.uploadPaths,
      }));
      session.setMessages(loaded);
    }

    if (data.type === "template_applied") {
      ui.setShowTemplates(false);
      const sid = useSessionStore.getState().sessionId;
      if (sid) {
        useFileStore.getState().fetchTree(sid).catch((err: unknown) => console.warn("[file-refresh]", err));
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
      const info = data;
      ui.setModelInfo({ model: info.model, contextWindowTokens: info.contextWindowTokens });
    }

    if (data.type === "usage_update") {
      const update = data;
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

    if (data.type === "system_user_message") {
      session.setMessages((prev) => [...prev, { role: "user" as const, text: data.text }]);
      session.setIsLoading(true);
      if (data.activity) {
        session.setActivity({ label: data.activity });
      }
    }

    if (data.type === "message_queued") {
      const queued = data;
      session.setQueuedMessages((prev) => [...prev, { text: queued.text, position: queued.position }]);
      // Remove the optimistically-added message from the conversation and stash it.
      // The message will be re-inserted at the correct position (after the completed
      // assistant turn) when it is dequeued for execution via queue_updated.
      session.setMessages((prev) => {
        let targetIdx = -1;
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i]?.role === "user" && prev[i]?.text === queued.text) {
            targetIdx = i;
            break;
          }
        }
        if (targetIdx !== -1) {
          queuedMessageStash.set(queued.text, prev[targetIdx]);
          return [...prev.slice(0, targetIdx), ...prev.slice(targetIdx + 1)];
        }
        return prev;
      });
    }

    if (data.type === "queue_updated") {
      const update = data;
      session.setQueuedMessages(update.queue);
      if (update.dequeued) {
        // A message was dequeued for execution — re-insert it at the end of
        // the conversation (after the just-completed assistant turn).
        const stashed = queuedMessageStash.get(update.dequeued);
        queuedMessageStash.delete(update.dequeued);
        const restoredMsg: ChatMessage = stashed
          ? { ...stashed, queued: false, queuePosition: undefined }
          : { role: "user" as const, text: update.dequeued };
        session.setMessages((prev) => [...prev, restoredMsg]);
      }
      // For cancels / clears (no dequeued field), just clean up stashed messages
      // that are no longer in the queue.
      const remainingTexts = new Set(update.queue.map((q) => q.text));
      for (const key of queuedMessageStash.keys()) {
        if (!remainingTexts.has(key)) {
          queuedMessageStash.delete(key);
        }
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
        const closed = prev.map((m) =>
          m.role === "assistant" && m.streaming ? { ...m, streaming: false } : m
        );
        if (last?.role === "assistant" && last.streaming) {
          return [...closed.slice(0, -1), { ...last, streaming: false, text: `${last.text}\n\n_(Interrupted by user)_` }];
        }
        return closed;
      });
    }

    if (data.type === "log_entry") {
      terminal.addEntry({ source: data.source, text: data.text, timestamp: data.timestamp });
    }

    if (data.type === "clear_logs") {
      terminal.clearEntries();
    }

    if (data.type === "service_list") {
      preview.setServices(
        data.services.map((s) => ({
          name: s.name,
          status: s.status,
          port: s.port,
          preview: s.preview,
          error: s.error,
        })),
      );
    }

    if (data.type === "service_status") {
      preview.updateService({
        name: data.name,
        status: data.status,
        port: data.port,
        preview: data.preview,
        error: data.error,
      });
    }

    if (data.type === "compose_error") {
      preview.setComposeError(data.message || null);
    }

    if (data.type === "compose_not_configured") {
      preview.setComposeNotConfigured(true);
    }

    if (data.type === "service_log") {
      terminal.addEntry({ source: "preview", text: `[${data.name}] ${data.text}`, timestamp: new Date().toISOString() });
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
        if (!data.running) {
          session.setActivity(undefined);
        }
      }
    }

    if (data.type === "pr_lifecycle_update") {
      usePrStore.getState().updateCard(data.sessionId, {
        cardId: data.cardId,
        phase: data.phase,
        headBranch: data.headBranch,
        files: data.files,
        totalInsertions: data.totalInsertions,
        totalDeletions: data.totalDeletions,
        pr: data.pr,
        checks: data.checks,
        errorMessage: data.errorMessage,
      });
    }

    // session_agent_started/finished, repo_status, repo_warm_ready, repo_list
    // are now delivered via SSE (useServerEvents hook)
}
