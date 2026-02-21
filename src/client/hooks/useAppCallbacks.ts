import { useCallback, type Dispatch, type SetStateAction, type MutableRefObject } from "react";
import { useNavigate } from "react-router-dom";
import { formatErrorForMessage } from "../components/PreviewFrame.js";
import type { PreviewError } from "./usePreviewErrors.js";
import type { ChatMessage } from "../components/MessageList.js";
import type { StreamingActivity } from "../components/StreamingIndicator.js";
import type { GitCommit } from "../components/GitHistory.js";
import type { FileTreeNode } from "../components/FileTree.js";
import type { LogEntry, TerminalMode } from "../components/TerminalPanel.js";
import type { TemplateInfo } from "../components/TemplateSelector.js";
import type { SessionUsage, TurnTokenData } from "../components/UsageModal.js";
import type { ModelInfo } from "../components/StatusBar.js";
import type { DeployPhase } from "../components/DeployModal.js";
import type { ThreadInfo } from "../components/ThreadIndicator.js";
import type { AgentOption } from "../components/AgentPicker.js";
import type {
  WsClientMessage, FeatureInfo, DeployTargetInfo, DeploymentRecord,
  PermissionMode, FileContextRef, AgentId, SessionInfo,
} from "../../server/types.js";
import type { UsageStats } from "../components/UsageModal.js";
import type { ToastData } from "../components/Toast.js";
import { savePermissionMode, saveAgentId } from "../utils/local-storage.js";
import { useApi } from "./useApi.js";

import type { TurnDiffData } from "../components/DiffPanel.js";

type RightTab = "preview" | "docs" | "files" | "terminal" | "features" | "changes";

export function useAppCallbacks(params: {
  send: (msg: WsClientMessage) => void;
  navigate: ReturnType<typeof useNavigate>;
  requestPermission: () => void;

  // State
  permissionMode: PermissionMode;
  pendingFiles: FileContextRef[];
  activeThreadId: string;
  templates: TemplateInfo[];
  docFiles: string[];
  agentList: AgentOption[];
  activeAgentId: AgentId;
  githubStatus: { authenticated: boolean; username?: string; avatarUrl?: string };

  // State setters
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setActivity: Dispatch<SetStateAction<StreamingActivity | undefined>>;
  setShowTemplates: Dispatch<SetStateAction<boolean>>;
  setPendingFiles: Dispatch<SetStateAction<FileContextRef[]>>;
  setPermissionMode: Dispatch<SetStateAction<PermissionMode>>;
  setViewingFile: Dispatch<SetStateAction<string | null>>;
  setViewingFileContent: Dispatch<SetStateAction<string | null>>;
  setViewingFileBinary: Dispatch<SetStateAction<boolean>>;
  setGitCommits: Dispatch<SetStateAction<GitCommit[]>>;
  setFileTree: Dispatch<SetStateAction<FileTreeNode[]>>;
  setCurrentSessionUsage: Dispatch<SetStateAction<SessionUsage | null>>;
  setModelInfo: Dispatch<SetStateAction<ModelInfo | null>>;
  setContextTokens: Dispatch<SetStateAction<number>>;
  setTurnTokens: Dispatch<SetStateAction<TurnTokenData[]>>;
  setSelectedRepoUrl: Dispatch<SetStateAction<string | null>>;
  setCreatingRepo: Dispatch<SetStateAction<boolean>>;
  setThreads: Dispatch<SetStateAction<ThreadInfo[]>>;
  setActiveThreadId: Dispatch<SetStateAction<string>>;
  setShellStarted: Dispatch<SetStateAction<boolean>>;
  setTerminalMode: Dispatch<SetStateAction<TerminalMode>>;
  setSelectedDoc: Dispatch<SetStateAction<string | null>>;
  setDocContent: Dispatch<SetStateAction<string | null>>;
  setRightTab: Dispatch<SetStateAction<RightTab>>;
  setFileChangeCount: Dispatch<SetStateAction<number>>;
  setUnreadLogCount: Dispatch<SetStateAction<number>>;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setInitialSettingsTab: Dispatch<SetStateAction<"agent" | "github" | "git" | "instructions" | "advanced" | "deploy" | undefined>>;
  setShowDeployModal: Dispatch<SetStateAction<boolean>>;
  setDeployStatus: Dispatch<SetStateAction<DeployPhase | null>>;
  setLastDeployUrl: Dispatch<SetStateAction<string | null>>;
  setLastDeployError: Dispatch<SetStateAction<string | null>>;
  setShowPRModal: Dispatch<SetStateAction<boolean>>;
  setPrResult: Dispatch<SetStateAction<{ success: boolean; url?: string; number?: number; message?: string } | null>>;
  setPrDescGenerating: Dispatch<SetStateAction<boolean>>;
  setPrDescError: Dispatch<SetStateAction<string | null>>;
  setPrGeneratedDesc: Dispatch<SetStateAction<string | null>>;
  setShowUsageModal: Dispatch<SetStateAction<boolean>>;
  setLogEntries: Dispatch<SetStateAction<LogEntry[]>>;
  setActiveAgentId: Dispatch<SetStateAction<AgentId>>;
  setQueuedMessages: Dispatch<SetStateAction<Array<{ text: string; position: number }>>>;
  setMobilePanel: Dispatch<SetStateAction<"chat" | "preview">>;
  setAutoFixEnabled: Dispatch<SetStateAction<boolean>>;
  setHasSystemPrompt: Dispatch<SetStateAction<boolean>>;
  setSelectedPort: Dispatch<SetStateAction<number | null>>;
  setPrCurrentBranch: Dispatch<SetStateAction<string>>;
  setPrRemoteBranches: Dispatch<SetStateAction<string[]>>;
  setTurnDiff: Dispatch<SetStateAction<TurnDiffData | null>>;
  setLastCommitPair: Dispatch<SetStateAction<{ from: string; to: string } | null>>;
  setDiffBadgeCount: Dispatch<SetStateAction<number>>;
  setDocFiles: Dispatch<SetStateAction<string[]>>;
  setImportSearchResults: Dispatch<SetStateAction<Array<{ fullName: string; description: string | null; private: boolean; defaultBranch: string; cloneUrl: string }>>>;
  setAllUsageStats: Dispatch<SetStateAction<UsageStats | null>>;
  setDeployHistory: Dispatch<SetStateAction<DeploymentRecord[]>>;
  setDeployTargets: Dispatch<SetStateAction<DeployTargetInfo[]>>;
  setDeployConfigStatus: Dispatch<SetStateAction<Record<string, { configured: boolean; projectName?: string }>>>;
  setFeatures: Dispatch<SetStateAction<FeatureInfo[]>>;
  setSessions: Dispatch<SetStateAction<SessionInfo[]>>;
  setGitIdentityNeeded: Dispatch<SetStateAction<boolean>>;
  setGitIdentity: Dispatch<SetStateAction<{ name: string; email: string }>>;
  setGithubStatus: Dispatch<SetStateAction<{ authenticated: boolean; username?: string; avatarUrl?: string }>>;
  setSystemPromptContent: Dispatch<SetStateAction<string>>;
  setToast: Dispatch<SetStateAction<ToastData | null>>;
  setAgentList: Dispatch<SetStateAction<AgentOption[]>>;
  lastCommitPair: { from: string; to: string } | null;
  turnDiff: TurnDiffData | null;

  // Refs
  sessionIdRef: MutableRefObject<string | undefined>;
  prDescGeneratingRef: MutableRefObject<boolean>;
  autoFixRetriesRef: MutableRefObject<number>;

  // Auto-fix helpers
  disableAutoFix: () => void;

  // Derived
  setAutoFixRetries: Dispatch<SetStateAction<number>>;
}) {
  const {
    send, navigate: nav, requestPermission,
    permissionMode, pendingFiles, activeThreadId, templates, docFiles,
    setMessages, setIsLoading, setActivity, setShowTemplates, setPendingFiles,
    setPermissionMode, setViewingFile, setViewingFileContent, setViewingFileBinary,
    setGitCommits, setFileTree, setCurrentSessionUsage, setModelInfo, setContextTokens, setTurnTokens,
    setSelectedRepoUrl, setCreatingRepo, setThreads, setActiveThreadId, setShellStarted, setTerminalMode,
    setSelectedDoc, setDocContent, setRightTab, setFileChangeCount, setUnreadLogCount,
    setSettingsOpen, setInitialSettingsTab, setShowDeployModal, setDeployStatus, setLastDeployUrl, setLastDeployError,
    setShowPRModal, setPrResult, setPrDescGenerating, setPrDescError, setPrGeneratedDesc,
    setShowUsageModal, setLogEntries, setActiveAgentId, setQueuedMessages, setMobilePanel,
    sessionIdRef, prDescGeneratingRef,
    disableAutoFix,
    setSelectedPort, setPrCurrentBranch, setPrRemoteBranches,
    setTurnDiff, setLastCommitPair, setDiffBadgeCount,
    setDocFiles, setImportSearchResults, setAllUsageStats,
    setDeployHistory, setDeployTargets, setDeployConfigStatus, setFeatures,
    lastCommitPair, turnDiff,
    setSessions, setGitIdentityNeeded, setGitIdentity, setGithubStatus, setSystemPromptContent, setToast, setAgentList,
    setHasSystemPrompt, setAutoFixRetries: _setAutoFixRetries,
  } = params;

  const { get: apiGet, post: apiPost, patch: apiPatch, del: apiDel, put: apiPut } = useApi();

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
      // Load persisted chat history for this session (also activates session on server).
      // The server sends git_log and file_tree automatically after activation completes,
      // so we must NOT send separate get_git_log / get_file_tree here — those would
      // race with the async activateSession and return stale data from the previous session.
      send({ type: "get_chat_history", sessionId });
    },
    [send, sessionIdRef, setMessages, setIsLoading, setShowTemplates, setQueuedMessages,
     setViewingFile, setViewingFileContent, setViewingFileBinary,
     setGitCommits, setFileTree, setCurrentSessionUsage, setModelInfo, setContextTokens, setTurnTokens,
     setThreads, setActiveThreadId, setShellStarted, setTerminalMode]
  );

  // Public session resume — also navigates to update the URL
  const handleSessionResume = useCallback(
    (sessionId: string) => {
      resumeSessionInternal(sessionId);
      nav(`/session/${sessionId}`);
    },
    [resumeSessionInternal, nav]
  );

  const handleSend = useCallback(
    (text: string, images?: Array<{ data: string; mediaType: string; filename: string }>) => {
      requestPermission();
      setShowTemplates(false);
      // Kill switch: any user message cancels auto-fix mode
      disableAutoFix();
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
    [send, requestPermission, permissionMode, pendingFiles, sessionIdRef, disableAutoFix,
     setShowTemplates, setMessages, setIsLoading, setActivity, setPendingFiles]
  );

  const handleInterrupt = useCallback(() => {
    send({ type: "interrupt_claude" });
    // Don't set isLoading = false yet — wait for server confirmation
  }, [send]);

  const handleEditMessage = useCallback(
    (messageIndex: number, newText: string) => {
      requestPermission();
      // Auto-checkpoint before edit so the user can return to the pre-edit state
      if (sessionIdRef.current && activeThreadId) {
        apiPost(`/api/sessions/${sessionIdRef.current}/threads/checkpoint`, { label: "Before edit" }).catch(() => {});
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
    [send, requestPermission, activeThreadId, permissionMode, sessionIdRef, setMessages, setIsLoading, setActivity, apiPost]
  );

  const handleGitRefresh = useCallback(() => {
    if (!sessionIdRef.current) return;
    apiGet<{ commits: GitCommit[] }>(`/api/sessions/${sessionIdRef.current}/git/log`)
      .then((d) => setGitCommits(d.commits))
      .catch((err) => console.error("[api] Failed to fetch git log:", err));
  }, [apiGet, sessionIdRef, setGitCommits]);

  const handleRollback = useCallback(
    async (hash: string) => {
      if (!sessionIdRef.current) return;
      try {
        await apiPost(`/api/sessions/${sessionIdRef.current}/git/rollback`, { commitHash: hash });
        const data = await apiGet<{ commits: GitCommit[] }>(`/api/sessions/${sessionIdRef.current}/git/log`);
        setGitCommits(data.commits);
      } catch (err) {
        console.error("[api] Rollback failed:", err);
      }
    },
    [apiPost, apiGet, sessionIdRef, setGitCommits]
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
    nav("/");
    send({ type: "new_session" });
    // Request templates for the picker
    if (templates.length === 0) {
      send({ type: "list_templates" });
    }
  }, [send, templates.length, nav, sessionIdRef,
      setMessages, setIsLoading, setCurrentSessionUsage, setModelInfo, setContextTokens, setTurnTokens,
      setShowTemplates, setSelectedRepoUrl, setViewingFile, setViewingFileContent, setViewingFileBinary,
      setGitCommits, setFileTree, setThreads, setActiveThreadId, setShellStarted, setTerminalMode]);

  const handleSessionArchive = useCallback(
    async (sessionId: string) => {
      try {
        const result = await apiDel<{ sessions: SessionInfo[] }>(`/api/sessions/${sessionId}`);
        setSessions(result.sessions);
        if (sessionId === sessionIdRef.current) {
          sessionIdRef.current = undefined;
          nav("/");
        }
      } catch (err) {
        console.error("[api] Archive session failed:", err);
      }
    },
    [apiDel, setSessions, sessionIdRef, nav]
  );

  const handleSessionRename = useCallback(
    async (sessionId: string, title: string) => {
      try {
        const result = await apiPatch<{ session: SessionInfo }>(`/api/sessions/${sessionId}`, { title });
        setSessions((prev) => prev.map((s) => (s.id === result.session.id ? result.session : s)));
      } catch (err) {
        console.error("[api] Rename session failed:", err);
      }
    },
    [apiPatch, setSessions]
  );

  const handleDocRefresh = useCallback(() => {
    if (!sessionIdRef.current) return;
    apiGet<{ files: string[] }>(`/api/sessions/${sessionIdRef.current}/docs`)
      .then((d) => setDocFiles(d.files))
      .catch((err) => console.error("[api] Failed to fetch docs:", err));
  }, [apiGet, sessionIdRef, setDocFiles]);

  const handleSelectPort = useCallback((port: number) => {
    setSelectedPort(port);
  }, [setSelectedPort]);

  const handleFileTreeRefresh = useCallback(() => {
    if (!sessionIdRef.current) return;
    apiGet<{ tree: FileTreeNode[] }>(`/api/sessions/${sessionIdRef.current}/files`)
      .then((d) => setFileTree(d.tree))
      .catch((err) => console.error("[api] Failed to fetch file tree:", err));
  }, [apiGet, sessionIdRef, setFileTree]);

  const handleFileClick = useCallback(
    (filePath: string) => {
      setViewingFile(filePath);
      setViewingFileContent(null);
      setViewingFileBinary(false);
      if (!sessionIdRef.current) return;
      apiGet<{ content: string; isBinary?: boolean }>(`/api/sessions/${sessionIdRef.current}/files/${filePath}`)
        .then((d) => {
          setViewingFileContent(d.content);
          setViewingFileBinary(d.isBinary ?? false);
        })
        .catch((err) => console.error("[api] Failed to fetch file content:", err));
    },
    [apiGet, sessionIdRef, setViewingFile, setViewingFileContent, setViewingFileBinary]
  );

  const handleFileViewerClose = useCallback(() => {
    setViewingFile(null);
    setViewingFileContent(null);
    setViewingFileBinary(false);
  }, [setViewingFile, setViewingFileContent, setViewingFileBinary]);

  const handleDocSelect = useCallback(
    (filePath: string) => {
      setSelectedDoc(filePath);
      setDocContent(null);
      if (!sessionIdRef.current) return;
      apiGet<{ content: string }>(`/api/sessions/${sessionIdRef.current}/docs/${filePath}`)
        .then((d) => setDocContent(d.content))
        .catch((err) => console.error("[api] Failed to fetch doc:", err));
    },
    [apiGet, sessionIdRef, setSelectedDoc, setDocContent]
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
    [send, setMessages, setIsLoading, setActivity]
  );

  const handleGitIdentitySubmit = useCallback(
    async (name: string, email: string) => {
      try {
        const result = await apiPost<{ name: string; email: string }>("/api/settings/git-identity", { name, email });
        setGitIdentityNeeded(false);
        setGitIdentity({ name: result.name, email: result.email });
      } catch (err) {
        console.error("[api] Set git identity failed:", err);
      }
    },
    [apiPost, setGitIdentityNeeded, setGitIdentity],
  );

  const handleGitHubTokenSubmit = useCallback(
    async (token: string) => {
      try {
        const result = await apiPost<{
          status: { authenticated: boolean; username?: string; avatarUrl?: string };
          repos: Array<{ fullName: string; description: string | null; private: boolean; defaultBranch: string; cloneUrl: string }>;
        }>("/api/github/token", { token });
        setGithubStatus(result.status);
        setImportSearchResults(result.repos);
      } catch (err) {
        console.error("[api] Set GitHub token failed:", err);
      }
    },
    [apiPost, setGithubStatus, setImportSearchResults],
  );

  const handleGitHubLogout = useCallback(async () => {
    try {
      const result = await apiPost<{ status: { authenticated: boolean; username?: string; avatarUrl?: string } }>("/api/github/logout");
      setGithubStatus(result.status);
    } catch (err) {
      console.error("[api] GitHub logout failed:", err);
    }
  }, [apiPost, setGithubStatus]);

  const handleHomeCreateRepo = useCallback(
    (name: string, description: string, isPrivate: boolean, templateId: string) => {
      setCreatingRepo(true);
      send({ type: "home_create_repo_with_template", repoName: name, description, isPrivate, templateId });
    },
    [send, setCreatingRepo],
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
    [send, requestPermission, permissionMode, pendingFiles,
     setShowTemplates, setMessages, setIsLoading, setActivity, setPendingFiles],
  );

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
    [send, requestPermission, permissionMode, sessionIdRef, setShowTemplates, setMessages, setIsLoading, setActivity],
  );

  const handleAddFile = useCallback(
    (filePath: string) => {
      setPendingFiles((prev) => {
        // Deduplicate by path
        if (prev.some((f) => f.path === filePath)) return prev;
        return [...prev, { path: filePath }];
      });
    },
    [setPendingFiles],
  );

  const handleRemoveFile = useCallback(
    (index: number) => {
      setPendingFiles((prev) => prev.filter((_, i) => i !== index));
    },
    [setPendingFiles],
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
  }, [setPrResult, setPrCurrentBranch, setPrRemoteBranches, setPrDescGenerating, prDescGeneratingRef, setPrDescError, setPrGeneratedDesc, setShowPRModal]);

  const handlePRGenerateDescription = useCallback(() => {
    setPrDescGenerating(true);
    prDescGeneratingRef.current = true;
    setPrDescError(null);
    setPrGeneratedDesc(null);
    send({ type: "generate_pr_description" });
  }, [send, setPrDescGenerating, prDescGeneratingRef, setPrDescError, setPrGeneratedDesc]);

  const handlePRSubmit = useCallback(
    async (data: { title: string; body: string; base: string; draft: boolean }) => {
      if (!sessionIdRef.current) return;
      try {
        const result = await apiPost<{ success: boolean; url?: string; number?: number; message?: string }>(
          `/api/sessions/${sessionIdRef.current}/pr`,
          { title: data.title, body: data.body, base: data.base, draft: data.draft },
        );
        setPrResult(result);
      } catch (err) {
        console.error("[api] Create PR failed:", err);
      }
    },
    [apiPost, sessionIdRef, setPrResult],
  );

  const handlePRRequestBranches = useCallback(() => {
    if (!sessionIdRef.current) return;
    apiGet<{ current: string; remote: string[] }>(`/api/sessions/${sessionIdRef.current}/git/branches`)
      .then((d) => {
        setPrCurrentBranch(d.current);
        setPrRemoteBranches(d.remote);
      })
      .catch((err) => console.error("[api] Failed to fetch branches:", err));
  }, [apiGet, sessionIdRef, setPrCurrentBranch, setPrRemoteBranches]);

  const handleUsageBadgeClick = useCallback(() => {
    setShowUsageModal(true);
    if (!sessionIdRef.current) return;
    apiGet<{ stats: UsageStats }>(`/api/sessions/${sessionIdRef.current}/usage`)
      .then((d) => setAllUsageStats(d.stats))
      .catch((err) => console.error("[api] Failed to fetch usage stats:", err));
  }, [apiGet, sessionIdRef, setShowUsageModal, setAllUsageStats]);

  const handleSettingsOpen = useCallback(async (tab?: "agent" | "github" | "git" | "instructions" | "advanced" | "deploy") => {
    setInitialSettingsTab(tab);
    setSettingsOpen(true);
    try {
      const data = await apiGet<{ settings: { gitIdentity: { name: string; email: string }; systemPrompt: string; agents: AgentOption[]; defaultAgentId: AgentId } }>("/api/bootstrap");
      setGitIdentity(data.settings.gitIdentity);
      setSystemPromptContent(data.settings.systemPrompt);
      setHasSystemPrompt(data.settings.systemPrompt.length > 0);
      setAgentList(data.settings.agents);
    } catch (err) {
      console.error("[api] Failed to fetch settings:", err);
    }
  }, [apiGet, setInitialSettingsTab, setSettingsOpen, setGitIdentity, setSystemPromptContent, setHasSystemPrompt, setAgentList]);

  const handleDeployTabSelected = useCallback(() => {
    if (!sessionIdRef.current) return;
    apiGet<{ targets: DeployTargetInfo[]; projectSettings: Record<string, { configured: boolean; projectName?: string }> }>(
      `/api/sessions/${sessionIdRef.current}/deploy/setup`,
    )
      .then((d) => {
        setDeployTargets(d.targets);
        setDeployConfigStatus(d.projectSettings);
      })
      .catch((err) => console.error("[api] Failed to fetch deploy setup:", err));
  }, [apiGet, sessionIdRef, setDeployTargets, setDeployConfigStatus]);

  const handleInstructionsSave = useCallback(
    async (content: string) => {
      try {
        const result = await apiPut<{ systemPrompt: string }>("/api/settings", { systemPrompt: content });
        setSystemPromptContent(result.systemPrompt);
        setHasSystemPrompt(result.systemPrompt.length > 0);
      } catch (err) {
        console.error("[api] Save settings failed:", err);
      }
      setSettingsOpen(false);
    },
    [apiPut, setSettingsOpen, setSystemPromptContent, setHasSystemPrompt],
  );

  const handleCreateCheckpoint = useCallback(
    async (label?: string) => {
      if (!sessionIdRef.current) return;
      try {
        const result = await apiPost<{ checkpoint: ThreadInfo["checkpoints"][number]; threadId: string }>(
          `/api/sessions/${sessionIdRef.current}/threads/checkpoint`,
          { label },
        );
        setThreads((prev) =>
          prev.map((t) =>
            t.id === result.threadId
              ? { ...t, checkpoints: [...t.checkpoints, result.checkpoint] }
              : t,
          ),
        );
      } catch (err) {
        console.error("[api] Create checkpoint failed:", err);
      }
    },
    [apiPost, sessionIdRef, setThreads],
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
    setDeployStatus(null);
    setLastDeployUrl(null);
    setLastDeployError(null);
    setShowDeployModal(true);
    if (!sessionIdRef.current) return;
    apiGet<{ targets: DeployTargetInfo[]; projectSettings: Record<string, { configured: boolean; projectName?: string }> }>(
      `/api/sessions/${sessionIdRef.current}/deploy/setup`,
    )
      .then((d) => {
        setDeployTargets(d.targets);
        setDeployConfigStatus(d.projectSettings);
      })
      .catch((err) => console.error("[api] Failed to fetch deploy setup:", err));
  }, [apiGet, sessionIdRef, setDeployStatus, setLastDeployUrl, setLastDeployError, setShowDeployModal, setDeployTargets, setDeployConfigStatus]);

  const handleDeployConfigure = useCallback(
    async (targetId: string, credentials: Record<string, string>, projectName?: string) => {
      if (!sessionIdRef.current) return;
      try {
        await apiPost(`/api/sessions/${sessionIdRef.current}/deploy/config`, { targetId, credentials, projectName });
        // Refresh deploy setup
        const setup = await apiGet<{ targets: DeployTargetInfo[]; projectSettings: Record<string, { configured: boolean; projectName?: string }> }>(
          `/api/sessions/${sessionIdRef.current}/deploy/setup`,
        );
        setDeployTargets(setup.targets);
        setDeployConfigStatus(setup.projectSettings);
      } catch (err) {
        console.error("[api] Deploy configure failed:", err);
      }
    },
    [apiPost, apiGet, sessionIdRef, setDeployTargets, setDeployConfigStatus],
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
    if (!sessionIdRef.current) return;
    apiGet<{ deployments: DeploymentRecord[] }>(`/api/sessions/${sessionIdRef.current}/deploy/history`)
      .then((d) => setDeployHistory(d.deployments))
      .catch((err) => console.error("[api] Failed to fetch deploy history:", err));
  }, [apiGet, sessionIdRef, setDeployHistory]);

  const handleDeployDeleteConfig = useCallback(
    async (targetId: string) => {
      if (!sessionIdRef.current) return;
      try {
        await apiDel(`/api/sessions/${sessionIdRef.current}/deploy/config/${targetId}`);
        // Refresh deploy setup
        const setup = await apiGet<{ targets: DeployTargetInfo[]; projectSettings: Record<string, { configured: boolean; projectName?: string }> }>(
          `/api/sessions/${sessionIdRef.current}/deploy/setup`,
        );
        setDeployTargets(setup.targets);
        setDeployConfigStatus(setup.projectSettings);
      } catch (err) {
        console.error("[api] Deploy delete config failed:", err);
      }
    },
    [apiDel, apiGet, sessionIdRef, setDeployTargets, setDeployConfigStatus],
  );

  const handleDeploySendError = useCallback(
    (errorMessage: string) => {
      setShowDeployModal(false);
      handleSend(`The deployment failed with this error:\n\n${errorMessage}\n\nPlease fix the issue and explain what went wrong.`);
    },
    [handleSend, setShowDeployModal],
  );

  const handleFullReset = useCallback(async () => {
    try {
      await apiPost("/api/reset");
      // Server broadcasts full_reset_complete via WS — client reloads on that message
    } catch (err) {
      console.error("[api] Full reset failed:", err);
    }
  }, [apiPost]);

  const handleFeatureRefresh = useCallback(() => {
    apiGet<{ features: FeatureInfo[] }>("/api/features")
      .then((d) => setFeatures(d.features))
      .catch((err) => console.error("[api] Failed to fetch features:", err));
  }, [apiGet, setFeatures]);

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
    [send, requestPermission, sessionIdRef,
     setMessages, setIsLoading, setActivity, setCurrentSessionUsage, setModelInfo, setContextTokens, setTurnTokens,
     setShowTemplates, setViewingFile, setViewingFileContent, setViewingFileBinary,
     setGitCommits, setFileTree, setThreads, setActiveThreadId, setMobilePanel],
  );

  const handleImportSearch = useCallback(
    (query: string) => {
      apiGet<{ repos: Array<{ fullName: string; description: string | null; private: boolean; defaultBranch: string; cloneUrl: string }> }>(
        `/api/github/repos?q=${encodeURIComponent(query)}`,
      )
        .then((d) => setImportSearchResults(d.repos))
        .catch((err) => console.error("[api] Failed to search repos:", err));
    },
    [apiGet, setImportSearchResults],
  );

  const handleMergePr = useCallback(
    async (method: "merge" | "squash" | "rebase") => {
      if (!sessionIdRef.current) return;
      try {
        const result = await apiPost<{ success: boolean; message: string; autoMergeEnabled?: boolean }>(
          `/api/sessions/${sessionIdRef.current}/pr/merge`,
          { method },
        );
        if (result.success && !result.autoMergeEnabled) {
          // Merge succeeded — show toast
          setToast({ message: "Pull request merged" });
        }
      } catch (err) {
        console.error("[api] Merge PR failed:", err);
      }
    },
    [apiPost, sessionIdRef, setToast],
  );

  const handlePermissionModeChange = useCallback((mode: PermissionMode) => {
    setPermissionMode(mode);
    savePermissionMode(mode);
  }, [setPermissionMode]);

  const handleAgentChange = useCallback(async (agentId: AgentId) => {
    setActiveAgentId(agentId);
    saveAgentId(agentId);
    try {
      await apiPost("/api/settings/agent", { agentId });
    } catch (err) {
      console.error("[api] Set agent failed:", err);
    }
  }, [apiPost, setActiveAgentId]);

  const handleClearLogs = useCallback(() => {
    setLogEntries([]);
    send({ type: "clear_logs" });
  }, [send, setLogEntries]);

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
  }, [send, setShellStarted]);

  const handleTerminalModeChange = useCallback((mode: TerminalMode) => {
    setTerminalMode(mode);
  }, [setTerminalMode]);

  // Request data when switching to docs or files tab
  const handleTabChange = useCallback(
    (tab: RightTab) => {
      setRightTab(tab);
      if (tab === "docs" && docFiles.length === 0 && sessionIdRef.current) {
        apiGet<{ files: string[] }>(`/api/sessions/${sessionIdRef.current}/docs`)
          .then((d) => setDocFiles(d.files))
          .catch((err) => console.error("[api] Failed to fetch docs:", err));
      }
      if (tab === "files" && sessionIdRef.current) {
        apiGet<{ tree: FileTreeNode[] }>(`/api/sessions/${sessionIdRef.current}/files`)
          .then((d) => setFileTree(d.tree))
          .catch((err) => console.error("[api] Failed to fetch file tree:", err));
        setFileChangeCount(0);
      }
      if (tab === "terminal") {
        setUnreadLogCount(0);
      }
      if (tab === "features") {
        apiGet<{ features: FeatureInfo[] }>("/api/features")
          .then((d) => setFeatures(d.features))
          .catch((err) => console.error("[api] Failed to fetch features:", err));
      }
      if (tab === "changes") {
        setDiffBadgeCount(0);
        // Lazy-load the diff if we have a commit pair but haven't loaded it yet
        if (lastCommitPair && !turnDiff && sessionIdRef.current) {
          apiGet<TurnDiffData>(`/api/sessions/${sessionIdRef.current}/git/diff?from=${encodeURIComponent(lastCommitPair.from)}&to=${encodeURIComponent(lastCommitPair.to)}`)
            .then((d) => setTurnDiff(d))
            .catch((err) => console.error("[api] Failed to fetch diff:", err));
        }
      }
    },
    [apiGet, sessionIdRef, docFiles.length, setRightTab, setFileChangeCount, setUnreadLogCount, setDiffBadgeCount,
     setDocFiles, setFileTree, setFeatures, setTurnDiff, lastCommitPair, turnDiff]
  );

  const handleDiffAcceptAll = useCallback(() => {
    // Changes are already committed — just dismiss the panel
    setTurnDiff(null);
    setLastCommitPair(null);
    setDiffBadgeCount(0);
    setRightTab("preview");
  }, [setTurnDiff, setLastCommitPair, setDiffBadgeCount, setRightTab]);

  const handleDiffRejectFiles = useCallback(
    async (files: string[]) => {
      if (!lastCommitPair || !sessionIdRef.current) return;
      try {
        await apiPost(`/api/sessions/${sessionIdRef.current}/git/reject`, {
          fromCommit: lastCommitPair.from,
          files,
        });
        // Clear diff data and refresh workspace state
        setTurnDiff(null);
        setLastCommitPair(null);
        setDiffBadgeCount(0);
        setRightTab("preview");
        const workspace = await apiGet<{ gitLog: GitCommit[]; fileTree: FileTreeNode[] }>(
          `/api/sessions/${sessionIdRef.current}/workspace-state`,
        );
        setGitCommits(workspace.gitLog);
        setFileTree(workspace.fileTree);
      } catch (err) {
        console.error("[api] Reject changes failed:", err);
      }
    },
    [apiPost, apiGet, lastCommitPair, sessionIdRef, setTurnDiff, setLastCommitPair, setDiffBadgeCount, setRightTab, setGitCommits, setFileTree],
  );

  const handleDiffClose = useCallback(() => {
    setRightTab("preview");
  }, [setRightTab]);

  return {
    resumeSessionInternal,
    handleSessionResume,
    handleSend,
    handleInterrupt,
    handleEditMessage,
    handleGitRefresh,
    handleRollback,
    handleSessionRefresh,
    handleSessionNew,
    handleSessionArchive,
    handleSessionRename,
    handleDocRefresh,
    handleSelectPort,
    handleFileTreeRefresh,
    handleFileClick,
    handleFileViewerClose,
    handleDocSelect,
    handleAnswerQuestion,
    handleGitIdentitySubmit,
    handleGitHubTokenSubmit,
    handleGitHubLogout,
    handleHomeCreateRepo,
    handleHomeSendWithRepo,
    handleSendErrors,
    handleAddFile,
    handleRemoveFile,
    handlePROpen,
    handlePRGenerateDescription,
    handlePRSubmit,
    handlePRRequestBranches,
    handleUsageBadgeClick,
    handleSettingsOpen,
    handleDeployTabSelected,
    handleInstructionsSave,
    handleCreateCheckpoint,
    handleForkThread,
    handleSwitchThread,
    handleDeployOpen,
    handleDeployConfigure,
    handleDeployInitiate,
    handleDeployCancel,
    handleCancelQueued,
    handleDeployGetHistory,
    handleDeployDeleteConfig,
    handleDeploySendError,
    handleFullReset,
    handleFeatureRefresh,
    handleFeatureStartSession,
    handleImportSearch,
    handleMergePr,
    handlePermissionModeChange,
    handleAgentChange,
    handleClearLogs,
    handleTerminalInput,
    handleTerminalResize,
    handleTerminalStart,
    handleTerminalModeChange,
    handleTabChange,
    handleDiffAcceptAll,
    handleDiffRejectFiles,
    handleDiffClose,
  };
}
