import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useWebSocket } from "./hooks/useWebSocket.js";
import { useResizablePanel } from "./hooks/useResizablePanel.js";
import { useSearch } from "./hooks/useSearch.js";
import { useIsMobile } from "./hooks/useMediaQuery.js";
import { useNotification } from "./hooks/useNotification.js";
import { useTheme } from "./hooks/useTheme.js";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts.js";
import { useConnectionSync } from "./hooks/useConnectionSync.js";
import { useAutoFix } from "./hooks/useAutoFix.js";
import { useMessageHandler } from "./hooks/useMessageHandler.js";
import { useAppCallbacks } from "./hooks/useAppCallbacks.js";
import { getSavedPermissionMode, getSavedSidebarCollapsed, getSavedAgentId, saveSidebarCollapsed } from "./utils/local-storage.js";
import { MessageInput } from "./components/MessageInput.js";
import { MessageList, type ChatMessage, type CheckpointDivider } from "./components/MessageList.js";
import { PreviewFrame, type PreviewStatus } from "./components/PreviewFrame.js";
import { usePreviewErrors } from "./hooks/usePreviewErrors.js";
import { GitHistory, type GitCommit } from "./components/GitHistory.js";
import { AuthOverlay } from "./components/AuthOverlay.js";
import { Settings } from "./components/Settings.js";
import { SessionSidebar } from "./components/SessionSidebar.js";
import { DocsViewer } from "./components/DocsViewer.js";
import { FileTree, type FileTreeNode } from "./components/FileTree.js";
import { FileContentViewer } from "./components/FileContentViewer.js";
import { TerminalPanel, type LogEntry, type TerminalMode } from "./components/TerminalPanel.js";
import { InteractiveTerminal, type InteractiveTerminalHandle } from "./components/InteractiveTerminal.js";
import { ResizeHandle } from "./components/ResizeHandle.js";
import { SearchBar } from "./components/SearchBar.js";
import { type StreamingActivity } from "./components/StreamingIndicator.js";
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
import type { TurnDiffData } from "./components/DiffPanel.js";

const DiffPanel = lazy(() => import("./components/DiffPanel.js").then(m => ({ default: m.DiffPanel })));
import { PullRequestModal } from "./components/PullRequestModal.js";
import { PrStatusBar } from "./components/PrStatusBar.js";
import { Toast, type ToastData } from "./components/Toast.js";
import { QueueIndicator } from "./components/QueueIndicator.js";
import { AgentPicker, type AgentOption } from "./components/AgentPicker.js";
import type { DeployTargetInfo, DeploymentRecord, FeatureInfo, PermissionMode, FileContextRef, SessionInfo, AgentId } from "../server/types.js";

type RightTab = "preview" | "docs" | "files" | "terminal" | "features" | "changes";

function getWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = import.meta.env.VITE_API_HOST || window.location.host;
  return `${proto}//${host}/ws`;
}

export default function App() {
  const { sessionId: urlSessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { send, lastMessage, status, reconnectAttempt, reconnect } = useWebSocket(getWsUrl());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewStatus | null>(null);
  const [selectedPort, setSelectedPort] = useState<number | null>(null);
  const [configMissing, setConfigMissing] = useState(false);
  const [installStatus, setInstallStatus] = useState<{ status: "running" | "complete" | "error"; message?: string } | null>(null);
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
  const [repoDocFiles, setRepoDocFiles] = useState<string[]>([]);
  const [selectedRepoDoc, setSelectedRepoDoc] = useState<string | null>(null);
  const [repoDocContent, setRepoDocContent] = useState<string | null>(null);
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
  const [gitIdentity, setGitIdentity] = useState<{ name: string; email: string }>({ name: "", email: "" });
  const [threads, setThreads] = useState<ThreadInfo[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string>("");
  const [initialSettingsTab, setInitialSettingsTab] = useState<"agent" | "github" | "git" | "instructions" | "advanced" | "deploy" | undefined>(undefined);
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
  const [turnDiff, setTurnDiff] = useState<TurnDiffData | null>(null);
  const [lastCommitPair, setLastCommitPair] = useState<{ from: string; to: string } | null>(null);
  const [diffBadgeCount, setDiffBadgeCount] = useState(0);
  // Track sessions with active agent runners (for sidebar activity indicators)
  const [activeRunnerSessions, setActiveRunnerSessions] = useState<Set<string>>(new Set());
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

  // ── Auto-fix hook ──
  const { autoFixEnabled, autoFixRetries, autoFixRetriesRef, handleToggleAutoFix, disableAutoFix } = useAutoFix({
    previewErrors,
    isLoading,
    status,
    send,
    sessionIdRef,
    setMessages,
    setIsLoading,
    setActivity,
  });

  // ── App callbacks hook ──
  const callbacks = useAppCallbacks({
    send,
    navigate,
    requestPermission,
    permissionMode,
    pendingFiles,
    activeThreadId,
    templates,
    docFiles,
    agentList,
    activeAgentId,
    githubStatus,
    setMessages, setIsLoading, setActivity, setShowTemplates, setPendingFiles,
    setPermissionMode, setViewingFile, setViewingFileContent, setViewingFileBinary,
    setGitCommits, setFileTree, setCurrentSessionUsage, setModelInfo, setContextTokens, setTurnTokens,
    setSelectedRepoUrl, setCreatingRepo, setThreads, setActiveThreadId, setShellStarted, setTerminalMode,
    setSelectedDoc, setDocContent, setRightTab, setFileChangeCount, setUnreadLogCount,
    setSettingsOpen, setInitialSettingsTab, setShowDeployModal, setDeployStatus, setLastDeployUrl, setLastDeployError,
    setShowPRModal, setPrResult, setPrDescGenerating, setPrDescError, setPrGeneratedDesc,
    setShowUsageModal, setLogEntries, setActiveAgentId, setQueuedMessages, setMobilePanel,
    setAutoFixEnabled: () => {}, // not used — disableAutoFix is used instead
    setHasSystemPrompt,
    setSelectedPort, setPrCurrentBranch, setPrRemoteBranches,
    setTurnDiff, setLastCommitPair, setDiffBadgeCount,
    lastCommitPair, turnDiff,
    sessionIdRef, prDescGeneratingRef, autoFixRetriesRef,
    disableAutoFix,
    setAutoFixRetries: () => {}, // not used — disableAutoFix handles this
  });

  // ── Keyboard shortcuts hook ──
  useKeyboardShortcuts({
    search,
    searchOpen,
    setSearchOpen: (updater) => setSearchOpen(updater),
    shortcutsOpen,
    setShortcutsOpen: (updater) => setShortcutsOpen(updater),
    isLoading,
    settingsOpen,
    handleInterrupt: callbacks.handleInterrupt,
  });

  // ── Connection sync hook ──
  useConnectionSync({
    status,
    send,
    sessionIdRef,
    historyLoadedRef,
    templates,
    isLoading,
    setIsLoading,
    setActivity,
    setMessages,
    prStatus,
  });

  // ── Message handler hook ──
  useMessageHandler({
    lastMessage,
    send,
    setPreview, setSelectedPort, setMessages, setIsLoading, setActivity,
    setGitCommits, setAuthUrl, setSessions, setDocFiles, setDocContent,
    setFileTree, setViewingFileContent, setViewingFileBinary,
    setLogEntries, setUnreadLogCount, setTemplates, setShowTemplates,
    setCreatingRepo, setSelectedRepoUrl, setGithubStatus,
    setCurrentSessionUsage, setAllUsageStats, setModelInfo, setContextTokens, setTurnTokens,
    setFileChangeCount, setHasSystemPrompt, setSystemPromptContent,
    setGitIdentityNeeded, setGitIdentity, setThreads, setActiveThreadId,
    setDeployTargets, setDeployConfigStatus, setDeployStatus, setLastDeployUrl, setLastDeployError,
    setDeployHistory, setFeatures, setAgentList, setShowPRModal,
    setPrCurrentBranch, setPrRemoteBranches, setPrResult, setPrDescGenerating,
    setPrDescError, setPrGeneratedDesc, setImportSearchResults, setPrStatus,
    setQueuedMessages, setShellStarted, setToast,
    setConfigMissing, setInstallStatus,
    setTurnDiff, setLastCommitPair, setDiffBadgeCount,
    setActiveRunnerSessions,
    setRepoDocFiles, setRepoDocContent,
    prDescGeneratingRef, sessionIdRef, terminalRef,
    rightTab, viewingFile, gitCommits, notify,
    navigate,
    handleSessionResume: callbacks.handleSessionResume,
    githubStatus, prStatus,
  });

  // Sync session state when the URL changes (back/forward navigation)
  useEffect(() => {
    if (urlSessionId && urlSessionId !== sessionIdRef.current) {
      callbacks.resumeSessionInternal(urlSessionId);
    } else if (!urlSessionId && sessionIdRef.current) {
      // Navigated back to "/" — reset to new session state
      sessionIdRef.current = undefined;
      setMessages([]);
      setIsLoading(false);
      setShowTemplates(true);
      setSelectedRepoUrl(null);
      setRepoDocFiles([]);
      setSelectedRepoDoc(null);
      setRepoDocContent(null);
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
      setTurnDiff(null);
      setLastCommitPair(null);
      setDiffBadgeCount(0);
    }
  }, [urlSessionId, callbacks.resumeSessionInternal]);

  // Extract owner/repo from a GitHub URL (e.g., "https://github.com/owner/repo.git" → "owner/repo")
  const repoFullName = useMemo(() => {
    if (!selectedRepoUrl) return null;
    const match = selectedRepoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
    return match ? `${match[1]}/${match[2]}` : null;
  }, [selectedRepoUrl]);

  // Fetch repo docs from GitHub when a repo is selected on the HomeScreen
  useEffect(() => {
    if (repoFullName && status === "open") {
      setRepoDocFiles([]);
      setSelectedRepoDoc(null);
      setRepoDocContent(null);
      send({ type: "list_repo_docs", repoFullName });
    }
  }, [repoFullName, send, status]);

  const handleSelectRepoDoc = useCallback(
    (filePath: string) => {
      if (!repoFullName) return;
      setSelectedRepoDoc(filePath);
      setRepoDocContent(null);
      send({ type: "get_repo_doc", repoFullName, path: filePath });
    },
    [send, repoFullName],
  );

  const handleRefreshRepoDocs = useCallback(() => {
    if (!repoFullName) return;
    send({ type: "list_repo_docs", repoFullName });
  }, [send, repoFullName]);

  // Shared right-panel content (Preview / Docs / Files with tab bar)
  const rightPanel = (
    <>
      {/* Tab bar */}
      <div className="flex border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
        <button
          onClick={() => callbacks.handleTabChange("preview")}
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
          onClick={() => callbacks.handleTabChange("docs")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            rightTab === "docs"
              ? "text-gray-900 dark:text-gray-100 border-b-2 border-blue-500"
              : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Docs
        </button>
        <button
          onClick={() => callbacks.handleTabChange("files")}
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
          onClick={() => callbacks.handleTabChange("terminal")}
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
        {lastCommitPair && (
          <button
            onClick={() => callbacks.handleTabChange("changes")}
            className={`px-4 py-2 text-sm font-medium transition-colors relative ${
              rightTab === "changes"
                ? "text-gray-900 dark:text-gray-100 border-b-2 border-blue-500"
                : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            }`}
          >
            Changes
            {diffBadgeCount > 0 && rightTab !== "changes" && (
              <span className="ml-1.5 inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 text-[10px] font-semibold rounded-full bg-orange-600 text-white">
                {diffBadgeCount > 99 ? "99+" : diffBadgeCount}
              </span>
            )}
          </button>
        )}
        <button
          onClick={() => callbacks.handleTabChange("features")}
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
            onSelectPort={callbacks.handleSelectPort}
            errors={previewErrors}
            onSendErrors={callbacks.handleSendErrors}
            onClearErrors={clearPreviewErrors}
            autoFixEnabled={autoFixEnabled}
            onToggleAutoFix={handleToggleAutoFix}
            autoFixRetries={autoFixRetries}
            configMissing={configMissing}
            installStatus={installStatus}
            onInitPreviewConfig={() => send({ type: "init_preview_config" })}
          />
        ) : rightTab === "docs" ? (
          <DocsViewer
            files={docFiles}
            selectedFile={selectedDoc}
            content={docContent}
            onSelectFile={callbacks.handleDocSelect}
            onRefresh={callbacks.handleDocRefresh}
          />
        ) : rightTab === "terminal" ? (
          <TerminalPanel
            entries={logEntries}
            onClear={callbacks.handleClearLogs}
            terminalMode={terminalMode}
            onTerminalModeChange={callbacks.handleTerminalModeChange}
            shellContent={
              (shellStarted || terminalMode === "shell") ? (
                <InteractiveTerminal
                  ref={terminalRef}
                  onInput={callbacks.handleTerminalInput}
                  onResize={callbacks.handleTerminalResize}
                  onStart={callbacks.handleTerminalStart}
                />
              ) : null
            }
          />
        ) : rightTab === "changes" ? (
          turnDiff ? (
            <Suspense fallback={<div className="flex items-center justify-center h-full text-gray-500 text-sm">Loading diff viewer...</div>}>
              <DiffPanel
                diff={turnDiff}
                onAcceptAll={callbacks.handleDiffAcceptAll}
                onRejectFiles={callbacks.handleDiffRejectFiles}
                onClose={callbacks.handleDiffClose}
              />
            </Suspense>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">
              Loading diff...
            </div>
          )
        ) : rightTab === "features" ? (
          <FeaturesPanel
            features={features}
            onStartSession={callbacks.handleFeatureStartSession}
            onRefresh={callbacks.handleFeatureRefresh}
          />
        ) : viewingFile ? (
          <FileContentViewer
            filePath={viewingFile}
            content={viewingFileContent}
            isBinary={viewingFileBinary}
            onClose={callbacks.handleFileViewerClose}
          />
        ) : (
          <FileTree
            tree={fileTree}
            onRefresh={callbacks.handleFileTreeRefresh}
            onFileClick={callbacks.handleFileClick}
            selectedFile={viewingFile}
            onAddToChat={callbacks.handleAddFile}
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
          onRequestTemplates={() => send({ type: "list_templates" })}
          onSendWithRepo={callbacks.handleHomeSendWithRepo}
          onNewRepo={callbacks.handleHomeCreateRepo}
          onSearchRepos={callbacks.handleImportSearch}
          searchResults={importSearchResults}
          disabled={isLoading || status !== "open"}
          permissionMode={permissionMode}
          onPermissionModeChange={callbacks.handlePermissionModeChange}
          pendingFiles={pendingFiles}
          onRemoveFile={callbacks.handleRemoveFile}
          onAddFile={callbacks.handleAddFile}
          fileTree={fileTree}
          creatingRepo={creatingRepo}
          selectedRepoUrl={selectedRepoUrl}
          onSelectRepo={setSelectedRepoUrl}
          repoDocFiles={repoDocFiles}
          repoDocContent={repoDocContent}
          selectedRepoDoc={selectedRepoDoc}
          onSelectRepoDoc={handleSelectRepoDoc}
          onRefreshRepoDocs={handleRefreshRepoDocs}
        />
      ) : (
        <MessageList
          messages={messages}
          isLoading={isLoading}
          activity={activity}
          searchMatches={search.matches}
          currentMatch={search.currentMatch}
          onEditMessage={callbacks.handleEditMessage}
          onAnswerQuestion={callbacks.handleAnswerQuestion}
          checkpoints={checkpointDividers}
        />
      )}
      {!showHomeScreen && (
        <div className="border-t border-gray-200 dark:border-gray-800 px-4 py-1.5 flex items-center gap-2">
          <ThreadIndicator
            threads={threads}
            activeThreadId={activeThreadId}
            onCreateCheckpoint={callbacks.handleCreateCheckpoint}
            onForkThread={callbacks.handleForkThread}
            onSwitchThread={callbacks.handleSwitchThread}
            disabled={isLoading || status !== "open"}
          />
          <AgentPicker
            agents={agentList}
            activeAgentId={activeAgentId}
            onAgentChange={callbacks.handleAgentChange}
            disabled={isLoading || status !== "open"}
          />
        </div>
      )}
      {!showHomeScreen && threads.length > 0 && (
        <ThreadTimeline
          threads={threads}
          activeThreadId={activeThreadId}
          onForkThread={callbacks.handleForkThread}
          onSwitchThread={callbacks.handleSwitchThread}
        />
      )}
      {!showHomeScreen && (
        <GitHistory
          commits={gitCommits}
          onRollback={callbacks.handleRollback}
          onRefresh={callbacks.handleGitRefresh}
        />
      )}
      {!showHomeScreen && (
        <StatusBar modelInfo={modelInfo} contextTokens={contextTokens} agentName={agentList.find((a) => a.id === activeAgentId)?.name} />
      )}
      {!showHomeScreen && queuedMessages.length > 0 && (
        <QueueIndicator
          queue={queuedMessages}
          onCancel={callbacks.handleCancelQueued}
        />
      )}
      {!showHomeScreen && (
        <MessageInput
          onSend={callbacks.handleSend}
          disabled={status !== "open"}
          isLoading={isLoading}
          onInterrupt={callbacks.handleInterrupt}
          permissionMode={permissionMode}
          onPermissionModeChange={callbacks.handlePermissionModeChange}
          pendingFiles={pendingFiles}
          onRemoveFile={callbacks.handleRemoveFile}
          onAddFile={callbacks.handleAddFile}
          fileTree={fileTree}
        />
      )}
    </>
  );

  return (
    <div className="flex flex-col h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {authUrl !== null && <AuthOverlay url={authUrl} onPasteCode={(code) => send({ type: "paste_auth_code", code })} onApiKey={(key) => send({ type: "set_api_key", key })} />}
      {gitIdentityNeeded && (
        <GitIdentityOverlay onSubmit={callbacks.handleGitIdentitySubmit} />
      )}
      {shortcutsOpen && <KeyboardShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}
      {settingsOpen && (
        <Settings
          initialContent={systemPromptContent}
          onSaveInstructions={callbacks.handleInstructionsSave}
          githubStatus={githubStatus}
          onGitHubTokenSubmit={callbacks.handleGitHubTokenSubmit}
          onGitHubLogout={callbacks.handleGitHubLogout}
          authUrl={authUrl}
          onApiKey={(key) => send({ type: "set_api_key", key })}
          onClearApiKey={() => send({ type: "clear_api_key" })}
          onStartAuth={() => send({ type: "start_auth" })}
          onPasteCode={(code) => send({ type: "paste_auth_code", code })}
          agentList={agentList}
          onSetAgentEnv={(agentId, key, value) => send({ type: "set_agent_env", agentId, key, value })}
          onFullReset={callbacks.handleFullReset}
          gitIdentity={gitIdentity}
          onGitIdentitySave={(name, email) => send({ type: "save_global_settings", gitIdentity: { name, email } })}
          deployTargets={deployTargets}
          deployConfigStatus={deployConfigStatus}
          onDeployConfigure={callbacks.handleDeployConfigure}
          onDeployDeleteConfig={callbacks.handleDeployDeleteConfig}
          hasActiveSession={!!sessionIdRef.current}
          initialTab={initialSettingsTab}
          onDeployTabSelected={callbacks.handleDeployTabSelected}
          onClose={() => { setSettingsOpen(false); setInitialSettingsTab(undefined); }}
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
          onDeploy={callbacks.handleDeployInitiate}
          onCancel={callbacks.handleDeployCancel}
          onGetHistory={callbacks.handleDeployGetHistory}
          onSendErrorToChat={callbacks.handleDeploySendError}
          onOpenDeploySettings={() => callbacks.handleSettingsOpen("deploy")}
          onClose={() => setShowDeployModal(false)}
        />
      )}
      {showPRModal && (
        <PullRequestModal
          currentBranch={prCurrentBranch}
          remoteBranches={prRemoteBranches}
          onSubmit={callbacks.handlePRSubmit}
          onRequestBranches={callbacks.handlePRRequestBranches}
          onGenerateDescription={callbacks.handlePRGenerateDescription}
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
              onClick={callbacks.handlePROpen}
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
            onClick={callbacks.handleDeployOpen}
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
            onClick={() => callbacks.handleSettingsOpen()}
            className={`hidden sm:inline-flex items-center justify-center w-7 h-7 rounded transition-colors ${
              hasSystemPrompt || githubStatus.authenticated
                ? "text-blue-400 hover:text-blue-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                : "text-gray-500 hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
            }`}
            title="Settings"
            aria-label="Settings"
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
              onClick={callbacks.handleUsageBadgeClick}
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
          onMerge={callbacks.handleMergePr}
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
            activeRunnerSessions={activeRunnerSessions}
            onResume={callbacks.handleSessionResume}
            onNew={callbacks.handleSessionNew}
            onArchive={callbacks.handleSessionArchive}
            onRename={callbacks.handleSessionRename}
            onRefresh={callbacks.handleSessionRefresh}
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
