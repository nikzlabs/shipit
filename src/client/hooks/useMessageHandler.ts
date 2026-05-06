// eslint-disable-next-line no-restricted-imports -- useEffect: WebSocket message dispatch to stores (external system sync)
import { useEffect, type RefObject } from "react";
import type { ChatMessage, ToolResultBlock } from "../components/MessageList.js";
import { activityFromTool } from "../components/StreamingIndicator.js";
import type { InteractiveTerminalHandle } from "../components/InteractiveTerminal.js";
import type {
  WsServerMessage,
  AgentContentBlock, WsClientMessage,
} from "../../server/shared/types.js";
import { SIDEBAR_COLLAPSED_KEY, AGENT_PREFERENCE_KEY } from "../utils/local-storage.js";
import { useSessionStore } from "../stores/session-store.js";
import { useGitStore } from "../stores/git-store.js";
import { useFileStore } from "../stores/file-store.js";
import { usePreviewStore } from "../stores/preview-store.js";
import { useTerminalStore } from "../stores/terminal-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { usePrStore } from "../stores/pr-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import { useFileReviewStore } from "../stores/file-review-store.js";
import type { NotifyContext } from "./useNotification.js";
import { parseRepoLabel } from "../utils/repo-label.js";

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
  notify: (msg: string, context?: NotifyContext) => void;
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
    notify: (msg: string, context?: NotifyContext) => void;
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

    // Build notification context from current session + repo state
    const buildNotifyContext = (): NotifyContext => {
      const currentSession = session.sessions.find((s) => s.id === session.sessionId);
      const repoUrl = currentSession?.remoteUrl ?? useRepoStore.getState().activeRepoUrl;
      return {
        sessionName: currentSession?.title,
        repoLabel: repoUrl ? parseRepoLabel(repoUrl) : undefined,
      };
    };

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
      // Guard: skip agent events until HTTP history is loaded. On WS reconnect,
      // events arrive immediately while loadSessionHistory() is still in-flight.
      // Without this guard, events processed before the HTTP response get
      // overwritten (lost) or events processed after it duplicate HTTP data.
      // The DB-backed history snapshot is the baseline; live events build on top.
      if (!session.historyLoaded) return;

      const event = data.event;

      if (event.type === "agent_assistant") {
        const textBlocks = (event.content ?? [])
          .filter((b: AgentContentBlock): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");

        const toolUseBlocks = (event.content ?? [])
          .filter((b: AgentContentBlock): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => b.type === "tool_use");

        // Subagent events (Task tool nested events) — attach to the parent
        // message's `subagentEvents` instead of the main message stream so the
        // SubagentCall renderer can show a nested tree (109 — subagent
        // transparency).
        const parentToolUseId = (event as { parentToolUseId?: string }).parentToolUseId;
        if (parentToolUseId) {
          session.setActivity({ label: "Subagent working..." });
          session.setMessages((prev) => attachSubagentAssistant(prev, parentToolUseId, textBlocks, toolUseBlocks));
        } else if (toolUseBlocks.length > 0) {
          const lastTool = toolUseBlocks[toolUseBlocks.length - 1];
          session.setActivity(activityFromTool(lastTool.name, lastTool.input));

          if (toolUseBlocks.some((b) => b.name === "ExitPlanMode")) {
            notify("The agent has a plan ready for review.", buildNotifyContext());
          }
        } else if (textBlocks) {
          session.setActivity({ label: "Thinking..." });
        }

        if (!parentToolUseId && (textBlocks || toolUseBlocks.length > 0)) {
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

        // Subagent tool_result — attach to the parent message's
        // `subagentEvents` instead of `toolResults` so it shows up under the
        // SubagentCall's "work" timeline (109 — subagent transparency).
        const parentToolUseId = (event as { parentToolUseId?: string }).parentToolUseId;
        if (parentToolUseId && results.length > 0) {
          session.setMessages((prev) => attachSubagentToolResult(prev, parentToolUseId, results));
        } else if (results.length > 0) {
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
        notify("The agent has finished responding.", buildNotifyContext());
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

    if (data.type === "git_push_rejected") {
      git.setPushRejected(true);
    }

    if (data.type === "rebase_started") {
      git.setRebaseStatus("in_progress");
    }

    if (data.type === "rebase_conflicts") {
      git.setRebaseStatus("conflicts");
      git.setRebaseConflicts(data.conflicts);
    }

    if (data.type === "rebase_complete") {
      git.setRebaseStatus("idle");
      git.setRebaseConflicts([]);
      git.setPushRejected(false);
    }

    if (data.type === "rebase_aborted") {
      git.setRebaseStatus("idle");
      git.setRebaseConflicts([]);
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
      // contextTokens reflects the *last turn's* input tokens (= the current
      // context size in the model's prompt window), not the cumulative sum.
      // Falling back to cumulativeInputTokens preserves prior behavior on
      // sessions that don't yet emit per-turn input data.
      if (update.lastTurnInputTokens !== undefined) {
        ui.setContextTokens(update.lastTurnInputTokens);
      } else if (update.cumulativeInputTokens !== undefined) {
        ui.setContextTokens(update.cumulativeInputTokens);
      }
      ui.setCumulativeTokens(
        update.cumulativeInputTokens ?? 0,
        update.cumulativeOutputTokens ?? 0,
      );
    }

    if (data.type === "turn_usage_update") {
      // Append to the per-session turn-usage history powering the context dial.
      session.appendTurnUsage(data.sessionId, data.turn);
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
        localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
        localStorage.removeItem(AGENT_PREFERENCE_KEY);
        localStorage.removeItem("vibe-panel-split");
      } catch { /* localStorage may be unavailable */ }
      window.location.reload();
      return;
    }

    if (data.type === "agent_interrupted") {
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

    if (data.type === "install_status") {
      const stepStatus = data.status === "complete" || data.status === "skipped"
        ? "complete" as const
        : data.status === "error"
          ? "error" as const
          : "running" as const;
      preview.setStartupStep({
        stepId: "install",
        status: stepStatus,
        message: data.message,
      });
    }

    if (data.type === "install_log") {
      terminal.addEntry({
        source: "install" as "preview",
        text: data.text,
        timestamp: new Date().toISOString(),
      });
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

    if (data.type === "secrets_status") {
      preview.setSecrets({
        declared: data.declared,
        missingByService: data.missingByService,
        missingRequired: data.missingRequired,
      });
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

    if (data.type === "ai_review_progress") {
      useFileReviewStore.getState().setAiProgress(data.sessionId, data.reviewId, data.text);
    }

    if (data.type === "ai_review_complete") {
      useFileReviewStore.getState().clearAiProgressForReview(data.sessionId, data.reviewId);
    }

    // session_agent_started/finished, repo_status, repo_warm_ready, repo_list
    // are now delivered via SSE (useServerEvents hook)
}

// ---------------------------------------------------------------------------
// Subagent event helpers (109 — subagent transparency)
// ---------------------------------------------------------------------------

/**
 * Append a subagent assistant event (text + tool calls) to the
 * `subagentEvents` of whichever message in `messages` contains the parent
 * Task tool. Falls back to no-op if the parent isn't found (e.g. the parent
 * was evicted from history). Returns a new messages array.
 */
function attachSubagentAssistant(
  messages: ChatMessage[],
  parentToolUseId: string,
  text: string,
  toolUse: { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }[],
): ChatMessage[] {
  const idx = findMessageIndexWithTool(messages, parentToolUseId);
  if (idx === -1) return messages;
  const parent = messages[idx];
  const next = [...messages];
  next[idx] = {
    ...parent,
    subagentEvents: [
      ...(parent.subagentEvents ?? []),
      { kind: "assistant", parentToolUseId, text, toolUse },
    ],
  };
  return next;
}

/**
 * Append a subagent tool_result event to the `subagentEvents` of whichever
 * message in `messages` contains the parent Task tool.
 */
function attachSubagentToolResult(
  messages: ChatMessage[],
  parentToolUseId: string,
  toolResults: ToolResultBlock[],
): ChatMessage[] {
  const idx = findMessageIndexWithTool(messages, parentToolUseId);
  if (idx === -1) return messages;
  const parent = messages[idx];
  const next = [...messages];
  next[idx] = {
    ...parent,
    subagentEvents: [
      ...(parent.subagentEvents ?? []),
      { kind: "tool_result", parentToolUseId, toolResults },
    ],
  };
  return next;
}

/**
 * Find the index of the message whose `toolUse` (or any subagent's nested
 * tool_use) contains the given id. Searches newest-first since subagent
 * events typically reference recent activity. Returns -1 if not found.
 */
function findMessageIndexWithTool(messages: ChatMessage[], toolUseId: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.toolUse?.some((t) => t.id === toolUseId)) return i;
    for (const ev of m.subagentEvents ?? []) {
      if (ev.kind === "assistant" && ev.toolUse.some((t) => t.id === toolUseId)) return i;
    }
  }
  return -1;
}
