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
  WsClientMessage, FeatureInfo,
  PermissionMode, FileContextRef, AgentId,
} from "../../server/types.js";
import { savePermissionMode, saveAgentId } from "../utils/local-storage.js";

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
    lastCommitPair, turnDiff,
  } = params;

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
    [send, requestPermission, activeThreadId, permissionMode, sessionIdRef, setMessages, setIsLoading, setActivity]
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
  }, [setSelectedPort]);

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
    [send, setViewingFile, setViewingFileContent, setViewingFileBinary]
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
      send({ type: "get_doc", path: filePath });
    },
    [send, setSelectedDoc, setDocContent]
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
  }, [send, setShowUsageModal]);

  const handleSettingsOpen = useCallback((tab?: "agent" | "github" | "git" | "instructions" | "advanced" | "deploy") => {
    send({ type: "get_global_settings" });
    setInitialSettingsTab(tab);
    setSettingsOpen(true);
  }, [send, setInitialSettingsTab, setSettingsOpen]);

  const handleDeployTabSelected = useCallback(() => {
    send({ type: "list_deploy_targets" });
    send({ type: "get_project_settings" });
  }, [send]);

  const handleInstructionsSave = useCallback(
    (content: string) => {
      send({ type: "save_global_settings", systemPrompt: content });
      setSettingsOpen(false);
    },
    [send, setSettingsOpen],
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
    send({ type: "get_project_settings" });
    setDeployStatus(null);
    setLastDeployUrl(null);
    setLastDeployError(null);
    setShowDeployModal(true);
  }, [send, setDeployStatus, setLastDeployUrl, setLastDeployError, setShowDeployModal]);

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
    [handleSend, setShowDeployModal],
  );

  const handleFullReset = useCallback(() => {
    send({ type: "full_reset" });
  }, [send]);

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
    [send, requestPermission, sessionIdRef,
     setMessages, setIsLoading, setActivity, setCurrentSessionUsage, setModelInfo, setContextTokens, setTurnTokens,
     setShowTemplates, setViewingFile, setViewingFileContent, setViewingFileBinary,
     setGitCommits, setFileTree, setThreads, setActiveThreadId, setMobilePanel],
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
  }, [setPermissionMode]);

  const handleAgentChange = useCallback((agentId: AgentId) => {
    setActiveAgentId(agentId);
    saveAgentId(agentId);
    send({ type: "set_agent", agentId });
  }, [send, setActiveAgentId]);

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
      if (tab === "changes") {
        setDiffBadgeCount(0);
        // Lazy-load the diff if we have a commit pair but haven't loaded it yet
        if (lastCommitPair && !turnDiff) {
          send({ type: "get_turn_diff", fromCommit: lastCommitPair.from, toCommit: lastCommitPair.to });
        }
      }
    },
    [send, docFiles.length, setRightTab, setFileChangeCount, setUnreadLogCount, setDiffBadgeCount, lastCommitPair, turnDiff]
  );

  const handleDiffAcceptAll = useCallback(() => {
    // Changes are already committed — just dismiss the panel
    setTurnDiff(null);
    setLastCommitPair(null);
    setDiffBadgeCount(0);
    setRightTab("preview");
  }, [setTurnDiff, setLastCommitPair, setDiffBadgeCount, setRightTab]);

  const handleDiffRejectFiles = useCallback(
    (files: string[]) => {
      if (!lastCommitPair) return;
      send({ type: "reject_changes", fromCommit: lastCommitPair.from, files });
      setRightTab("preview");
    },
    [send, lastCommitPair, setRightTab],
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
