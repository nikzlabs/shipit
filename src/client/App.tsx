import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useWebSocket } from "./hooks/useWebSocket.js";
import { useResizablePanel } from "./hooks/useResizablePanel.js";
import { useSearch } from "./hooks/useSearch.js";
import { useIsMobile } from "./hooks/useMediaQuery.js";
import { useNotification } from "./hooks/useNotification.js";
import { useTheme } from "./hooks/useTheme.js";
import { MessageInput } from "./components/MessageInput.js";
import { MessageList, type ChatMessage, type ToolResultBlock, type CheckpointDivider } from "./components/MessageList.js";
import { PreviewFrame, formatErrorForMessage, type PreviewStatus } from "./components/PreviewFrame.js";
import { usePreviewErrors, type PreviewError } from "./hooks/usePreviewErrors.js";
import { GitHistory, type GitCommit } from "./components/GitHistory.js";
import { AuthOverlay } from "./components/AuthOverlay.js";
import { ProjectSettings } from "./components/ProjectSettings.js";
import { SessionSidebar } from "./components/SessionSidebar.js";
import { DocsViewer } from "./components/DocsViewer.js";
import { FileTree, type FileTreeNode } from "./components/FileTree.js";
import { FileContentViewer } from "./components/FileContentViewer.js";
import { TerminalPanel, type LogEntry, type TerminalMode } from "./components/TerminalPanel.js";
import { InteractiveTerminal, type InteractiveTerminalHandle } from "./components/InteractiveTerminal.js";
import { ResizeHandle } from "./components/ResizeHandle.js";
import { SearchBar } from "./components/SearchBar.js";
import { activityFromTool, type StreamingActivity } from "./components/StreamingIndicator.js";
import { ConnectionBanner } from "./components/ConnectionBanner.js";
import { MobileTabBar, type MobilePanel } from "./components/MobileTabBar.js";
import { KeyboardShortcutsOverlay } from "./components/KeyboardShortcutsOverlay.js";
import { type TemplateInfo } from "./components/TemplateSelector.js";
import { HomeScreen } from "./components/HomeScreen.js";
import { UsageModal, type SessionUsage, type UsageStats, type TurnTokenData } from "./components/UsageModal.js";
import { StatusBar, type ModelInfo } from "./components/StatusBar.js";
import { GitIdentityOverlay } from "./components/GitIdentityOverlay.js";
import { ThreadIndicator, type ThreadInfo } from "./components/ThreadIndicator.js";
import { ThreadTimeline } from "./components/ThreadTimeline.js";
import { DeployModal, type DeployPhase } from "./components/DeployModal.js";
import { FeaturesPanel } from "./components/FeaturesPanel.js";
import { PullRequestModal } from "./components/PullRequestModal.js";
import { PrStatusBar } from "./components/PrStatusBar.js";
import { Toast, type ToastData } from "./components/Toast.js";
import { QueueIndicator } from "./components/QueueIndicator.js";
import { AgentPicker, type AgentOption } from "./components/AgentPicker.js";
import type { WsServerMessage, WsSessionRenamed, WsUsageUpdate, WsModelInfo, ClaudeContentBlock, ClaudeContentBlockText, ClaudeContentBlockToolUse, WsChatHistoryMessage, DeployTargetInfo, DeploymentRecord, FeatureInfo, PermissionMode, FileContextRef, SessionInfo, AgentEvent, AgentContentBlock, AgentId, WsMessageQueued, WsQueueUpdated } from "../server/types.js";

type RightTab = "preview" | "docs" | "files" | "terminal" | "features";

const PERMISSION_MODE_KEY = "vibe-permission-mode";
const SIDEBAR_COLLAPSED_KEY = "vibe-sidebar-collapsed";
const AGENT_PREFERENCE_KEY = "vibe-agent-id";

function getWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = import.meta.env.VITE_API_HOST || window.location.host;
  return `${proto}//${host}/ws`;
}


function getSavedPermissionMode(): PermissionMode {
  try {
    const saved = localStorage.getItem(PERMISSION_MODE_KEY);
    if (saved === "plan" || saved === "normal" || saved === "auto") return saved;
  } catch {
    // localStorage may be unavailable
  }
  return "auto";
}

function savePermissionMode(mode: PermissionMode): void {
  try {
    localStorage.setItem(PERMISSION_MODE_KEY, mode);
  } catch {
    // localStorage may be unavailable
  }
}

function getSavedSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  } catch {
    // localStorage may be unavailable
  }
}

function getSavedAgentId(): AgentId {
  try {
    const saved = localStorage.getItem(AGENT_PREFERENCE_KEY);
    if (saved === "claude" || saved === "codex" || saved === "gemini") return saved;
  } catch {
    // localStorage may be unavailable
  }
  return "claude";
}

function saveAgentId(agentId: AgentId): void {
  try {
    localStorage.setItem(AGENT_PREFERENCE_KEY, agentId);
  } catch {
    // localStorage may be unavailable
  }
}

export default function App() {
  const { sessionId: urlSessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
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
  const [terminalMode, setTerminalMode] = useState<TerminalMode>("logs");
  const [shellStarted, setShellStarted] = useState(false);
  const terminalRef = useRef<InteractiveTerminalHandle>(null);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [showTemplates, setShowTemplates] = useState(!urlSessionId);
  const [selectedRepoUrl, setSelectedRepoUrl] = useState<string | null>(null);
  const [creatingRepo, setCreatingRepo] = useState(false);
  const [githubStatus, setGithubStatus] = useState<{ authenticated: boolean; username?: string; avatarUrl?: string }>({ authenticated: false });
  const [currentSessionUsage, setCurrentSessionUsage] = useState<SessionUsage | null>(null);
  const [allUsageStats, setAllUsageStats] = useState<UsageStats | null>(null);
  const [showUsageModal, setShowUsageModal] = useState(false);
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null);
  const [contextTokens, setContextTokens] = useState(0);
  const [turnTokens, setTurnTokens] = useState<TurnTokenData[]>([]);
  const [fileChangeCount, setFileChangeCount] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hasSystemPrompt, setHasSystemPrompt] = useState(false);
  const [systemPromptContent, setSystemPromptContent] = useState("");
  const [gitIdentityNeeded, setGitIdentityNeeded] = useState(false);
  const [threads, setThreads] = useState<ThreadInfo[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string>("");
  const [showDeployModal, setShowDeployModal] = useState(false);
  const [deployTargets, setDeployTargets] = useState<DeployTargetInfo[]>([]);
  const [deployConfigStatus, setDeployConfigStatus] = useState<Record<string, { configured: boolean; projectName?: string }>>({});
  const [deployStatus, setDeployStatus] = useState<DeployPhase | null>(null);
  const [lastDeployUrl, setLastDeployUrl] = useState<string | null>(null);
  const [lastDeployError, setLastDeployError] = useState<string | null>(null);
  const [deployHistory, setDeployHistory] = useState<DeploymentRecord[]>([]);
  const [features, setFeatures] = useState<FeatureInfo[]>([]);
  const [agentList, setAgentList] = useState<AgentOption[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<AgentId>(getSavedAgentId());
  const [showPRModal, setShowPRModal] = useState(false);
  const [prCurrentBranch, setPrCurrentBranch] = useState("");
  const [prRemoteBranches, setPrRemoteBranches] = useState<string[]>([]);
  const [prResult, setPrResult] = useState<{ success: boolean; url?: string; number?: number; message?: string } | null>(null);
  const [prDescGenerating, setPrDescGenerating] = useState(false);
  const prDescGeneratingRef = useRef(false);
  const [prDescError, setPrDescError] = useState<string | null>(null);
  const [prGeneratedDesc, setPrGeneratedDesc] = useState<string | null>(null);
  const [importSearchResults, setImportSearchResults] = useState<Array<{ fullName: string; description: string | null; private: boolean; defaultBranch: string; cloneUrl: string }>>([]);
  const [prStatus, setPrStatus] = useState<{
    url: string;
    number: number;
    title: string;
    baseBranch: string;
    headBranch: string;
    insertions: number;
    deletions: number;
    checks: { state: "pending" | "success" | "failure" | "none"; total: number; passed: number; failed: number; pending: number };
    autoMergeEnabled: boolean;
    mergeable: boolean;
  } | null>(null);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(getSavedPermissionMode());
  const [pendingFiles, setPendingFiles] = useState<FileContextRef[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<Array<{ text: string; position: number }>>([]);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(getSavedSidebarCollapsed());
  const sessionIdRef = useRef<string | undefined>(urlSessionId);
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
  }, [status, send]);

  // Fetch PR status on session load
  useEffect(() => {
    if (status === "open" && sessionIdRef.current) {
      send({ type: "get_pr_status" });
    }
  }, [status, send]);

  // Poll PR status while CI is pending
  useEffect(() => {
    if (prStatus?.checks.state === "pending") {
      const interval = setInterval(() => {
        send({ type: "get_pr_status" });
      }, 30_000);
      return () => clearInterval(interval);
    }
  }, [prStatus?.checks.state, send]);

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
            text: "Error: Connection lost while the agent was responding. Your message may be incomplete.",
            streaming: false,
            isError: true,
          },
        ];
      });
    }
  }, [status, isLoading]);

  // Internal session resume (no navigation) — used by popstate/URL changes
  const resumeSessionInternal = useCallback(
    (sessionId: string) => {
      sessionIdRef.current = sessionId;
      setMessages([]);
      setIsLoading(false);
      setShowTemplates(false);
      setQueuedMessages([]);
      // Reset session-specific UI state (each session has its own workspace)
      setViewingFile(null);
      setViewingFileContent(null);
      setViewingFileBinary(false);
      setGitCommits([]);
      setFileTree([]);
      setCurrentSessionUsage(null);
      setModelInfo(null);
      setContextTokens(0);
      setTurnTokens([]);
      setThreads([]);
      setActiveThreadId("");
      setShellStarted(false);
      setTerminalMode("logs");
      // Load persisted chat history for this session (also activates session on server)
      send({ type: "get_chat_history", sessionId });
      // Refresh file tree and git log for the new session's workspace
      send({ type: "get_file_tree" });
      send({ type: "get_git_log" });
    },
    [send]
  );

  // Public session resume — also navigates to update the URL
  const handleSessionResume = useCallback(
    (sessionId: string) => {
      resumeSessionInternal(sessionId);
      navigate(`/session/${sessionId}`);
    },
    [resumeSessionInternal, navigate]
  );

  // Sync session state when the URL changes (back/forward navigation)
  useEffect(() => {
    if (urlSessionId && urlSessionId !== sessionIdRef.current) {
      resumeSessionInternal(urlSessionId);
    } else if (!urlSessionId && sessionIdRef.current) {
      // Navigated back to "/" — reset to new session state
      sessionIdRef.current = undefined;
      setMessages([]);
      setIsLoading(false);
      setShowTemplates(true);
      setSelectedRepoUrl(null);
      setViewingFile(null);
      setViewingFileContent(null);
      setViewingFileBinary(false);
      setGitCommits([]);
      setFileTree([]);
      setCurrentSessionUsage(null);
      setModelInfo(null);
      setContextTokens(0);
      setTurnTokens([]);
      setThreads([]);
      setActiveThreadId("");
      setShellStarted(false);
      setTerminalMode("logs");
      setQueuedMessages([]);
    }
  }, [urlSessionId, resumeSessionInternal]);

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

    // ---- Normalized agent event handler (multi-agent support) ----
    if (data.type === "agent_event") {
      const event = data.event as AgentEvent;

      if (event.type === "agent_assistant") {
        const textBlocks = (event.content ?? [])
          .filter((b: AgentContentBlock): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");

        const toolUseBlocks = (event.content ?? [])
          .filter((b: AgentContentBlock): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => b.type === "tool_use");

        // Update activity based on what's in this event
        if (toolUseBlocks.length > 0) {
          const lastTool = toolUseBlocks[toolUseBlocks.length - 1];
          setActivity(activityFromTool(lastTool.name, lastTool.input));
        } else if (textBlocks) {
          setActivity({ label: "Thinking..." });
        }

        if (textBlocks || toolUseBlocks.length > 0) {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant" && last.streaming) {
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

      // Track tool result events — agent is processing results
      if (event.type === "agent_tool_result") {
        setActivity({ label: "Processing results..." });

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
          setMessages((prev) => {
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
        setIsLoading(false);
        setActivity(undefined);
        notify("The agent has finished responding.");
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant") {
            return [...prev.slice(0, -1), { ...last, streaming: false }];
          }
          return prev;
        });
      }
    }

    // ---- Legacy claude_event handler (backward compatibility) ----
    if (data.type === "claude_event") {
      const event = data.event;

      if (event.type === "assistant") {
        const textBlocks = (event.message?.content ?? [])
          .filter((b: ClaudeContentBlock): b is ClaudeContentBlockText => b.type === "text")
          .map((b) => b.text)
          .join("");

        const toolUseBlocks = (event.message?.content ?? [])
          .filter((b: ClaudeContentBlock): b is ClaudeContentBlockToolUse => b.type === "tool_use");

        if (toolUseBlocks.length > 0) {
          const lastTool = toolUseBlocks[toolUseBlocks.length - 1];
          setActivity(activityFromTool(lastTool.name, lastTool.input));
        } else if (textBlocks) {
          setActivity({ label: "Thinking..." });
        }

        if (textBlocks || toolUseBlocks.length > 0) {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant" && last.streaming) {
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

      if (event.type === "user") {
        setActivity({ label: "Processing results..." });

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
        notify("The agent has finished responding.");
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
      // If we're generating a PR description, show the error in the modal
      if (prDescGeneratingRef.current) {
        setPrDescGenerating(false);
        prDescGeneratingRef.current = false;
        setPrDescError(data.message);
        return;
      }
      setIsLoading(false);
      setActivity(undefined);
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
      setAuthUrl(data.url ?? "");
      setIsLoading(false);
      setActivity(undefined);
    }

    if (data.type === "auth_complete") {
      setAuthUrl(null);
    }

    if (data.type === "agent_list") {
      setAgentList(data.agents);
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
      navigate(`/session/${data.session.id}`, { replace: true });
      setSessions((prev) => {
        const exists = prev.some((s) => s.id === data.session.id);
        if (exists) {
          return prev.map((s) => (s.id === data.session.id ? data.session : s));
        }
        return [data.session, ...prev];
      });
      // Load threads for this session
      send({ type: "list_threads" });
    }

    if (data.type === "session_renamed") {
      const renamed = (data as WsSessionRenamed).session;
      setSessions((prev) =>
        prev.map((s) => (s.id === renamed.id ? renamed : s))
      );
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
        files: m.files,
        isError: m.isError,
        streaming: false,
      }));
      setMessages(loaded);
    }

    if (data.type === "template_list") {
      setTemplates(data.templates as TemplateInfo[]);
    }

    if (data.type === "template_applied") {
      setShowTemplates(false);
      // Refresh file tree in case user is on that tab
      send({ type: "get_file_tree" });
    }

    if (data.type === "home_repo_ready") {
      setCreatingRepo(false);
      if (data.success && data.repoUrl) {
        setSelectedRepoUrl(data.repoUrl);
      }
    }

    if (data.type === "github_status") {
      setGithubStatus({
        authenticated: data.authenticated,
        username: data.username,
        avatarUrl: data.avatarUrl,
      });
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
      // Refresh PR status after push
      if (data.type === "github_push_result" && data.success) {
        send({ type: "get_pr_status" });
        // Show toast with PR creation shortcut
        if (githubStatus.authenticated && !prStatus?.url) {
          setToast({
            message: `Pushed to origin/${data.branch ?? "branch"}`,
            action: {
              label: "Create PR",
              onClick: () => {
                setShowPRModal(true);
                send({ type: "github_list_branches" });
              },
            },
            duration: 8000,
          });
        }
      }
    }


    if (data.type === "github_pr_created") {
      setPrResult({
        success: data.success,
        url: data.url,
        number: data.number,
        message: data.message,
      });
      // Refresh PR status after PR creation
      if (data.success) {
        send({ type: "get_pr_status" });
      }
    }

    if (data.type === "github_search_results") {
      setImportSearchResults(data.repos);
    }


    if (data.type === "pr_status") {
      setPrStatus(data.pr);
    }

    if (data.type === "merge_pr_result") {
      if (data.success && !data.autoMergeEnabled) {
        setPrStatus(null);
      } else if (data.autoMergeEnabled) {
        send({ type: "get_pr_status" });
      }
    }

    if (data.type === "github_branches") {
      setPrCurrentBranch(data.current);
      setPrRemoteBranches(data.remote);
    }

    if (data.type === "generated_pr_description") {
      setPrDescGenerating(false);
      prDescGeneratingRef.current = false;
      setPrGeneratedDesc(data.description);
    }

    if (data.type === "model_info") {
      const info = data as WsModelInfo;
      setModelInfo({ model: info.model, contextWindowTokens: info.contextWindowTokens });
    }

    if (data.type === "usage_update") {
      const update = data as WsUsageUpdate;
      setCurrentSessionUsage({
        sessionId: update.sessionId,
        totalCostUsd: update.totalCostUsd,
        totalDurationMs: update.totalDurationMs,
        turnCount: update.turnCount,
      });
      if (update.cumulativeInputTokens !== undefined) {
        setContextTokens(update.cumulativeInputTokens);
      }
      // Track per-turn token data
      if (update.lastTurnInputTokens !== undefined || update.lastTurnOutputTokens !== undefined) {
        setTurnTokens((prev) => [
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
      setSettingsOpen(false);
    }

    if (data.type === "thread_list") {
      setThreads(data.threads);
      setActiveThreadId(data.activeThreadId);
    }

    if (data.type === "checkpoint_created") {
      // Update the thread's checkpoints in local state
      setThreads((prev) =>
        prev.map((t) =>
          t.id === data.threadId
            ? { ...t, checkpoints: [...t.checkpoints, data.checkpoint] }
            : t,
        ),
      );
    }

    if (data.type === "thread_forked") {
      setThreads((prev) => {
        const deactivated = prev.map((t) => ({ ...t, isActive: false }));
        return [...deactivated, data.thread];
      });
      setActiveThreadId(data.thread.id);
      // Replace messages with the thread's conversation
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

    if (data.type === "thread_switched") {
      setThreads((prev) =>
        prev.map((t) => ({ ...t, isActive: t.id === data.thread.id })),
      );
      setActiveThreadId(data.thread.id);
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

    if (data.type === "deploy_targets") {
      setDeployTargets(data.targets);
    }

    if (data.type === "deploy_config_saved") {
      // Refresh config status after save
      send({ type: "get_deploy_config" });
    }

    if (data.type === "deploy_config") {
      setDeployConfigStatus(data.targets);
    }

    if (data.type === "deploy_status") {
      setDeployStatus(data.phase);
      setLastDeployUrl(null);
      setLastDeployError(null);
    }

    if (data.type === "deploy_complete") {
      setDeployStatus("complete");
      setLastDeployUrl(data.url);
      setLastDeployError(null);
    }

    if (data.type === "deploy_error") {
      setDeployStatus("error");
      setLastDeployError(data.message);
    }

    if (data.type === "deploy_history") {
      setDeployHistory(data.deployments);
    }

    if (data.type === "feature_list") {
      setFeatures(data.features);
    }

    if (data.type === "message_queued") {
      const queued = data as WsMessageQueued;
      setQueuedMessages((prev) => [...prev, { text: queued.text, position: queued.position }]);
      // Add the queued message to the chat list with queued=true
      setMessages((prev) => [...prev, { role: "user" as const, text: queued.text, queued: true, queuePosition: queued.position }]);
    }

    if (data.type === "queue_updated") {
      const update = data as WsQueueUpdated;
      setQueuedMessages(update.queue);
      // Sync queued state on chat messages: remove queued flag from items no longer in queue
      if (update.queue.length === 0) {
        // All queued items are now either executing or cancelled — clear queued flags
        setMessages((prev) =>
          prev.map((m) => (m.queued ? { ...m, queued: false, queuePosition: undefined } : m))
        );
      } else {
        // Keep only the first queued message as "currently executing" (no queued flag)
        // Others remain queued with updated positions
        const queueTexts = new Set(update.queue.map((q) => q.text));
        setMessages((prev) =>
          prev.map((m) => {
            if (!m.queued) return m;
            if (!queueTexts.has(m.text)) {
              // This message was either dequeued for execution or cancelled
              return { ...m, queued: false, queuePosition: undefined };
            }
            // Update position from server's authoritative queue
            const queueItem = update.queue.find((q) => q.text === m.text);
            return queueItem ? { ...m, queuePosition: queueItem.position } : m;
          })
        );
      }
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

    if (data.type === "terminal_output") {
      terminalRef.current?.write(data.data);
    }

    if (data.type === "terminal_exit") {
      setShellStarted(false);
    }
  }, [lastMessage, send, rightTab, viewingFile, notify, handleSessionResume, navigate]);

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
        permissionMode: permissionMode !== "auto" ? permissionMode : undefined,
      });
    },
    [send, requestPermission, permissionMode],
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

  const handleAddFile = useCallback(
    (filePath: string) => {
      setPendingFiles((prev) => {
        // Deduplicate by path
        if (prev.some((f) => f.path === filePath)) return prev;
        return [...prev, { path: filePath }];
      });
    },
    [],
  );

  const handleRemoveFile = useCallback(
    (index: number) => {
      setPendingFiles((prev) => prev.filter((_, i) => i !== index));
    },
    [],
  );

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
      const filesForMessage = pendingFiles.length > 0
        ? pendingFiles.map((f) => ({
            path: f.path,
            contentPreview: "",
          }))
        : undefined;
      setMessages((prev) => [...prev, { role: "user", text, images: messageImages, files: filesForMessage }]);
      setIsLoading(true);
      setActivity({ label: "Thinking..." });
      const fileRefs = pendingFiles.length > 0 ? pendingFiles : undefined;
      send({
        type: "send_message",
        text,
        sessionId: sessionIdRef.current,
        images,
        files: fileRefs,
        permissionMode: permissionMode !== "auto" ? permissionMode : undefined,
      });
      setPendingFiles([]);
    },
    [send, requestPermission, permissionMode, pendingFiles]
  );

  const handleEditMessage = useCallback(
    (messageIndex: number, newText: string) => {
      requestPermission();
      // Auto-checkpoint before edit so the user can return to the pre-edit state
      if (sessionIdRef.current && activeThreadId) {
        send({ type: "create_checkpoint", label: "Before edit" });
      }
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
        permissionMode: permissionMode !== "auto" ? permissionMode : undefined,
      });
    },
    [send, requestPermission, activeThreadId, permissionMode]
  );

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

  const handleSessionNew = useCallback(() => {
    sessionIdRef.current = undefined;
    setMessages([]);
    setIsLoading(false);
    setCurrentSessionUsage(null);
    setModelInfo(null);
    setContextTokens(0);
    setTurnTokens([]);
    setShowTemplates(true);
    setSelectedRepoUrl(null);
    // Reset session-specific UI state
    setViewingFile(null);
    setViewingFileContent(null);
    setViewingFileBinary(false);
    setGitCommits([]);
    setFileTree([]);
    setThreads([]);
    setActiveThreadId("");
    setShellStarted(false);
    setTerminalMode("logs");
    navigate("/");
    send({ type: "new_session" });
    // Request templates for the picker
    if (templates.length === 0) {
      send({ type: "list_templates" });
    }
  }, [send, templates.length, navigate]);


  const handleSessionArchive = useCallback(
    (sessionId: string) => {
      send({ type: "archive_session", sessionId });
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


  const handleHomeCreateRepo = useCallback(
    (name: string, description: string, isPrivate: boolean, templateId: string) => {
      setCreatingRepo(true);
      send({ type: "home_create_repo_with_template", repoName: name, description, isPrivate, templateId });
    },
    [send],
  );

  const handleHomeSendWithRepo = useCallback(
    (repoUrl: string, text: string, images?: Array<{ data: string; mediaType: string; filename: string }>) => {
      requestPermission();
      setShowTemplates(false);
      setMessages((prev) => [...prev, { role: "user", text }]);
      setIsLoading(true);
      setActivity({ label: "Setting up repository..." });
      send({
        type: "home_send_with_repo",
        repoUrl,
        text,
        images: images?.map((img) => ({ data: img.data, mediaType: img.mediaType })),
        files: pendingFiles.length > 0 ? pendingFiles : undefined,
        permissionMode: permissionMode !== "auto" ? permissionMode : undefined,
      });
      setPendingFiles([]);
    },
    [send, requestPermission, permissionMode, pendingFiles],
  );

  const handlePROpen = useCallback(() => {
    setPrResult(null);
    setPrCurrentBranch("");
    setPrRemoteBranches([]);
    setPrDescGenerating(false);
    prDescGeneratingRef.current = false;
    setPrDescError(null);
    setPrGeneratedDesc(null);
    setShowPRModal(true);
  }, []);

  const handlePRGenerateDescription = useCallback(() => {
    setPrDescGenerating(true);
    prDescGeneratingRef.current = true;
    setPrDescError(null);
    setPrGeneratedDesc(null);
    send({ type: "generate_pr_description" });
  }, [send]);

  const handlePRSubmit = useCallback(
    (data: { title: string; body: string; base: string; draft: boolean }) => {
      send({ type: "github_create_pr", title: data.title, body: data.body, base: data.base, draft: data.draft });
    },
    [send],
  );

  const handlePRRequestBranches = useCallback(() => {
    send({ type: "github_list_branches" });
  }, [send]);

  const handleUsageBadgeClick = useCallback(() => {
    send({ type: "get_usage_stats" });
    setShowUsageModal(true);
  }, [send]);

  const handleSettingsOpen = useCallback(() => {
    send({ type: "get_system_prompt" });
    setSettingsOpen(true);
  }, [send]);

  const handleInstructionsSave = useCallback(
    (content: string) => {
      send({ type: "set_system_prompt", content });
    },
    [send],
  );

  const handleCreateCheckpoint = useCallback(
    (label?: string) => {
      send({ type: "create_checkpoint", label });
    },
    [send],
  );

  const handleForkThread = useCallback(
    (checkpointId: string) => {
      send({ type: "fork_thread", checkpointId });
    },
    [send],
  );

  const handleSwitchThread = useCallback(
    (threadId: string) => {
      send({ type: "switch_thread", threadId });
    },
    [send],
  );

  const handleDeployOpen = useCallback(() => {
    send({ type: "list_deploy_targets" });
    send({ type: "get_deploy_config" });
    setDeployStatus(null);
    setLastDeployUrl(null);
    setLastDeployError(null);
    setShowDeployModal(true);
  }, [send]);

  const handleDeployConfigure = useCallback(
    (targetId: string, credentials: Record<string, string>, projectName?: string) => {
      send({ type: "deploy_configure", targetId, credentials, projectName });
    },
    [send],
  );

  const handleDeployInitiate = useCallback(
    (targetId: string, environment: "production" | "preview") => {
      send({ type: "initiate_deploy", targetId, environment });
    },
    [send],
  );

  const handleDeployCancel = useCallback(() => {
    send({ type: "cancel_deploy" });
  }, [send]);

  const handleCancelQueued = useCallback(
    (position: number | "all") => {
      send({ type: "cancel_queued_message", position });
    },
    [send],
  );

  const handleDeployGetHistory = useCallback(() => {
    send({ type: "get_deploy_history" });
  }, [send]);

  const handleDeployDeleteConfig = useCallback(
    (targetId: string) => {
      send({ type: "delete_deploy_config", targetId });
    },
    [send],
  );

  const handleDeploySendError = useCallback(
    (errorMessage: string) => {
      setShowDeployModal(false);
      handleSend(`The deployment failed with this error:\n\n${errorMessage}\n\nPlease fix the issue and explain what went wrong.`);
    },
    [handleSend],
  );

  const handleFeatureRefresh = useCallback(() => {
    send({ type: "list_features" });
  }, [send]);

  const handleFeatureStartSession = useCallback(
    (feature: FeatureInfo) => {
      // Create a new session
      sessionIdRef.current = undefined;
      setMessages([]);
      setIsLoading(false);
      setCurrentSessionUsage(null);
      setModelInfo(null);
      setContextTokens(0);
      setTurnTokens([]);
      setShowTemplates(false);
      setViewingFile(null);
      setViewingFileContent(null);
      setViewingFileBinary(false);
      setGitCommits([]);
      setFileTree([]);
      setThreads([]);
      setActiveThreadId("");
      send({ type: "new_session" });

      // Build context message referencing the feature docs
      let text = `Work on feature: ${feature.name}\n\nPlease read the feature plan at ${feature.planPath}`;
      if (feature.checklistPath) {
        text += ` and the remaining work checklist at ${feature.checklistPath}`;
      }
      text += `, then proceed with the implementation.`;

      // Send the message (will create a new session on the server)
      requestPermission();
      setMessages([{ role: "user", text }]);
      setIsLoading(true);
      setActivity({ label: "Thinking..." });
      // Don't pass sessionId — let the server create a new session
      send({ type: "send_message", text });

      // Switch to chat view on mobile
      setMobilePanel("chat");
    },
    [send, requestPermission],
  );

  const handleImportSearch = useCallback(
    (query: string) => {
      send({ type: "github_search_repos", query });
    },
    [send],
  );


  const handleMergePr = useCallback(
    (method: "merge" | "squash" | "rebase") => {
      send({ type: "merge_pr", method });
    },
    [send],
  );

  const handlePermissionModeChange = useCallback((mode: PermissionMode) => {
    setPermissionMode(mode);
    savePermissionMode(mode);
  }, []);

  const handleAgentChange = useCallback((agentId: AgentId) => {
    setActiveAgentId(agentId);
    saveAgentId(agentId);
    send({ type: "set_agent", agentId });
  }, [send]);

  const handleClearLogs = useCallback(() => {
    setLogEntries([]);
    send({ type: "clear_logs" });
  }, [send]);

  const handleTerminalInput = useCallback(
    (data: string) => {
      send({ type: "terminal_input", data });
    },
    [send],
  );

  const handleTerminalResize = useCallback(
    (cols: number, rows: number) => {
      send({ type: "terminal_resize", cols, rows });
    },
    [send],
  );

  const handleTerminalStart = useCallback(() => {
    send({ type: "terminal_start" });
    setShellStarted(true);
  }, [send]);

  const handleTerminalModeChange = useCallback((mode: TerminalMode) => {
    setTerminalMode(mode);
  }, []);

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
      if (tab === "features") {
        send({ type: "list_features" });
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
        <button
          onClick={() => handleTabChange("features")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            rightTab === "features"
              ? "text-gray-900 dark:text-gray-100 border-b-2 border-blue-500"
              : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Features
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
            terminalMode={terminalMode}
            onTerminalModeChange={handleTerminalModeChange}
            shellContent={
              (shellStarted || terminalMode === "shell") ? (
                <InteractiveTerminal
                  ref={terminalRef}
                  onInput={handleTerminalInput}
                  onResize={handleTerminalResize}
                  onStart={handleTerminalStart}
                />
              ) : null
            }
          />
        ) : rightTab === "features" ? (
          <FeaturesPanel
            features={features}
            onStartSession={handleFeatureStartSession}
            onRefresh={handleFeatureRefresh}
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
            onAddToChat={handleAddFile}
          />
        )}
      </div>
    </>
  );

  // Compute checkpoint dividers from all threads for the MessageList
  const checkpointDividers: CheckpointDivider[] = useMemo(() => {
    const dividers: CheckpointDivider[] = [];
    for (const thread of threads) {
      for (const cp of thread.checkpoints) {
        dividers.push({
          id: cp.id,
          messageIndex: cp.messageIndex,
          label: cp.label,
        });
      }
    }
    return dividers;
  }, [threads]);

  // Show template picker for new sessions with no messages
  const showTemplatePicker = showTemplates && messages.length === 0 && !isLoading;
  const showHomeScreen = showTemplatePicker;

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
      {showHomeScreen ? (
        <HomeScreen
          sessions={sessions}
          githubStatus={githubStatus}
          templates={templates}
          onSendWithRepo={handleHomeSendWithRepo}
          onNewRepo={handleHomeCreateRepo}
          onSearchRepos={handleImportSearch}
          searchResults={importSearchResults}
          disabled={isLoading || status !== "open"}
          permissionMode={permissionMode}
          onPermissionModeChange={handlePermissionModeChange}
          pendingFiles={pendingFiles}
          onRemoveFile={handleRemoveFile}
          onAddFile={handleAddFile}
          fileTree={fileTree}
          creatingRepo={creatingRepo}
          selectedRepoUrl={selectedRepoUrl}
          onSelectRepo={setSelectedRepoUrl}
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
          checkpoints={checkpointDividers}
        />
      )}
      {!showHomeScreen && (
        <div className="border-t border-gray-200 dark:border-gray-800 px-4 py-1.5 flex items-center gap-2">
          <ThreadIndicator
            threads={threads}
            activeThreadId={activeThreadId}
            onCreateCheckpoint={handleCreateCheckpoint}
            onForkThread={handleForkThread}
            onSwitchThread={handleSwitchThread}
            disabled={isLoading || status !== "open"}
          />
          <AgentPicker
            agents={agentList}
            activeAgentId={activeAgentId}
            onAgentChange={handleAgentChange}
            disabled={isLoading || status !== "open"}
          />
        </div>
      )}
      {!showHomeScreen && threads.length > 0 && (
        <ThreadTimeline
          threads={threads}
          activeThreadId={activeThreadId}
          onForkThread={handleForkThread}
          onSwitchThread={handleSwitchThread}
        />
      )}
      {!showHomeScreen && (
        <GitHistory
          commits={gitCommits}
          onRollback={handleRollback}
          onRefresh={handleGitRefresh}
        />
      )}
      {!showHomeScreen && (
        <StatusBar modelInfo={modelInfo} contextTokens={contextTokens} agentName={agentList.find((a) => a.id === activeAgentId)?.name} />
      )}
      {!showHomeScreen && queuedMessages.length > 0 && (
        <QueueIndicator
          queue={queuedMessages}
          onCancel={handleCancelQueued}
        />
      )}
      {!showHomeScreen && (
        <MessageInput
          onSend={handleSend}
          disabled={status !== "open"}
          permissionMode={permissionMode}
          onPermissionModeChange={handlePermissionModeChange}
          pendingFiles={pendingFiles}
          onRemoveFile={handleRemoveFile}
          onAddFile={handleAddFile}
          fileTree={fileTree}
        />
      )}
    </>
  );

  return (
    <div className="flex flex-col h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {authUrl !== null && <AuthOverlay url={authUrl} onPasteCode={(code) => send({ type: "paste_auth_code", code })} onApiKey={(key) => send({ type: "set_api_key", key })} />}
      {gitIdentityNeeded && (
        <GitIdentityOverlay onSubmit={handleGitIdentitySubmit} />
      )}
      {shortcutsOpen && <KeyboardShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}
      {settingsOpen && (
        <ProjectSettings
          initialContent={systemPromptContent}
          onSaveInstructions={handleInstructionsSave}
          githubStatus={githubStatus}
          onGitHubTokenSubmit={handleGitHubTokenSubmit}
          onGitHubLogout={handleGitHubLogout}
          authUrl={authUrl}
          onApiKey={(key) => send({ type: "set_api_key", key })}
          onClearApiKey={() => send({ type: "clear_api_key" })}
          agentList={agentList}
          onSetAgentEnv={(agentId, key, value) => send({ type: "set_agent_env", agentId, key, value })}
          onRequestAgentList={() => send({ type: "list_agents" })}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {showDeployModal && (
        <DeployModal
          targets={deployTargets}
          configStatus={deployConfigStatus}
          deployStatus={deployStatus}
          lastDeployUrl={lastDeployUrl}
          lastDeployError={lastDeployError}
          deployHistory={deployHistory}
          onConfigure={handleDeployConfigure}
          onDeploy={handleDeployInitiate}
          onCancel={handleDeployCancel}
          onGetHistory={handleDeployGetHistory}
          onDeleteConfig={handleDeployDeleteConfig}
          onSendErrorToChat={handleDeploySendError}
          onClose={() => setShowDeployModal(false)}
        />
      )}
      {showPRModal && (
        <PullRequestModal
          currentBranch={prCurrentBranch}
          remoteBranches={prRemoteBranches}
          onSubmit={handlePRSubmit}
          onRequestBranches={handlePRRequestBranches}
          onGenerateDescription={handlePRGenerateDescription}
          onClose={() => setShowPRModal(false)}
          result={prResult}
          isGeneratingDescription={prDescGenerating}
          generateDescriptionError={prDescError}
          generatedDescription={prGeneratedDesc}
        />
      )}
      {showUsageModal && (
        <UsageModal
          currentSessionUsage={currentSessionUsage}
          allUsage={allUsageStats}
          sessions={sessions}
          onClose={() => setShowUsageModal(false)}
          modelInfo={modelInfo}
          contextTokens={contextTokens}
          turnTokens={turnTokens}
        />
      )}

      {/* Header */}
      <header className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          <h1 className="text-lg font-semibold tracking-tight shrink-0 flex items-center gap-1.5">
            <img src={theme === "dark" ? "/favicon.svg" : "/favicon-light.svg"} alt="" className="w-5 h-5" />
            ShipIt
          </h1>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {githubStatus.authenticated && (
            <button
              onClick={handlePROpen}
              className="hidden sm:inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-800 transition-colors font-medium"
              title="Create pull request"
              aria-label="Create PR"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
              </svg>
              PR
            </button>
          )}
          <button
            onClick={handleDeployOpen}
            className="hidden sm:inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-cyan-100 dark:bg-cyan-900 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-200 dark:hover:bg-cyan-800 transition-colors font-medium"
            title="Deploy to production"
            aria-label="Deploy"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
            </svg>
            Deploy
          </button>
          <button
            onClick={handleSettingsOpen}
            className={`hidden sm:inline-flex items-center justify-center w-7 h-7 rounded transition-colors ${
              hasSystemPrompt || githubStatus.authenticated
                ? "text-blue-400 hover:text-blue-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                : "text-gray-500 hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
            }`}
            title="Project settings"
            aria-label="Project settings"
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
        </div>
      </header>

      <ConnectionBanner status={status} reconnectAttempt={reconnectAttempt} onReconnect={reconnect} />

      {prStatus && (
        <PrStatusBar
          baseBranch={prStatus.baseBranch}
          headBranch={prStatus.headBranch}
          insertions={prStatus.insertions}
          deletions={prStatus.deletions}
          prUrl={prStatus.url}
          prNumber={prStatus.number}
          checks={prStatus.checks}
          autoMergeEnabled={prStatus.autoMergeEnabled}
          mergeable={prStatus.mergeable}
          onMerge={handleMergePr}
        />
      )}

      {isMobile ? (
        /* ── Mobile: single panel with bottom tab bar ── */
        <>
          <div className="flex flex-col flex-1 min-h-0">
            {showHomeScreen || mobilePanel === "chat" ? (
              <div className="flex flex-col flex-1 min-h-0">{chatPanel}</div>
            ) : (
              <div className="flex flex-col flex-1 min-h-0 bg-gray-50 dark:bg-gray-900">{rightPanel}</div>
            )}
          </div>
          {!showHomeScreen && (
            <MobileTabBar activePanel={mobilePanel} onChangePanel={setMobilePanel} />
          )}
        </>
      ) : (
        /* ── Desktop: sidebar + resizable chat/right layout ── */
        <div className="flex flex-1 min-h-0">
          <SessionSidebar
            sessions={sessions}
            currentSessionId={sessionIdRef.current}
            onResume={handleSessionResume}
            onNew={handleSessionNew}
            onArchive={handleSessionArchive}
            onRename={handleSessionRename}
            onRefresh={handleSessionRefresh}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => {
              setSidebarCollapsed((v) => {
                saveSidebarCollapsed(!v);
                return !v;
              });
            }}
          />
          <div ref={containerRef} className="flex flex-1 min-h-0">
            {/* Left column — Chat */}
            <div
              className={`flex flex-col min-w-0 ${showHomeScreen ? "" : "border-r border-gray-200 dark:border-gray-800"}`}
              style={{ width: showHomeScreen ? "100%" : `${fraction * 100}%` }}
            >
              {chatPanel}
            </div>

            {!showHomeScreen && (
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
        </div>
      )}

      {toast && <Toast toast={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}
