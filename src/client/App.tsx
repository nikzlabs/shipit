import { useState, useEffect, useRef, useCallback } from "react";
import { useWebSocket } from "./hooks/useWebSocket.js";
import { useResizablePanel } from "./hooks/useResizablePanel.js";
import { useSearch } from "./hooks/useSearch.js";
import { useIsMobile } from "./hooks/useMediaQuery.js";
import { useNotification } from "./hooks/useNotification.js";
import { useTheme } from "./hooks/useTheme.js";
import { MessageInput } from "./components/MessageInput.js";
import { MessageList, type ChatMessage, type ToolResultBlock, type CheckpointMarker } from "./components/MessageList.js";
import { PreviewFrame, formatErrorForMessage, type PreviewStatus } from "./components/PreviewFrame.js";
import { usePreviewErrors, type PreviewError } from "./hooks/usePreviewErrors.js";
import { GitHistory, type GitCommit } from "./components/GitHistory.js";
import { AuthOverlay } from "./components/AuthOverlay.js";
import { GitHubAuthOverlay } from "./components/GitHubAuthOverlay.js";
import { GitHubCreateRepoOverlay } from "./components/GitHubCreateRepoOverlay.js";
import { SessionSelector, type SessionInfo } from "./components/SessionSelector.js";
import { DocsViewer } from "./components/DocsViewer.js";
import { FileTree, type FileTreeNode } from "./components/FileTree.js";
import { FileContentViewer } from "./components/FileContentViewer.js";
import { TerminalPanel, type LogEntry } from "./components/TerminalPanel.js";
import { ResizeHandle } from "./components/ResizeHandle.js";
import { SearchBar } from "./components/SearchBar.js";
import { activityFromTool, type StreamingActivity } from "./components/StreamingIndicator.js";
import { ConnectionBanner } from "./components/ConnectionBanner.js";
import { MobileTabBar, type MobilePanel } from "./components/MobileTabBar.js";
import { KeyboardShortcutsOverlay } from "./components/KeyboardShortcutsOverlay.js";
import { TemplateSelector, type TemplateInfo } from "./components/TemplateSelector.js";
import { UsageModal, type SessionUsage, type UsageStats } from "./components/UsageModal.js";
import { SystemPromptEditor } from "./components/SystemPromptEditor.js";
import { GitIdentityOverlay } from "./components/GitIdentityOverlay.js";
import { BranchIndicator } from "./components/BranchIndicator.js";
import type { WsServerMessage, WsSessionRenamed, ClaudeContentBlock, ClaudeContentBlockText, ClaudeContentBlockToolUse, WsChatHistoryMessage, ConversationBranch } from "../server/types.js";

type RightTab = "preview" | "docs" | "files" | "terminal";

const SESSION_STORAGE_KEY = "vibe-current-session";

function getWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = import.meta.env.VITE_API_HOST || window.location.host;
  return `${proto}//${host}/ws`;
}

function getSavedSessionId(): string | undefined {
  try {
    return localStorage.getItem(SESSION_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveSessionId(id: string | undefined): void {
  try {
    if (id) {
      localStorage.setItem(SESSION_STORAGE_KEY, id);
    } else {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch {
    // localStorage may be unavailable
  }
}

export default function App() {
  const { send, lastMessage, status, reconnectAttempt, reconnect } = useWebSocket(getWsUrl());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewStatus | null>(null);
  const [selectedPort, setSelectedPort] = useState<number | null>(null);
  const detectedPorts = preview?.detectedPorts ?? [];
  const [gitCommits, setGitCommits] = useState<GitCommit[]>([]);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [rightTab, setRightTab] = useState<RightTab>("preview");
  const [docFiles, setDocFiles] = useState<string[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);
  const [docContent, setDocContent] = useState<string | null>(null);
  const [fileTree, setFileTree] = useState<FileTreeNode[]>([]);
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [viewingFileContent, setViewingFileContent] = useState<string | null>(null);
  const [viewingFileBinary, setViewingFileBinary] = useState(false);
  const [activity, setActivity] = useState<StreamingActivity | undefined>(undefined);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [unreadLogCount, setUnreadLogCount] = useState(0);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [applyingTemplate, setApplyingTemplate] = useState(false);
  const [showTemplates, setShowTemplates] = useState(!getSavedSessionId());
  const [githubStatus, setGithubStatus] = useState<{ authenticated: boolean; username?: string; avatarUrl?: string }>({ authenticated: false });
  const [showGitHubAuth, setShowGitHubAuth] = useState(false);
  const [showCreateRepo, setShowCreateRepo] = useState(false);
  const [currentSessionUsage, setCurrentSessionUsage] = useState<SessionUsage | null>(null);
  const [allUsageStats, setAllUsageStats] = useState<UsageStats | null>(null);
  const [showUsageModal, setShowUsageModal] = useState(false);
  const [fileChangeCount, setFileChangeCount] = useState(0);
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const [hasSystemPrompt, setHasSystemPrompt] = useState(false);
  const [systemPromptContent, setSystemPromptContent] = useState("");
  const [gitIdentityNeeded, setGitIdentityNeeded] = useState(false);
  const [branches, setBranches] = useState<ConversationBranch[]>([]);
  const [activeBranchId, setActiveBranchId] = useState<string | undefined>(undefined);
  const sessionIdRef = useRef<string | undefined>(getSavedSessionId());
  // Track whether we've already requested history for the current connection
  const historyLoadedRef = useRef(false);

  const { fraction, isDragging, onMouseDown, onTouchStart, containerRef } = useResizablePanel({
    initialFraction: 0.5,
    minFraction: 0.25,
    storageKey: "vibe-panel-split",
  });

  const isMobile = useIsMobile();
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("chat");

  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const search = useSearch(messages);

  const { notify, requestPermission } = useNotification();
  const { theme, toggle: toggleTheme } = useTheme();
  const { errors: previewErrors, clearErrors: clearPreviewErrors, hasErrors: hasPreviewErrors, errorCount: previewErrorCount } = usePreviewErrors();
  const [autoFixEnabled, setAutoFixEnabled] = useState(false);
  const autoFixRetriesRef = useRef(0);
  const [autoFixRetries, setAutoFixRetries] = useState(0);
  const autoFixCooldownRef = useRef(false);
  const autoFixErrorSignatureRef = useRef<string | null>(null);

  // Ctrl+F / Cmd+F to toggle search bar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setSearchOpen((prev) => {
          if (prev) {
            search.clear();
            return false;
          }
          return true;
        });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [search]);

  // ? to toggle keyboard shortcuts overlay (only when not typing in an input)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        setShortcutsOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // On WebSocket connect, restore chat history for the saved session + check GitHub status
  useEffect(() => {
    if (status === "open" && !historyLoadedRef.current && sessionIdRef.current) {
      historyLoadedRef.current = true;
      send({ type: "get_chat_history", sessionId: sessionIdRef.current });
    }
    if (status === "open") {
      send({ type: "github_get_status" });
      send({ type: "list_branches" });
    }
    if (status === "closed") {
      historyLoadedRef.current = false;
    }
  }, [status, send]);

  // Request templates when connected and the template picker is shown
  useEffect(() => {
    if (status === "open" && showTemplates && templates.length === 0) {
      send({ type: "list_templates" });
    }
  }, [status, showTemplates, templates.length, send]);

  // Handle WebSocket disconnection during streaming —
  // if the connection drops while Claude is responding, clean up the
  // loading state and show an error message so the user isn't stuck.
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
            text: "Error: Connection lost while Claude was responding. Your message may be incomplete.",
            streaming: false,
            isError: true,
          },
        ];
      });
    }
  }, [status, isLoading]);

  // Process incoming WebSocket messages
  useEffect(() => {
    if (!lastMessage) return;

    let data: WsServerMessage;
    try {
      data = JSON.parse(lastMessage.data) as WsServerMessage;
    } catch {
      return;
    }

    if (data.type === "preview_status") {
      setPreview({
        running: data.running,
        port: data.port,
        url: data.url,
        source: data.source,
        detectedPorts: data.detectedPorts,
      });
      // Reset user selection if the selected port is no longer available
      setSelectedPort((prev) => {
        if (prev === null) return null;
        const allAvailable = [...(data.detectedPorts ?? [])];
        if (data.source === "vite") allAvailable.push(data.port);
        return allAvailable.includes(prev) ? prev : null;
      });
    }

    if (data.type === "claude_event") {
      const event = data.event;

      // Note: session ID is tracked via "session_started" messages from the server
      // (which use the app-generated UUID), not from the Claude CLI session_id.

      if (event.type === "assistant") {
        const textBlocks = (event.message?.content ?? [])
          .filter((b: ClaudeContentBlock): b is ClaudeContentBlockText => b.type === "text")
          .map((b) => b.text)
          .join("");

        const toolUseBlocks = (event.message?.content ?? [])
          .filter((b: ClaudeContentBlock): b is ClaudeContentBlockToolUse => b.type === "tool_use");

        // Update activity based on what's in this event
        if (toolUseBlocks.length > 0) {
          const lastTool = toolUseBlocks[toolUseBlocks.length - 1];
          setActivity(activityFromTool(lastTool.name, lastTool.input));
        } else if (textBlocks) {
          setActivity({ label: "Thinking..." });
        }

        if (textBlocks || toolUseBlocks.length > 0) {
          setMessages((prev) => {
            // If the last message is from the assistant and we're still loading,
            // replace it (streaming update)
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant" && last.streaming) {
              return [
                ...prev.slice(0, -1),
                {
                  role: "assistant" as const,
                  text: textBlocks,
                  toolUse: toolUseBlocks,
                  streaming: true,
                },
              ];
            }
            return [
              ...prev,
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

      // Track tool result events — Claude is processing results
      if (event.type === "user") {
        setActivity({ label: "Processing results..." });

        // Extract tool results from the user event and attach to the last assistant message
        const results: ToolResultBlock[] = [];
        for (const block of (event.message?.content ?? []) as Record<string, unknown>[]) {
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
            // Truncate extremely large outputs (>1MB) to prevent memory issues
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
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant") {
              // Merge new results with any existing results
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

      if (event.type === "result") {
        setIsLoading(false);
        setActivity(undefined);
        notify("Claude has finished responding.");
        // Mark the last assistant message as no longer streaming
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant") {
            return [...prev.slice(0, -1), { ...last, streaming: false }];
          }
          return prev;
        });
      }
    }

    if (data.type === "error") {
      setIsLoading(false);
      setActivity(undefined);
      setApplyingTemplate(false);
      // Mark any in-flight streaming message as done, then append the error
      setMessages((prev) => {
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
      setGitCommits(data.commits);
    }

    if (data.type === "git_committed") {
      // Prepend the new commit to the list
      setGitCommits((prev) => [
        { hash: data.hash, message: data.message, date: new Date().toISOString(), author: "ShipIt" },
        ...prev,
      ]);
      // Refresh file tree if the Files tab is active (files likely changed)
      if (rightTab === "files") {
        send({ type: "get_file_tree" });
        // Re-fetch the viewed file's content so it stays up to date
        if (viewingFile) {
          send({ type: "get_file_content", path: viewingFile });
        }
      }
    }

    if (data.type === "rollback_complete") {
      // Refresh the git log after rollback
      send({ type: "get_git_log" });
    }

    if (data.type === "auth_required") {
      setAuthUrl(data.url);
    }

    if (data.type === "auth_complete") {
      setAuthUrl(null);
    }

    if (data.type === "git_identity_required") {
      setGitIdentityNeeded(true);
    }

    if (data.type === "git_identity_set") {
      setGitIdentityNeeded(false);
    }

    if (data.type === "session_list") {
      setSessions(data.sessions);
    }

    if (data.type === "session_started") {
      sessionIdRef.current = data.session.id;
      saveSessionId(data.session.id);
      setSessions((prev) => {
        const exists = prev.some((s) => s.id === data.session.id);
        if (exists) {
          return prev.map((s) => (s.id === data.session.id ? data.session : s));
        }
        return [data.session, ...prev];
      });
    }

    if (data.type === "session_renamed") {
      const renamed = (data as WsSessionRenamed).session;
      setSessions((prev) =>
        prev.map((s) => (s.id === renamed.id ? renamed : s))
      );
    }


    if (data.type === "branch_list") {
      setBranches(data.branches);
      setActiveBranchId(data.activeBranchId);
    }

    if (data.type === "branch_switched") {
      const loaded: ChatMessage[] = data.messages.map((m: WsChatHistoryMessage) => ({
        role: m.role,
        text: m.text,
        toolUse: m.toolUse,
        images: m.images,
        isError: m.isError,
        streaming: false,
      }));
      setMessages(loaded);
      setIsLoading(false);
    }

    if (data.type === "doc_list") {
      setDocFiles(data.files);
    }

    if (data.type === "doc_content") {
      setDocContent(data.content);
    }

    if (data.type === "file_tree") {
      setFileTree(data.tree);
    }

    if (data.type === "file_content") {
      setViewingFileContent(data.content);
      setViewingFileBinary(data.isBinary ?? false);
    }

    if (data.type === "files_changed") {
      const paths: string[] = data.paths;

      // Auto-refresh file tree if the Files tab is active
      if (rightTab === "files") {
        send({ type: "get_file_tree" });
      }

      // Auto-refresh the viewed file if it was modified
      if (viewingFile && paths.some((p) => viewingFile.endsWith(p))) {
        send({ type: "get_file_content", path: viewingFile });
      }

      // Show a badge on the Files tab when changes occur while not viewing it
      if (rightTab !== "files") {
        setFileChangeCount((prev) => prev + paths.length);
      }
    }

    if (data.type === "chat_history") {
      // Replace messages with the persisted history (loaded messages are never streaming)
      const loaded: ChatMessage[] = data.messages.map((m: WsChatHistoryMessage) => ({
        role: m.role,
        text: m.text,
        toolUse: m.toolUse,
        images: m.images,
        isError: m.isError,
        streaming: false,
      }));
      setMessages(loaded);
    }

    if (data.type === "template_list") {
      setTemplates(data.templates as TemplateInfo[]);
    }

    if (data.type === "template_applied") {
      setApplyingTemplate(false);
      setShowTemplates(false);
      // Refresh file tree in case user is on that tab
      send({ type: "get_file_tree" });
    }

    if (data.type === "github_status") {
      setGithubStatus({
        authenticated: data.authenticated,
        username: data.username,
        avatarUrl: data.avatarUrl,
      });
      setShowGitHubAuth(false);
    }

    if (data.type === "github_push_result" || data.type === "github_pull_result") {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant" as const,
          text: data.message,
          streaming: false,
          isError: !data.success,
        },
      ]);
    }

    if (data.type === "github_repo_created") {
      const msg = data.success
        ? `Repository created: ${data.fullName}\n${data.url}`
        : `Failed to create repository: ${data.message}`;
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant" as const,
          text: msg,
          streaming: false,
          isError: !data.success,
        },
      ]);
    }

    if (data.type === "usage_update") {
      setCurrentSessionUsage({
        sessionId: data.sessionId,
        totalCostUsd: data.totalCostUsd,
        totalDurationMs: data.totalDurationMs,
        turnCount: data.turnCount,
      });
    }

    if (data.type === "usage_stats") {
      setAllUsageStats(data.stats);
    }

    if (data.type === "system_prompt") {
      setSystemPromptContent(data.content);
      setHasSystemPrompt(data.content.length > 0);
    }

    if (data.type === "system_prompt_saved") {
      setSystemPromptContent(data.content);
      setHasSystemPrompt(data.content.length > 0);
      setSystemPromptOpen(false);
    }

    if (data.type === "log_entry") {
      setLogEntries((prev) => {
        const next = [...prev, { source: data.source, text: data.text, timestamp: data.timestamp }];
        // Cap at 500 entries on the client to avoid memory growth
        return next.length > 500 ? next.slice(-500) : next;
      });
      // Increment unread count when terminal tab is not active
      if (rightTab !== "terminal") {
        setUnreadLogCount((prev) => prev + 1);
      }
    }
  }, [lastMessage, send, rightTab, viewingFile, notify]);

  // Forward preview errors to the server for terminal log relay
  useEffect(() => {
    if (previewErrors.length === 0 || status !== "open") return;
    // Send the latest error to the server
    const latest = previewErrors[previewErrors.length - 1];
    send({
      type: "preview_error",
      message: latest.message,
      stack: latest.stack,
      source: latest.source,
      line: latest.line,
    });
  }, [previewErrors.length, status, send, previewErrors]);

  const handleSendAutoFix = useCallback(
    (text: string) => {
      setMessages((prev) => [...prev, { role: "user", text }]);
      setIsLoading(true);
      setActivity({ label: "Auto-fixing errors..." });
      send({
        type: "send_message",
        text,
        sessionId: sessionIdRef.current,
      });
    },
    [send],
  );

  // Auto-fix: when new errors arrive while auto-fix is enabled and Claude is idle,
  // automatically send errors to Claude for fixing (with safety guardrails).
  const prevErrorCountRef = useRef(0);
  useEffect(() => {
    if (!autoFixEnabled || isLoading || previewErrors.length === 0) {
      prevErrorCountRef.current = previewErrors.length;
      return;
    }
    // Only trigger on new errors (count increased)
    if (previewErrors.length <= prevErrorCountRef.current) {
      return;
    }
    prevErrorCountRef.current = previewErrors.length;

    // Check retry limit
    if (autoFixRetriesRef.current >= 3) {
      setAutoFixEnabled(false);
      autoFixRetriesRef.current = 0;
      setAutoFixRetries(0);
      return;
    }

    // Check cooldown
    if (autoFixCooldownRef.current) return;

    // Build the error signature to detect same-error loops
    const sig = previewErrors.map((e) => e.message).join("|");
    if (sig === autoFixErrorSignatureRef.current) {
      autoFixRetriesRef.current += 1;
      setAutoFixRetries(autoFixRetriesRef.current);
    } else {
      autoFixRetriesRef.current = 1;
      setAutoFixRetries(1);
      autoFixErrorSignatureRef.current = sig;
    }

    // Apply 5s cooldown
    autoFixCooldownRef.current = true;
    const timer = setTimeout(() => {
      autoFixCooldownRef.current = false;
    }, 5000);

    // Send errors to Claude
    const text = formatErrorForMessage(previewErrors);
    handleSendAutoFix(text);

    return () => clearTimeout(timer);
  }, [previewErrors.length, autoFixEnabled, isLoading, previewErrors, handleSendAutoFix]);

  const handleSendErrors = useCallback(
    (errors: PreviewError[]) => {
      const text = formatErrorForMessage(errors);
      requestPermission();
      setShowTemplates(false);
      setMessages((prev) => [...prev, { role: "user", text }]);
      setIsLoading(true);
      setActivity({ label: "Thinking..." });
      send({
        type: "send_message",
        text,
        sessionId: sessionIdRef.current,
      });
    },
    [send, requestPermission],
  );

  const handleToggleAutoFix = useCallback(() => {
    setAutoFixEnabled((prev) => {
      if (!prev) {
        // Enabling auto-fix: reset retry counter
        autoFixRetriesRef.current = 0;
        setAutoFixRetries(0);
        autoFixErrorSignatureRef.current = null;
        autoFixCooldownRef.current = false;
      }
      return !prev;
    });
  }, []);

  const handleSend = useCallback(
    (text: string, images?: Array<{ data: string; mediaType: string; filename: string }>) => {
      requestPermission();
      setShowTemplates(false);
      // Kill switch: any user message cancels auto-fix mode
      setAutoFixEnabled(false);
      autoFixRetriesRef.current = 0;
      setAutoFixRetries(0);
      const messageImages = images?.map((img) => ({
        data: img.data,
        mediaType: img.mediaType,
      }));
      setMessages((prev) => [...prev, { role: "user", text, images: messageImages }]);
      setIsLoading(true);
      setActivity({ label: "Thinking..." });
      send({
        type: "send_message",
        text,
        sessionId: sessionIdRef.current,
        images,
      });
    },
    [send, requestPermission]
  );

  const handleEditMessage = useCallback(
    (messageIndex: number, newText: string) => {
      requestPermission();
      send({ type: "create_checkpoint", label: `before edit/retry #${messageIndex + 1}`, messageIndex });
      // Truncate messages from the edited index onward, then append the new user message
      setMessages((prev) => [
        ...prev.slice(0, messageIndex),
        { role: "user" as const, text: newText },
      ]);
      setIsLoading(true);
      setActivity({ label: "Thinking..." });
      send({
        type: "send_message",
        text: newText,
        sessionId: sessionIdRef.current,
      });
    },
    [send, requestPermission]
  );


  const handleCreateCheckpoint = useCallback((label?: string, messageIndex?: number) => {
    send({ type: "create_checkpoint", label, messageIndex });
  }, [send]);

  const handleSwitchBranch = useCallback((branchId: string) => {
    send({ type: "switch_branch", branchId });
  }, [send]);

  const handleBranchFromCheckpoint = useCallback((checkpointId: string) => {
    send({ type: "branch_from_checkpoint", checkpointId });
  }, [send]);

  const handleGitRefresh = useCallback(() => {
    send({ type: "get_git_log" });
  }, [send]);

  const handleRollback = useCallback(
    (hash: string) => {
      send({ type: "rollback", commitHash: hash });
    },
    [send]
  );

  const handleSessionRefresh = useCallback(() => {
    send({ type: "list_sessions" });
  }, [send]);

  const handleSessionResume = useCallback(
    (sessionId: string) => {
      sessionIdRef.current = sessionId;
      saveSessionId(sessionId);
      setMessages([]);
      setIsLoading(false);
      setShowTemplates(false);
      // Reset session-specific UI state (each session has its own workspace)
      setViewingFile(null);
      setViewingFileContent(null);
      setViewingFileBinary(false);
      setGitCommits([]);
      setFileTree([]);
      setCurrentSessionUsage(null);
      // Load persisted chat history for this session (also activates session on server)
      send({ type: "get_chat_history", sessionId });
      // Refresh file tree and git log for the new session's workspace
      send({ type: "get_file_tree" });
      send({ type: "get_git_log" });
      send({ type: "list_branches" });
    },
    [send]
  );

  const handleSessionNew = useCallback(() => {
    sessionIdRef.current = undefined;
    saveSessionId(undefined);
    setMessages([]);
    setIsLoading(false);
    setCurrentSessionUsage(null);
    setShowTemplates(true);
    // Reset session-specific UI state
    setViewingFile(null);
    setViewingFileContent(null);
    setViewingFileBinary(false);
    setGitCommits([]);
    setFileTree([]);
    send({ type: "new_session" });
    // Request templates for the picker
    if (templates.length === 0) {
      send({ type: "list_templates" });
    }
  }, [send, templates.length]);

  const handleTemplateSelect = useCallback(
    (templateId: string) => {
      setApplyingTemplate(true);
      send({ type: "apply_template", templateId });
    },
    [send],
  );

  const handleTemplateDismiss = useCallback(() => {
    setShowTemplates(false);
  }, []);

  const handleSessionDelete = useCallback(
    (sessionId: string) => {
      send({ type: "delete_session", sessionId });
    },
    [send]
  );

  const handleSessionRename = useCallback(
    (sessionId: string, title: string) => {
      send({ type: "rename_session", sessionId, title });
    },
    [send]
  );

  const handleDocRefresh = useCallback(() => {
    send({ type: "list_docs" });
  }, [send]);

  const handleSelectPort = useCallback((port: number) => {
    setSelectedPort(port);
  }, []);

  const handleFileTreeRefresh = useCallback(() => {
    send({ type: "get_file_tree" });
  }, [send]);

  const handleFileClick = useCallback(
    (filePath: string) => {
      setViewingFile(filePath);
      setViewingFileContent(null);
      setViewingFileBinary(false);
      send({ type: "get_file_content", path: filePath });
    },
    [send]
  );

  const handleFileViewerClose = useCallback(() => {
    setViewingFile(null);
    setViewingFileContent(null);
    setViewingFileBinary(false);
  }, []);

  const handleDocSelect = useCallback(
    (filePath: string) => {
      setSelectedDoc(filePath);
      setDocContent(null);
      send({ type: "get_doc", path: filePath });
    },
    [send]
  );

  const handleAnswerQuestion = useCallback(
    (toolUseId: string, answers: Record<string, string>) => {
      // Format the answer as readable text for the chat history
      const answerParts = Object.values(answers);
      const answerText = answerParts.join(", ");
      send({
        type: "answer_question",
        toolUseId,
        answers,
      });
      // Show the user's answer as a message in the chat
      setMessages((prev) => [...prev, { role: "user", text: answerText }]);
      setIsLoading(true);
      setActivity({ label: "Thinking..." });
    },
    [send]
  );

  const handleGitIdentitySubmit = useCallback(
    (name: string, email: string) => {
      send({ type: "set_git_identity", name, email });
    },
    [send],
  );

  const handleGitHubTokenSubmit = useCallback(
    (token: string) => {
      send({ type: "github_set_token", token });
    },
    [send],
  );

  const handleGitHubLogout = useCallback(() => {
    send({ type: "github_logout" });
  }, [send]);

  const handleCreateRepo = useCallback(
    (name: string, description: string, isPrivate: boolean) => {
      send({ type: "github_create_repo", name, description, isPrivate });
      setShowCreateRepo(false);
    },
    [send],
  );

  const handleUsageBadgeClick = useCallback(() => {
    send({ type: "get_usage_stats" });
    setShowUsageModal(true);
  }, [send]);

  const handleSystemPromptOpen = useCallback(() => {
    send({ type: "get_system_prompt" });
    setSystemPromptOpen(true);
  }, [send]);

  const handleSystemPromptSave = useCallback(
    (content: string) => {
      send({ type: "set_system_prompt", content });
    },
    [send],
  );

  const handleClearLogs = useCallback(() => {
    setLogEntries([]);
    send({ type: "clear_logs" });
  }, [send]);

  // Request data when switching to docs or files tab
  const handleTabChange = useCallback(
    (tab: RightTab) => {
      setRightTab(tab);
      if (tab === "docs" && docFiles.length === 0) {
        send({ type: "list_docs" });
      }
      if (tab === "files") {
        send({ type: "get_file_tree" });
        setFileChangeCount(0);
      }
      if (tab === "terminal") {
        setUnreadLogCount(0);
      }
    },
    [send, docFiles.length]
  );

  // Shared right-panel content (Preview / Docs / Files with tab bar)
  const rightPanel = (
    <>
      {/* Tab bar */}
      <div className="flex border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
        <button
          onClick={() => handleTabChange("preview")}
          className={`px-4 py-2 text-sm font-medium transition-colors relative ${
            rightTab === "preview"
              ? "text-gray-900 dark:text-gray-100 border-b-2 border-blue-500"
              : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Preview
          {hasPreviewErrors && rightTab !== "preview" && (
            <span className="ml-1.5 inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 text-[10px] font-semibold rounded-full bg-red-600 text-white">
              {previewErrorCount > 99 ? "99+" : previewErrorCount}
            </span>
          )}
        </button>
        <button
          onClick={() => handleTabChange("docs")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            rightTab === "docs"
              ? "text-gray-900 dark:text-gray-100 border-b-2 border-blue-500"
              : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Docs
        </button>
        <button
          onClick={() => handleTabChange("files")}
          className={`px-4 py-2 text-sm font-medium transition-colors relative ${
            rightTab === "files"
              ? "text-gray-900 dark:text-gray-100 border-b-2 border-blue-500"
              : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Files
          {fileChangeCount > 0 && rightTab !== "files" && (
            <span className="ml-1.5 inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 text-[10px] font-semibold rounded-full bg-blue-600 text-white">
              {fileChangeCount > 99 ? "99+" : fileChangeCount}
            </span>
          )}
        </button>
        <button
          onClick={() => handleTabChange("terminal")}
          className={`px-4 py-2 text-sm font-medium transition-colors relative ${
            rightTab === "terminal"
              ? "text-gray-900 dark:text-gray-100 border-b-2 border-blue-500"
              : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Terminal
          {unreadLogCount > 0 && rightTab !== "terminal" && (
            <span className="ml-1.5 inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 text-[10px] font-semibold rounded-full bg-blue-600 text-white">
              {unreadLogCount > 99 ? "99+" : unreadLogCount}
            </span>
          )}
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0">
        {rightTab === "preview" ? (
          <PreviewFrame
            preview={preview}
            detectedPorts={detectedPorts}
            selectedPort={selectedPort}
            onSelectPort={handleSelectPort}
            errors={previewErrors}
            onSendErrors={handleSendErrors}
            onClearErrors={clearPreviewErrors}
            autoFixEnabled={autoFixEnabled}
            onToggleAutoFix={handleToggleAutoFix}
            autoFixRetries={autoFixRetries}
          />
        ) : rightTab === "docs" ? (
          <DocsViewer
            files={docFiles}
            selectedFile={selectedDoc}
            content={docContent}
            onSelectFile={handleDocSelect}
            onRefresh={handleDocRefresh}
          />
        ) : rightTab === "terminal" ? (
          <TerminalPanel
            entries={logEntries}
            onClear={handleClearLogs}
          />
        ) : viewingFile ? (
          <FileContentViewer
            filePath={viewingFile}
            content={viewingFileContent}
            isBinary={viewingFileBinary}
            onClose={handleFileViewerClose}
          />
        ) : (
          <FileTree
            tree={fileTree}
            onRefresh={handleFileTreeRefresh}
            onFileClick={handleFileClick}
            selectedFile={viewingFile}
          />
        )}
      </div>
    </>
  );

  const checkpointMarkers: CheckpointMarker[] = branches
    .find((branch) => branch.id === activeBranchId)?.checkpoints
    .map((checkpoint) => ({ id: checkpoint.id, messageIndex: checkpoint.messageIndex, label: checkpoint.label })) ?? [];

  // Show template picker for new sessions with no messages
  const showTemplatePicker = showTemplates && messages.length === 0 && !isLoading;

  // Shared chat panel content
  const chatPanel = (
    <>
      {searchOpen && (
        <SearchBar
          query={search.query}
          onQueryChange={search.setQuery}
          matches={search.matches}
          currentMatchIndex={search.currentMatchIndex}
          onNext={search.goToNext}
          onPrev={search.goToPrev}
          onClose={() => {
            setSearchOpen(false);
            search.clear();
          }}
        />
      )}
      {showTemplatePicker ? (
        <TemplateSelector
          templates={templates}
          onSelect={handleTemplateSelect}
          onDismiss={handleTemplateDismiss}
          applying={applyingTemplate}
        />
      ) : (
        <MessageList
          messages={messages}
          isLoading={isLoading}
          activity={activity}
          searchMatches={search.matches}
          currentMatch={search.currentMatch}
          onEditMessage={handleEditMessage}
          onAnswerQuestion={handleAnswerQuestion}
          checkpoints={checkpointMarkers}
        />
      )}
      {!showTemplatePicker && (
        <GitHistory
          commits={gitCommits}
          onRollback={handleRollback}
          onRefresh={handleGitRefresh}
          branches={branches}
          activeBranchId={activeBranchId}
          onBranchFromCheckpoint={handleBranchFromCheckpoint}
        />
      )}
      {!showTemplatePicker && (
        <MessageInput onSend={handleSend} disabled={isLoading || status !== "open"} activity={isLoading ? activity : undefined} />
      )}
    </>
  );

  return (
    <div className="flex flex-col h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {authUrl && <AuthOverlay url={authUrl} />}
      {gitIdentityNeeded && (
        <GitIdentityOverlay onSubmit={handleGitIdentitySubmit} />
      )}
      {showGitHubAuth && (
        <GitHubAuthOverlay
          onSubmit={handleGitHubTokenSubmit}
          onClose={() => setShowGitHubAuth(false)}
        />
      )}
      {showCreateRepo && githubStatus.username && (
        <GitHubCreateRepoOverlay
          username={githubStatus.username}
          onSubmit={handleCreateRepo}
          onClose={() => setShowCreateRepo(false)}
        />
      )}
      {shortcutsOpen && <KeyboardShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}
      {systemPromptOpen && (
        <SystemPromptEditor
          initialContent={systemPromptContent}
          onSave={handleSystemPromptSave}
          onClose={() => setSystemPromptOpen(false)}
        />
      )}
      {showUsageModal && (
        <UsageModal
          currentSessionUsage={currentSessionUsage}
          allUsage={allUsageStats}
          sessions={sessions}
          onClose={() => setShowUsageModal(false)}
        />
      )}

      {/* Header */}
      <header className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          <h1 className="text-lg font-semibold tracking-tight shrink-0 flex items-center gap-1.5">
            <img src="./favicon.svg" alt="" className="w-5 h-5" />
            ShipIt
          </h1>
          <SessionSelector
            sessions={sessions}
            currentSessionId={sessionIdRef.current}
            onResume={handleSessionResume}
            onNew={handleSessionNew}
            onDelete={handleSessionDelete}
            onRename={handleSessionRename}
            onRefresh={handleSessionRefresh}
          />
          <BranchIndicator
            branches={branches}
            activeBranchId={activeBranchId}
            onSwitchBranch={handleSwitchBranch}
            onCreateCheckpoint={() => handleCreateCheckpoint("manual checkpoint")}
          />
        </div>
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {githubStatus.authenticated ? (
            <div className="hidden sm:flex items-center gap-1.5">
              <span
                className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                title={`Connected as ${githubStatus.username}`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                {githubStatus.username ?? "GitHub"}
              </span>
              <button
                onClick={() => setShowCreateRepo(true)}
                className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
                title="Create new GitHub repository"
              >
                + Repo
              </button>
              <button
                onClick={handleGitHubLogout}
                className="text-xs px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                title="Disconnect from GitHub"
              >
                &times;
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowGitHubAuth(true)}
              className="hidden sm:inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
              title="Connect to GitHub"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-gray-600" />
              GitHub
            </button>
          )}
          <button
            onClick={handleSystemPromptOpen}
            className={`hidden sm:inline-flex items-center justify-center w-7 h-7 rounded transition-colors ${
              hasSystemPrompt
                ? "text-blue-400 hover:text-blue-300 hover:bg-gray-800"
                : "text-gray-500 hover:text-gray-300 hover:bg-gray-800"
            }`}
            title="Project instructions"
            aria-label="Project instructions"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="w-4 h-4"
            >
              <path
                fillRule="evenodd"
                d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
                clipRule="evenodd"
              />
            </svg>
          </button>
          {currentSessionUsage && currentSessionUsage.totalCostUsd > 0 && (
            <button
              onClick={handleUsageBadgeClick}
              className="hidden sm:inline text-xs px-2 py-0.5 rounded-full bg-purple-900 text-purple-300 hover:bg-purple-800 transition-colors cursor-pointer"
              title="View usage details"
            >
              {currentSessionUsage.totalCostUsd < 0.01
                ? `$${currentSessionUsage.totalCostUsd.toFixed(3)}`
                : `$${currentSessionUsage.totalCostUsd.toFixed(2)}`}
            </button>
          )}
          {preview?.running && (
            <span className={`hidden sm:inline text-xs px-2 py-0.5 rounded-full ${
              preview.source === "detected"
                ? "bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300"
                : "bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300"
            }`}>
              preview :{selectedPort ?? preview.port}
            </span>
          )}
          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            className="p-1.5 rounded-md text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            )}
          </button>
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${
              status === "open"
                ? "bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300"
                : status === "connecting"
                ? "bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300"
                : "bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300"
            }`}
          >
            {status}
          </span>
        </div>
      </header>

      <ConnectionBanner status={status} reconnectAttempt={reconnectAttempt} onReconnect={reconnect} />

      {isMobile ? (
        /* ── Mobile: single panel with bottom tab bar ── */
        <>
          <div className="flex flex-col flex-1 min-h-0">
            {showTemplatePicker || mobilePanel === "chat" ? (
              <div className="flex flex-col flex-1 min-h-0">{chatPanel}</div>
            ) : (
              <div className="flex flex-col flex-1 min-h-0 bg-gray-50 dark:bg-gray-900">{rightPanel}</div>
            )}
          </div>
          {!showTemplatePicker && (
            <MobileTabBar activePanel={mobilePanel} onChangePanel={setMobilePanel} />
          )}
        </>
      ) : (
        /* ── Desktop: side-by-side resizable layout ── */
        <div ref={containerRef} className="flex flex-1 min-h-0">
          {/* Left column — Chat */}
          <div
            className={`flex flex-col min-w-0 ${showTemplatePicker ? "" : "border-r border-gray-200 dark:border-gray-800"}`}
            style={{ width: showTemplatePicker ? "100%" : `${fraction * 100}%` }}
          >
            {chatPanel}
          </div>

          {!showTemplatePicker && (
            <>
              {/* Drag handle */}
              <ResizeHandle isDragging={isDragging} onMouseDown={onMouseDown} onTouchStart={onTouchStart} />

              {/* Right column — Tabbed (Preview / Docs) */}
              <div
                className="min-w-0 flex flex-col bg-gray-50 dark:bg-gray-900"
                style={{ width: `${(1 - fraction) * 100}%` }}
              >
                {rightPanel}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
