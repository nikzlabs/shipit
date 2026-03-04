import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useSessionWebSocket } from "./hooks/useSessionWebSocket.js";
import { useServerEvents } from "./hooks/useServerEvents.js";
import { useResizablePanel } from "./hooks/useResizablePanel.js";
import { useSearch } from "./hooks/useSearch.js";
import { useIsMobile } from "./hooks/useMediaQuery.js";
import { useNotification } from "./hooks/useNotification.js";
import { useTheme } from "./hooks/useTheme.js";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts.js";
import { useConnectionSync } from "./hooks/useConnectionSync.js";
import { useAutoFix } from "./hooks/useAutoFix.js";
import { useMessageHandler } from "./hooks/useMessageHandler.js";
import { useApi } from "./hooks/useApi.js";
import { formatErrorForMessage } from "./components/PreviewFrame.js";
import { MessageInput } from "./components/MessageInput.js";
import { MessageList, type CheckpointDivider } from "./components/MessageList.js";
import { PreviewFrame } from "./components/PreviewFrame.js";
import { usePreviewErrors, type PreviewError } from "./hooks/usePreviewErrors.js";
import { GitHistory } from "./components/GitHistory.js";
import { AuthOverlay } from "./components/AuthOverlay.js";
import { Settings } from "./components/Settings.js";
import { SessionSidebar } from "./components/SessionSidebar.js";
import { DocsViewer } from "./components/DocsViewer.js";
import { FileTree } from "./components/FileTree.js";
import { FileContentViewer } from "./components/FileContentViewer.js";
import { TerminalPanel } from "./components/TerminalPanel.js";
import { InteractiveTerminal, type InteractiveTerminalHandle } from "./components/InteractiveTerminal.js";
import { ResizeHandle } from "./components/ResizeHandle.js";
import { SearchBar } from "./components/SearchBar.js";
import { ConnectionBanner } from "./components/ConnectionBanner.js";
import { MobileTabBar } from "./components/MobileTabBar.js";
import { KeyboardShortcutsOverlay } from "./components/KeyboardShortcutsOverlay.js";
import { HomeScreen } from "./components/HomeScreen.js";
import { AddRepoDialog } from "./components/AddRepoDialog.js";
import { NewRepoDialog } from "./components/NewRepoDialog.js";
import { UsageModal } from "./components/UsageModal.js";
import { StatusBar } from "./components/StatusBar.js";
import { OnboardingWizard } from "./components/OnboardingWizard.js";
import { ThreadIndicator } from "./components/ThreadIndicator.js";
import { ThreadTimeline } from "./components/ThreadTimeline.js";
import { DeployModal } from "./components/DeployModal.js";
import { FeaturesPanel } from "./components/FeaturesPanel.js";

// eslint-disable-next-line no-restricted-syntax -- lazy() named-export pattern
const DiffPanel = lazy(() => import("./components/DiffPanel.js").then(m => ({ default: m.DiffPanel })));
import { PrLifecycleCard } from "./components/PrLifecycleCard.js";
import { Toast } from "./components/Toast.js";
import { QueueIndicator } from "./components/QueueIndicator.js";
import { AgentPicker, type AgentOption } from "./components/AgentPicker.js";
import type { AgentId } from "../server/shared/types.js";

import { useSessionStore } from "./stores/session-store.js";
import { useGitStore } from "./stores/git-store.js";
import { useFileStore } from "./stores/file-store.js";
import { usePreviewStore } from "./stores/preview-store.js";
import { useTerminalStore } from "./stores/terminal-store.js";
import { useThreadStore } from "./stores/thread-store.js";
import { useDeployStore } from "./stores/deploy-store.js";
import { usePrStore } from "./stores/pr-store.js";
import { useSettingsStore } from "./stores/settings-store.js";
import { useUiStore } from "./stores/ui-store.js";
import { useRepoStore } from "./stores/repo-store.js";
import { resumeSessionInternal, handleSessionResume, newSession, resetSessionState } from "./stores/actions/session-actions.js";
import { parseRepoLabel, repoLabelToNewPath, parseNewSessionSlug } from "./utils/repo-label.js";

export default function App() {
  const { sessionId: urlSessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  // Detect /repo/{slug}/new URL pattern (e.g. /repo/owner/repo/new)
  const newSessionRepoSlug = parseNewSessionSlug(location.pathname);
  const isNewSessionRoute = newSessionRepoSlug !== undefined;

  // SSE for global push (session list, repos, auth, activity dots) — always active
  useServerEvents();

  // ── Store selectors ──
  const sessionId = useSessionStore((s) => s.sessionId);

  // Per-session WS — connects using URL param, or store sessionId when on /{slug}/new route
  const wsSessionId = urlSessionId ?? (isNewSessionRoute ? sessionId : undefined);
  const { send, lastMessage, status, reconnectAttempt, reconnect } = useSessionWebSocket(wsSessionId);
  const { get: apiGet, post: apiPost, put: apiPut, del: apiDel } = useApi();
  const claimAbortRef = useRef<AbortController | null>(null);
  const terminalRef = useRef<InteractiveTerminalHandle>(null);
  const messages = useSessionStore((s) => s.messages);
  const isLoading = useSessionStore((s) => s.isLoading);
  const activity = useSessionStore((s) => s.activity);
  const sessions = useSessionStore((s) => s.sessions);
  const authUrl = useSessionStore((s) => s.authUrl);
  const activeRunnerSessions = useSessionStore((s) => s.activeRunnerSessions);
  const queuedMessages = useSessionStore((s) => s.queuedMessages);

  const gitCommits = useGitStore((s) => s.commits);
  const gitIdentityNeeded = useGitStore((s) => s.identityNeeded);
  const gitIdentity = useGitStore((s) => s.identity);
  const lastCommitPair = useGitStore((s) => s.lastCommitPair);
  const turnDiff = useGitStore((s) => s.turnDiff);
  const historyDiffMode = useGitStore((s) => s.historyDiffMode);

  const fileTree = useFileStore((s) => s.tree);
  const viewingFile = useFileStore((s) => s.viewingFile);
  const viewingFileContent = useFileStore((s) => s.viewingFileContent);
  const viewingFileBinary = useFileStore((s) => s.viewingFileBinary);
  const docFiles = useFileStore((s) => s.docFiles);
  const selectedDoc = useFileStore((s) => s.selectedDoc);
  const docContent = useFileStore((s) => s.docContent);


  const previewStatus = usePreviewStore((s) => s.status);
  const selectedPort = usePreviewStore((s) => s.selectedPort);
  const configMissing = usePreviewStore((s) => s.configMissing);
  const installStatus = usePreviewStore((s) => s.installStatus);
  const crashInfo = usePreviewStore((s) => s.crashInfo);

  const logEntries = useTerminalStore((s) => s.entries);

  const terminalMode = useTerminalStore((s) => s.mode);
  const shellStarted = useTerminalStore((s) => s.shellStarted);

  const threads = useThreadStore((s) => s.threads);
  const activeThreadId = useThreadStore((s) => s.activeThreadId);

  const showDeployModal = useDeployStore((s) => s.showModal);
  const deployTargets = useDeployStore((s) => s.targets);
  const deployConfigStatus = useDeployStore((s) => s.configStatus);
  const deployStatus = useDeployStore((s) => s.status);
  const lastDeployUrl = useDeployStore((s) => s.lastUrl);
  const lastDeployError = useDeployStore((s) => s.lastError);
  const deployHistory = useDeployStore((s) => s.history);

  const importSearchResults = usePrStore((s) => s.importSearchResults);

  const permissionMode = useSettingsStore((s) => s.permissionMode);
  const pendingFiles = useSettingsStore((s) => s.pendingFiles);
  const githubStatus = useSettingsStore((s) => s.githubStatus);
  const hasSystemPrompt = useSettingsStore((s) => s.hasSystemPrompt);
  const systemPromptContent = useSettingsStore((s) => s.systemPromptContent);
  const maxIdleContainers = useSettingsStore((s) => s.maxIdleContainers);

  const rightTab = useUiStore((s) => s.rightTab);
  const mobilePanel = useUiStore((s) => s.mobilePanel);
  const showTemplates = useUiStore((s) => s.showTemplates);
  const templates = useUiStore((s) => s.templates);
  const agentList = useUiStore((s) => s.agentList);
  const activeAgentId = useUiStore((s) => s.activeAgentId);
  const showUsageModal = useUiStore((s) => s.showUsageModal);
  const currentSessionUsage = useUiStore((s) => s.currentSessionUsage);
  const allUsageStats = useUiStore((s) => s.allUsageStats);
  const modelInfo = useUiStore((s) => s.modelInfo);
  const contextTokens = useUiStore((s) => s.contextTokens);
  const turnTokens = useUiStore((s) => s.turnTokens);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const initialSettingsTab = useUiStore((s) => s.initialSettingsTab);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toast = useUiStore((s) => s.toast);

  const features = useUiStore((s) => s.features);
  const bootstrapLoaded = useUiStore((s) => s.bootstrapLoaded);

  const repos = useRepoStore((s) => s.repos);
  const addRepoDialogOpen = useRepoStore((s) => s.addRepoDialogOpen);
  const newRepoDialogOpen = useRepoStore((s) => s.newRepoDialogOpen);

  const creatingRepo = useSessionStore((s) => s.creatingRepo);

  const noAgentReady = agentList.length > 0 && !agentList.some(a => a.installed && a.authConfigured);
  const needsOnboarding = gitIdentityNeeded || noAgentReady;
  const [onboardingActive, setOnboardingActive] = useState(false);

  // Activate onboarding when conditions are met, but don't deactivate
  // automatically — only dismiss when the user clicks "Get Started".
  // This prevents the dialog from closing reactively when e.g. Claude
  // auth completes and noAgentReady flips to false mid-wizard.
  useEffect(() => {
    if (needsOnboarding) {
      setOnboardingActive(true);
    }
  }, [needsOnboarding]);

  const showOnboarding = onboardingActive;

  // ── Non-store hooks ──
  const { fraction, isDragging, onMouseDown, onTouchStart, containerRef } = useResizablePanel({
    initialFraction: 0.5,
    minFraction: 0.25,
    storageKey: "vibe-panel-split",
  });
  const isMobile = useIsMobile();
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Derive the repo URL from the /{slug}/new URL pattern (replaces useState)
  const newSessionRepoUrl = useMemo(() => {
    if (!newSessionRepoSlug) return undefined;
    return repos.find((r) => parseRepoLabel(r.url) === newSessionRepoSlug)?.url;
  }, [newSessionRepoSlug, repos]);
  const search = useSearch(messages);
  const { notify, requestPermission } = useNotification();
  const { theme, toggle: toggleTheme } = useTheme();
  const { errors: previewErrors, clearErrors: clearPreviewErrors } = usePreviewErrors();

  const { autoFixEnabled, autoFixRetries, handleToggleAutoFix, disableAutoFix } = useAutoFix({
    previewErrors,
    isLoading,
    status,
    send,
  });

  useKeyboardShortcuts({
    search,
    searchOpen,
    setSearchOpen: (updater) => setSearchOpen(updater),
    shortcutsOpen,
    setShortcutsOpen: (updater) => setShortcutsOpen(updater),
    isLoading,
    settingsOpen,
    handleInterrupt: () => send({ type: "interrupt_claude" }),
  });

  useConnectionSync({ status, send });

  // Delayed spinner for bootstrap loading gate — only show after 1s
  const [showBootstrapSpinner, setShowBootstrapSpinner] = useState(false);
  useEffect(() => {
    if (bootstrapLoaded) return;
    const timer = setTimeout(() => setShowBootstrapSpinner(true), 1000);
    return () => clearTimeout(timer);
  }, [bootstrapLoaded]);

  useMessageHandler({
    lastMessage,
    send,
    terminalRef,
    notify,
  });

  // Initialize sessionId from URL on mount
  useEffect(() => {
    if (urlSessionId) {
      useSessionStore.getState().setSessionId(urlSessionId);
    }
    if (!urlSessionId && !isNewSessionRoute) {
      useUiStore.getState().setShowTemplates(true);
    }
  }, []);

  // Sync session state when URL changes (back/forward navigation)
  // WS auto-connects/disconnects via useSessionWebSocket(wsSessionId)
  useEffect(() => {
    if (urlSessionId && urlSessionId !== useSessionStore.getState().sessionId) {
      resumeSessionInternal(urlSessionId);
    } else if (!urlSessionId && useSessionStore.getState().sessionId) {
      // Clear stale sessionId — prevents WS from connecting to old session.
      // On /new route, the auto-claim effect will set the correct sessionId.
      useSessionStore.getState().setSessionId(undefined);
      resetSessionState();
      if (!isNewSessionRoute) {
        useUiStore.getState().setShowTemplates(true);
      }
    }
  }, [urlSessionId, isNewSessionRoute]);

  // Auto-claim session when landing on /{slug}/new (direct URL navigation or page refresh)
  useEffect(() => {
    if (!isNewSessionRoute || !newSessionRepoUrl || sessionId) return;
    const ac = new AbortController();
    void (async () => {
      const result = await useRepoStore.getState().claimSession(newSessionRepoUrl, ac.signal);
      if (result && !ac.signal.aborted) useSessionStore.getState().setSessionId(result.sessionId);
    })();
    return () => ac.abort();
  }, [isNewSessionRoute, newSessionRepoUrl, sessionId]);

  // Redirect to home if /{slug}/new doesn't match any known repo
  useEffect(() => {
    if (isNewSessionRoute && !newSessionRepoUrl && bootstrapLoaded && repos.length > 0) {
      navigate("/", { replace: true });
    }
  }, [isNewSessionRoute, newSessionRepoUrl, bootstrapLoaded, repos.length, navigate]);

  // ── Callback helpers ──
  const handleSend = useCallback(
    async (text: string, images?: Array<{ data: string; mediaType: string; filename: string }>) => {
      requestPermission();
      disableAutoFix();
      const session = useSessionStore.getState();
      const settings = useSettingsStore.getState();
      useUiStore.getState().setShowTemplates(false);
      const messageImages = images?.map((img) => ({ data: img.data, mediaType: img.mediaType }));
      const filesForMessage = settings.pendingFiles.length > 0
        ? settings.pendingFiles.map((f) => ({ path: f.path, contentPreview: "" }))
        : undefined;
      session.setMessages((prev) => [...prev, { role: "user", text, images: messageImages, files: filesForMessage }]);
      session.setIsLoading(true);
      session.setActivity({ label: "Thinking..." });

      const currentSessionId = session.sessionId;
      if (currentSessionId) {
        // On /{slug}/new route — graduate: transition URL to /session/{id}
        if (isNewSessionRoute) {
          navigate(`/session/${currentSessionId}`, { replace: true });
        }
        // Send directly over WS
        send({
          type: "send_message",
          text,
          sessionId: currentSessionId,
          images,
          files: settings.pendingFiles.length > 0 ? settings.pendingFiles : undefined,
          permissionMode: settings.permissionMode !== "auto" ? settings.permissionMode : undefined,
        });
      } else {
        // No session yet (home page) — create one via HTTP, store pending WS message, navigate
        try {
          const res = await apiPost<{ sessionId: string }>("/api/sessions", {});
          session.setPendingWsMessage({
            type: "send_message",
            text,
            images,
            files: settings.pendingFiles.length > 0 ? settings.pendingFiles : undefined,
            permissionMode: settings.permissionMode !== "auto" ? settings.permissionMode : undefined,
          });
          navigate(`/session/${res.sessionId}`);
        } catch (err) {
          console.error("[session] Failed to create session:", err);
          session.setIsLoading(false);
          session.setActivity(undefined);
        }
      }
      settings.clearPendingFiles();
    },
    [send, requestPermission, disableAutoFix, apiPost, navigate, isNewSessionRoute],
  );

  const handleEditMessage = useCallback(
    (messageIndex: number, newText: string) => {
      requestPermission();
      const sid = useSessionStore.getState().sessionId;
      const tid = useThreadStore.getState().activeThreadId;
      if (sid && tid) {
        apiPost(`/api/sessions/${sid}/threads/checkpoint`, { label: "Before edit" }).catch(() => {});
      }
      const session = useSessionStore.getState();
      session.setMessages((prev) => [...prev.slice(0, messageIndex), { role: "user" as const, text: newText }]);
      session.setIsLoading(true);
      session.setActivity({ label: "Thinking..." });
      const pm = useSettingsStore.getState().permissionMode;
      send({ type: "send_message", text: newText, sessionId: sid, permissionMode: pm !== "auto" ? pm : undefined });
    },
    [send, requestPermission, apiPost],
  );

  const handleSendErrors = useCallback(
    (errors: PreviewError[]) => {
      const text = formatErrorForMessage(errors);
      requestPermission();
      useUiStore.getState().setShowTemplates(false);
      const session = useSessionStore.getState();
      session.setMessages((prev) => [...prev, { role: "user", text }]);
      session.setIsLoading(true);
      session.setActivity({ label: "Thinking..." });
      const pm = useSettingsStore.getState().permissionMode;
      send({ type: "send_message", text, sessionId: useSessionStore.getState().sessionId, permissionMode: pm !== "auto" ? pm : undefined });
    },
    [send, requestPermission],
  );

  const handleRestartPreview = useCallback(() => {
    const sid = useSessionStore.getState().sessionId;
    if (sid) {
      usePreviewStore.getState().setCrashInfo(null);
      apiPost(`/api/sessions/${sid}/preview/restart`, {}).catch(() => {});
    }
  }, [apiPost]);

  const handleSendCrashToAgent = useCallback(() => {
    const crash = usePreviewStore.getState().crashInfo;
    if (!crash) return;
    const lines = ["The preview server crashed" + (crash.exitCode != null ? ` (exit code ${crash.exitCode})` : "") + ":", ""];
    if (crash.output) {
      lines.push("```", crash.output.trim(), "```", "");
    }
    lines.push("Please fix this error so the preview server can start successfully.");
    const text = lines.join("\n");
    requestPermission();
    useUiStore.getState().setShowTemplates(false);
    const session = useSessionStore.getState();
    session.setMessages((prev) => [...prev, { role: "user", text }]);
    session.setIsLoading(true);
    session.setActivity({ label: "Thinking..." });
    const pm = useSettingsStore.getState().permissionMode;
    send({ type: "send_message", text, sessionId: session.sessionId, permissionMode: pm !== "auto" ? pm : undefined });
  }, [send, requestPermission]);

  const handleAnswerQuestion = useCallback(
    (toolUseId: string, answers: Record<string, string>) => {
      send({ type: "answer_question", toolUseId, answers });
      const session = useSessionStore.getState();
      session.setMessages((prev) => [...prev, { role: "user", text: Object.values(answers).join(", ") }]);
      session.setIsLoading(true);
      session.setActivity({ label: "Thinking..." });
    },
    [send],
  );

  const handleNewSessionForRepo = useCallback(
    async (repoUrl: string) => {
      // Abort any in-flight claim from a previous "New Session" click
      claimAbortRef.current?.abort();
      const ac = new AbortController();
      claimAbortRef.current = ac;

      // 1. Reset state for a fresh view
      useSessionStore.getState().setSessionId(undefined);
      resetSessionState();
      useUiStore.getState().setShowTemplates(false);

      // 2. Navigate instantly (before API call) — user sees /{owner}/{repo}/new
      navigate(repoLabelToNewPath(repoUrl));

      // 3. Claim session in background — sets sessionId, triggers WS connect + preview
      const result = await useRepoStore.getState().claimSession(repoUrl, ac.signal);
      if (result && !ac.signal.aborted) {
        useSessionStore.getState().setSessionId(result.sessionId);
      }
    },
    [navigate],
  );

  const handleTabChange = useCallback(
    (tab: "preview" | "docs" | "files" | "terminal" | "features" | "changes" | "history") => {
      useUiStore.getState().setRightTab(tab);
      const sid = useSessionStore.getState().sessionId;
      if (tab === "docs" && useFileStore.getState().docFiles.length === 0 && sid) useFileStore.getState().fetchDocs(sid).catch(() => {});
      if (tab === "files" && sid) { useFileStore.getState().fetchTree(sid).catch(() => {}); }
      if (tab === "features" && sid) useUiStore.getState().fetchFeatures(sid).catch(() => {});
      if (tab === "history" && sid) useGitStore.getState().fetchLog(sid).catch(() => {});
      if (tab === "changes") {
        const pair = useGitStore.getState().lastCommitPair;
        const diff = useGitStore.getState().turnDiff;
        if (pair && !diff && sid) {
          useGitStore.getState().fetchDiff(sid, pair.from, pair.to).catch(() => {});
        }
      }
    },
    [],
  );

  const handleSettingsOpen = useCallback(async (tab?: "agent" | "github" | "git" | "instructions" | "advanced" | "deploy") => {
    useUiStore.getState().setInitialSettingsTab(tab);
    useUiStore.getState().setSettingsOpen(true);
    try {
      const data = await apiGet<{ settings: { gitIdentity: { name: string; email: string }; systemPrompt: string; agents: AgentOption[]; defaultAgentId: string; maxIdleContainers?: number } }>("/api/bootstrap");
      useGitStore.getState().setIdentity(data.settings.gitIdentity);
      useSettingsStore.getState().setSystemPromptContent(data.settings.systemPrompt);
      useSettingsStore.getState().setHasSystemPrompt(data.settings.systemPrompt.length > 0);
      if (data.settings.maxIdleContainers != null) useSettingsStore.getState().setMaxIdleContainers(data.settings.maxIdleContainers);
      useUiStore.getState().setAgentList(data.settings.agents);
    } catch { /* ignore */ }
  }, [apiGet]);

  const handleDeployOpen = useCallback(() => {
    useDeployStore.getState().openModal();
    const sid = useSessionStore.getState().sessionId;
    if (sid) useDeployStore.getState().fetchSetup(sid).catch(() => {});
  }, []);

  const handleDeploySendError = useCallback((errorMessage: string) => {
    useDeployStore.getState().closeModal();
    handleSend(`The deployment failed with this error:\n\n${errorMessage}\n\nPlease fix the issue and explain what went wrong.`);
  }, [handleSend]);

  const GIT_EMPTY_TREE = "4b825dc642cb6404f32168ace2c04d9f6e8f59b6";

  const handleViewDiff = useCallback(async (commitHash: string, parentHash: string | null) => {
    const sid = useSessionStore.getState().sessionId;
    if (!sid) return;
    const from = parentHash ?? GIT_EMPTY_TREE;
    try {
      const res = await fetch(`/api/sessions/${sid}/git/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(commitHash)}`);
      if (!res.ok) return;
      const data = await res.json();
      useGitStore.getState().setTurnDiff(data);
      useGitStore.getState().setHistoryDiffMode(true);
      useUiStore.getState().setRightTab("changes");
    } catch { /* ignore */ }
  }, []);

  const handleDownloadChat = useCallback(() => {
    const msgs = useSessionStore.getState().messages;
    if (msgs.length === 0) return;
    const blob = new Blob([JSON.stringify(msgs, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-${useSessionStore.getState().sessionId ?? "unknown"}-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleHistoryDiffClose = useCallback(() => {
    useGitStore.getState().setTurnDiff(null);
    useGitStore.getState().setHistoryDiffMode(false);
    useUiStore.getState().setRightTab("history");
  }, []);

  const handleFeatureStartSession = useCallback(
    async (feature: { name: string; planPath: string; checklistPath?: string }) => {
      resetSessionState();
      useUiStore.getState().setShowTemplates(false);
      let text = `Work on feature: ${feature.name}\n\nPlease read the feature plan at ${feature.planPath}`;
      if (feature.checklistPath) text += ` and the remaining work checklist at ${feature.checklistPath}`;
      text += `, then proceed with the implementation.`;
      requestPermission();
      useSessionStore.getState().setMessages([{ role: "user", text }]);
      useSessionStore.getState().setIsLoading(true);
      useSessionStore.getState().setActivity({ label: "Thinking..." });
      useUiStore.getState().setMobilePanel("chat");
      // Create session via HTTP, then navigate (WS auto-connects and sends pending message)
      try {
        const res = await apiPost<{ sessionId: string }>("/api/sessions", { title: feature.name });
        const pm = useSettingsStore.getState().permissionMode;
        useSessionStore.getState().setPendingWsMessage({
          type: "send_message",
          text,
          permissionMode: pm !== "auto" ? pm : undefined,
        });
        navigate(`/session/${res.sessionId}`);
      } catch (err) {
        console.error("[session] Failed to create session for feature:", err);
        useSessionStore.getState().setIsLoading(false);
        useSessionStore.getState().setActivity(undefined);
      }
    },
    [requestPermission, apiPost, navigate],
  );

  const handleUsageBadgeClick = useCallback(() => {
    useUiStore.getState().setShowUsageModal(true);
    const sid = useSessionStore.getState().sessionId;
    if (sid) useUiStore.getState().fetchUsageStats(sid).catch(() => {});
  }, []);

  const handleAgentChange = useCallback((agentId: AgentId) => {
    useUiStore.getState().setActiveAgentId(agentId);
    send({ type: "set_agent", agentId });
  }, [send]);

  const handleInstructionsSave = useCallback(async (content: string) => {
    await useSettingsStore.getState().saveInstructions(content).catch(() => {});
    useUiStore.getState().setSettingsOpen(false);
  }, []);

  // ── Computed values ──
  const detectedPorts = previewStatus?.detectedPorts ?? [];
  const checkpointDividers: CheckpointDivider[] = useMemo(() => {
    const dividers: CheckpointDivider[] = [];
    for (const thread of threads) {
      for (const cp of thread.checkpoints) {
        dividers.push({ id: cp.id, messageIndex: cp.messageIndex, label: cp.label });
      }
    }
    return dividers;
  }, [threads]);
  const showNewSessionView = isNewSessionRoute && !urlSessionId;
  const showHomeScreen = !showNewSessionView && (!sessionId || (showTemplates && messages.length === 0 && !isLoading));

  // ── Right panel ──
  const rightPanel = (
    <>
      <div className="flex border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
        <button onClick={() => handleTabChange("preview")} className={`px-4 py-2 text-sm font-medium transition-colors ${rightTab === "preview" ? "text-gray-900 dark:text-gray-100 border-b-2 border-blue-500" : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"}`}>Preview</button>
        <button onClick={() => handleTabChange("docs")} className={`px-4 py-2 text-sm font-medium transition-colors ${rightTab === "docs" ? "text-gray-900 dark:text-gray-100 border-b-2 border-blue-500" : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"}`}>Docs</button>
        <button onClick={() => handleTabChange("files")} className={`px-4 py-2 text-sm font-medium transition-colors ${rightTab === "files" ? "text-gray-900 dark:text-gray-100 border-b-2 border-blue-500" : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"}`}>Files</button>
        <button onClick={() => handleTabChange("terminal")} className={`px-4 py-2 text-sm font-medium transition-colors ${rightTab === "terminal" ? "text-gray-900 dark:text-gray-100 border-b-2 border-blue-500" : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"}`}>Terminal</button>
        {(lastCommitPair || historyDiffMode) && (
          <button onClick={() => handleTabChange("changes")} className={`px-4 py-2 text-sm font-medium transition-colors ${rightTab === "changes" ? "text-gray-900 dark:text-gray-100 border-b-2 border-blue-500" : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"}`}>Changes</button>
        )}
        <button onClick={() => handleTabChange("features")} className={`px-4 py-2 text-sm font-medium transition-colors ${rightTab === "features" ? "text-gray-900 dark:text-gray-100 border-b-2 border-blue-500" : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"}`}>Features</button>
        <button onClick={() => handleTabChange("history")} className={`px-4 py-2 text-sm font-medium transition-colors ${rightTab === "history" ? "text-gray-900 dark:text-gray-100 border-b-2 border-blue-500" : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"}`}>History</button>
      </div>
      <div className="flex-1 min-h-0">
        {rightTab === "preview" ? (
          <PreviewFrame preview={previewStatus} sessionId={sessionId} loading={isNewSessionRoute && !sessionId} detectedPorts={detectedPorts} selectedPort={selectedPort} onSelectPort={(p) => usePreviewStore.getState().setSelectedPort(p)} errors={previewErrors} onSendErrors={handleSendErrors} onClearErrors={clearPreviewErrors} autoFixEnabled={autoFixEnabled} onToggleAutoFix={handleToggleAutoFix} autoFixRetries={autoFixRetries} configMissing={configMissing} installStatus={installStatus} onInitPreviewConfig={() => send({ type: "init_preview_config" })} crashInfo={crashInfo} onRestartPreview={handleRestartPreview} onSendCrashToAgent={handleSendCrashToAgent} />
        ) : rightTab === "docs" ? (
          <DocsViewer files={docFiles} selectedFile={selectedDoc} content={docContent} onSelectFile={(f) => { const sid = useSessionStore.getState().sessionId; if (sid) useFileStore.getState().fetchDoc(sid, f).catch(() => {}); }} onRefresh={() => { const sid = useSessionStore.getState().sessionId; if (sid) useFileStore.getState().fetchDocs(sid).catch(() => {}); }} />
        ) : rightTab === "terminal" ? (
          <TerminalPanel entries={logEntries} onClear={() => { useTerminalStore.getState().clearEntries(); send({ type: "clear_logs" }); }} terminalMode={terminalMode} onTerminalModeChange={(m) => useTerminalStore.getState().setMode(m)} shellContent={
            (shellStarted || terminalMode === "shell") ? (
              <InteractiveTerminal ref={terminalRef} onInput={(d) => send({ type: "terminal_input", data: d })} onResize={(cols, rows) => send({ type: "terminal_resize", cols, rows })} onStart={(cols, rows) => { send({ type: "terminal_start", cols, rows }); useTerminalStore.getState().setShellStarted(true); }} />
            ) : null
          } />
        ) : rightTab === "changes" ? (
          turnDiff ? (
            <Suspense fallback={<div className="flex items-center justify-center h-full text-gray-500 text-sm">Loading diff viewer...</div>}>
              <DiffPanel diff={turnDiff} onClose={historyDiffMode ? handleHistoryDiffClose : () => useUiStore.getState().setRightTab("preview")} commitMessage={historyDiffMode ? gitCommits.find((c) => c.hash === turnDiff.toCommit)?.message : undefined} />
            </Suspense>
          ) : <div className="flex items-center justify-center h-full text-gray-500 text-sm">Loading diff...</div>
        ) : rightTab === "features" ? (
          <FeaturesPanel features={features} onStartSession={handleFeatureStartSession} onRefresh={() => { const sid = useSessionStore.getState().sessionId; if (sid) useUiStore.getState().fetchFeatures(sid).catch(() => {}); }} />
        ) : rightTab === "history" ? (
          <GitHistory commits={gitCommits} onRollback={(hash) => { const sid = useSessionStore.getState().sessionId; if (sid) useGitStore.getState().rollback(sid, hash).catch(() => {}); }} onRefresh={() => { const sid = useSessionStore.getState().sessionId; if (sid) useGitStore.getState().fetchLog(sid).catch(() => {}); }} onViewDiff={handleViewDiff} />
        ) : viewingFile ? (
          <FileContentViewer filePath={viewingFile} content={viewingFileContent} isBinary={viewingFileBinary} onClose={() => useFileStore.getState().closeViewer()} />
        ) : (
          <FileTree tree={fileTree} onRefresh={() => { const sid = useSessionStore.getState().sessionId; if (sid) useFileStore.getState().fetchTree(sid).catch(() => {}); }} onFileClick={(f) => { const sid = useSessionStore.getState().sessionId; if (sid) useFileStore.getState().fetchFile(sid, f).catch(() => {}); }} selectedFile={viewingFile} onAddToChat={(f) => useSettingsStore.getState().addPendingFile(f)} />
        )}
      </div>
    </>
  );

  // ── Chat panel ──
  const chatPanel = (
    <>
      {searchOpen && <SearchBar query={search.query} onQueryChange={search.setQuery} matches={search.matches} currentMatchIndex={search.currentMatchIndex} onNext={search.goToNext} onPrev={search.goToPrev} onClose={() => { setSearchOpen(false); search.clear(); }} />}
      {showHomeScreen ? (
        <HomeScreen onAddRepo={() => useRepoStore.getState().setAddRepoDialogOpen(true)} hasRepos={repos.length > 0} />
      ) : (
        <>
          <MessageList messages={messages} isLoading={isLoading} activity={activity} searchMatches={search.matches} currentMatch={search.currentMatch} onEditMessage={handleEditMessage} onAnswerQuestion={handleAnswerQuestion} checkpoints={checkpointDividers} />
          {wsSessionId && <PrLifecycleCard sessionId={wsSessionId} />}
        </>
      )}
      {!showHomeScreen && !showNewSessionView && (
        <div className="border-t border-gray-200 dark:border-gray-800 px-4 py-1.5 flex items-center gap-2">
          <ThreadIndicator threads={threads} activeThreadId={activeThreadId} onCreateCheckpoint={(label) => { const sid = useSessionStore.getState().sessionId; if (sid) useThreadStore.getState().createCheckpoint(sid, label).catch(() => {}); }} onForkThread={(id) => send({ type: "fork_thread", checkpointId: id })} onSwitchThread={(id) => send({ type: "switch_thread", threadId: id })} disabled={isLoading || status !== "open"} />
          <AgentPicker agents={agentList} activeAgentId={activeAgentId} onAgentChange={handleAgentChange} disabled={isLoading || status !== "open"} />
          <button onClick={handleDownloadChat} className="ml-auto p-1 rounded text-gray-500 hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors" title="Download chat history" aria-label="Download chat history">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
          </button>
        </div>
      )}
      {!showHomeScreen && !showNewSessionView && threads.length > 0 && <ThreadTimeline threads={threads} activeThreadId={activeThreadId} onForkThread={(id) => send({ type: "fork_thread", checkpointId: id })} onSwitchThread={(id) => send({ type: "switch_thread", threadId: id })} />}
      {!showHomeScreen && !showNewSessionView && <StatusBar modelInfo={modelInfo} contextTokens={contextTokens} agentName={agentList.find((a) => a.id === activeAgentId)?.name} />}
      {!showHomeScreen && !showNewSessionView && queuedMessages.length > 0 && <QueueIndicator queue={queuedMessages} onCancel={(pos) => send({ type: "cancel_queued_message", position: pos })} />}
      {(!showHomeScreen || showNewSessionView) && <MessageInput onSend={handleSend} disabled={showNewSessionView ? status !== "open" && !sessionId : status !== "open"} isLoading={isLoading} onInterrupt={() => send({ type: "interrupt_claude" })} permissionMode={permissionMode} onPermissionModeChange={(m) => useSettingsStore.getState().setPermissionMode(m)} pendingFiles={pendingFiles} onRemoveFile={(i) => useSettingsStore.getState().removePendingFile(i)} onAddFile={(f) => useSettingsStore.getState().addPendingFile(f)} fileTree={fileTree} />}
    </>
  );

  // ── Bootstrap loading gate ──
  if (!bootstrapLoaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-950">
        {showBootstrapSpinner && (
          <svg className="h-6 w-6 animate-spin text-gray-600" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {authUrl !== null && !showOnboarding && <AuthOverlay url={authUrl} onPasteCode={(code) => { apiPost("/api/auth/code", { code }).catch(() => {}); }} onApiKey={(key) => { apiPost("/api/auth/api-key", { key }).catch(() => {}); }} />}
      {showOnboarding && <OnboardingWizard initialStep={gitIdentityNeeded ? 1 : 2} onGitIdentitySubmit={(name: string, email: string) => useGitStore.getState().submitGitIdentity(name, email).catch(() => {})} onGitHubTokenSubmit={async (token: string) => { const result = await useSettingsStore.getState().submitGitHubToken(token); if (result) { usePrStore.getState().setImportSearchResults(result.repos); return true; } return false; }} agents={agentList} onClaudeApiKeySubmit={async (key: string) => { try { await apiPost("/api/auth/api-key", { key }); const data = await apiGet<{ agents: AgentOption[] }>("/api/bootstrap"); useUiStore.getState().setAgentList(data.agents); return true; } catch { return false; } }} onCodexApiKeySubmit={async (key: string) => { try { const result = await apiPost<{ agents: AgentOption[] }>(`/api/agents/codex/env`, { key: "OPENAI_API_KEY", value: key }); useUiStore.getState().setAgentList(result.agents); return true; } catch { return false; } }} onStartClaudeAuth={() => { apiPost("/api/auth/start", {}).catch(() => {}); }} authUrl={authUrl} onPasteAuthCode={(code: string) => { apiPost("/api/auth/code", { code }).catch(() => {}); }} onRefreshAgents={async () => { const data = await apiGet<{ agents: AgentOption[] }>("/api/bootstrap"); useUiStore.getState().setAgentList(data.agents); }} onComplete={() => { setOnboardingActive(false); if (gitIdentityNeeded) useGitStore.getState().setIdentityNeeded(false); }} />}
      {shortcutsOpen && <KeyboardShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}
      {settingsOpen && (
        <Settings
          initialContent={systemPromptContent} onSaveInstructions={handleInstructionsSave}
          githubStatus={githubStatus}
          onGitHubTokenSubmit={async (token) => { const result = await useSettingsStore.getState().submitGitHubToken(token); if (result) usePrStore.getState().setImportSearchResults(result.repos); }}
          onGitHubLogout={() => useSettingsStore.getState().gitHubLogout().catch(() => {})}
          authUrl={authUrl}
          onApiKey={(key) => { apiPost("/api/auth/api-key", { key }).catch(() => {}); }}
          onClearApiKey={() => { apiDel("/api/auth/api-key").catch(() => {}); }}
          onStartAuth={() => { apiPost("/api/auth/start", {}).catch(() => {}); }}
          onPasteCode={(code) => { apiPost("/api/auth/code", { code }).catch(() => {}); }}
          agentList={agentList}
          onSetAgentEnv={(agentId, key, value) => { apiPost(`/api/agents/${agentId}/env`, { key, value }).catch(() => {}); }}
          onFullReset={async () => { try { await apiPost("/api/reset", {}); } catch { /* ignore */ } }}
          gitIdentity={gitIdentity}
          onGitIdentitySave={(name, email) => useGitStore.getState().submitGitIdentity(name, email).catch(() => {})}
          maxIdleContainers={maxIdleContainers}
          onMaxIdleContainersSave={async (n) => { try { const raw = await apiPut("/api/settings", { maxIdleContainers: n }); const res = raw as Record<string, unknown>; if (res.maxIdleContainers != null) useSettingsStore.getState().setMaxIdleContainers(res.maxIdleContainers as number); } catch { /* ignore */ } }}
          deployTargets={deployTargets} deployConfigStatus={deployConfigStatus}
          onDeployConfigure={(targetId, creds, projectName) => { const sid = useSessionStore.getState().sessionId; if (sid) useDeployStore.getState().configure(sid, targetId, creds, projectName).catch(() => {}); }}
          onDeployDeleteConfig={(targetId) => { const sid = useSessionStore.getState().sessionId; if (sid) useDeployStore.getState().deleteConfig(sid, targetId).catch(() => {}); }}
          hasActiveSession={!!sessionId} initialTab={initialSettingsTab}
          onDeployTabSelected={() => { const sid = useSessionStore.getState().sessionId; if (sid) useDeployStore.getState().fetchSetup(sid).catch(() => {}); }}
          onClose={() => { useUiStore.getState().setSettingsOpen(false); useUiStore.getState().setInitialSettingsTab(undefined); }}
        />
      )}
      {showDeployModal && (
        <DeployModal targets={deployTargets} configStatus={deployConfigStatus} deployStatus={deployStatus} lastDeployUrl={lastDeployUrl} lastDeployError={lastDeployError} deployHistory={deployHistory}
          onDeploy={(targetId, env) => send({ type: "initiate_deploy", targetId, environment: env })} onCancel={() => send({ type: "cancel_deploy" })}
          onGetHistory={() => { const sid = useSessionStore.getState().sessionId; if (sid) useDeployStore.getState().fetchHistory(sid).catch(() => {}); }}
          onSendErrorToChat={handleDeploySendError} onOpenDeploySettings={() => handleSettingsOpen("deploy")}
          onClose={() => useDeployStore.getState().closeModal()}
        />
      )}
      {showUsageModal && <UsageModal currentSessionUsage={currentSessionUsage} allUsage={allUsageStats} sessions={sessions} onClose={() => useUiStore.getState().setShowUsageModal(false)} modelInfo={modelInfo} contextTokens={contextTokens} turnTokens={turnTokens} />}

      <header className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          <h1 className="text-lg font-semibold tracking-tight shrink-0 flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition-opacity" onClick={() => navigate("/")} role="link">
            <img src={theme === "dark" ? "/favicon.svg" : "/favicon-light.svg"} alt="" className="w-5 h-5" />
            ShipIt
          </h1>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <button onClick={handleDeployOpen} className="hidden sm:inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-cyan-100 dark:bg-cyan-900 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-200 dark:hover:bg-cyan-800 transition-colors font-medium" title="Deploy to production" aria-label="Deploy">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" /></svg>
            Deploy
          </button>
          <button onClick={() => handleSettingsOpen()} className={`hidden sm:inline-flex items-center justify-center w-7 h-7 rounded transition-colors ${hasSystemPrompt || githubStatus.authenticated ? "text-blue-400 hover:text-blue-300 hover:bg-gray-100 dark:hover:bg-gray-800" : "text-gray-500 hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"}`} title="Settings" aria-label="Settings">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" clipRule="evenodd" /></svg>
          </button>
          {currentSessionUsage && currentSessionUsage.totalCostUsd > 0 && (
            <button onClick={handleUsageBadgeClick} className="hidden sm:inline text-xs px-2 py-0.5 rounded-full bg-purple-900 text-purple-300 hover:bg-purple-800 transition-colors cursor-pointer" title="View usage details">
              {currentSessionUsage.totalCostUsd < 0.01 ? `$${currentSessionUsage.totalCostUsd.toFixed(3)}` : `$${currentSessionUsage.totalCostUsd.toFixed(2)}`}
            </button>
          )}
          <button onClick={toggleTheme} className="p-1.5 rounded-md text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors" title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}>
            {theme === "dark" ? (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
            )}
          </button>
        </div>
      </header>

      {!showNewSessionView && wsSessionId && <ConnectionBanner status={status} reconnectAttempt={reconnectAttempt} onReconnect={reconnect} />}

      {/* PR lifecycle card is rendered inline in the message list via PrLifecycleCard */}

      {isMobile ? (
        <>
          <div className="flex flex-col flex-1 min-h-0">
            {(showHomeScreen && !showNewSessionView) || mobilePanel === "chat" ? <div className="flex flex-col flex-1 min-h-0">{chatPanel}</div> : <div className="flex flex-col flex-1 min-h-0 bg-gray-50 dark:bg-gray-900">{rightPanel}</div>}
          </div>
          {(!showHomeScreen || showNewSessionView) && <MobileTabBar activePanel={mobilePanel} onChangePanel={(p) => useUiStore.getState().setMobilePanel(p)} />}
        </>
      ) : (
        <div className="flex flex-1 min-h-0">
          <SessionSidebar
            sessions={sessions} repos={repos} currentSessionId={sessionId} activeRunnerSessions={activeRunnerSessions}
            newSessionRepoUrl={newSessionRepoUrl}
            onResume={(sid) => handleSessionResume(sid, navigate)}
            onNew={() => newSession(navigate)}
            onNewSessionForRepo={handleNewSessionForRepo}
            onArchive={async (sid) => { await useSessionStore.getState().archiveSession(sid); if (sid === useSessionStore.getState().sessionId) { useSessionStore.getState().setSessionId(undefined); navigate("/"); } }}
            onRename={(sid, title) => useSessionStore.getState().renameSession(sid, title)}
            onRefresh={() => useSessionStore.getState().refreshSessions()}
            onAddRepo={() => useRepoStore.getState().setAddRepoDialogOpen(true)}
            onRemoveRepo={(url) => useRepoStore.getState().removeRepo(url)}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => useUiStore.getState().setSidebarCollapsed(!sidebarCollapsed)}
          />
          <div ref={containerRef} className="flex flex-1 min-h-0">
            <div className={`flex flex-col min-w-0 ${showHomeScreen ? "" : "border-r border-gray-200 dark:border-gray-800"}`} style={{ width: showHomeScreen ? "100%" : `${fraction * 100}%` }}>
              {chatPanel}
            </div>
            {!showHomeScreen && (
              <>
                <ResizeHandle isDragging={isDragging} onMouseDown={onMouseDown} onTouchStart={onTouchStart} />
                <div className="min-w-0 flex flex-col bg-gray-50 dark:bg-gray-900" style={{ width: `${(1 - fraction) * 100}%` }}>{rightPanel}</div>
              </>
            )}
          </div>
        </div>
      )}

      {toast && <Toast toast={toast} onDismiss={() => useUiStore.getState().setToast(null)} />}
      <AddRepoDialog
        open={addRepoDialogOpen}
        onClose={() => useRepoStore.getState().setAddRepoDialogOpen(false)}
        onAdd={async (url) => { await useRepoStore.getState().addRepo(url); }}
        onRepoReady={(url) => navigate(repoLabelToNewPath(url))}
        onCreateNew={() => {
          useRepoStore.getState().setAddRepoDialogOpen(false);
          // eslint-disable-next-line no-restricted-syntax -- fire-and-forget one-liner
          if (templates.length === 0) apiGet<{ templates: typeof templates }>("/api/bootstrap").then((d) => useUiStore.getState().setTemplates(d.templates)).catch(() => {});
          useRepoStore.getState().setNewRepoDialogOpen(true);
        }}
        searchResults={importSearchResults}
        onSearch={(q) => usePrStore.getState().searchRepos(q).catch(() => {})}
        repos={repos}
      />
      {newRepoDialogOpen && (
        <NewRepoDialog
          username={githubStatus.username ?? ""}
          templates={templates}
          creating={creatingRepo}
          onClose={() => useRepoStore.getState().setNewRepoDialogOpen(false)}
          onSubmit={async (name, description, isPrivate, templateId) => {
            useSessionStore.getState().setCreatingRepo(true);
            try {
              const res = await apiPost<{ success: boolean; repoUrl?: string; sessionId?: string; message?: string }>(
                "/api/repos",
                { repoName: name, description, isPrivate, templateId },
              );
              if (res.success && res.sessionId) {
                useRepoStore.getState().setNewRepoDialogOpen(false);
                navigate(`/session/${res.sessionId}`);
              } else {
                useUiStore.getState().setToast({ message: res.message || "Failed to create repository" });
              }
            } catch {
              useUiStore.getState().setToast({ message: "Failed to create repository" });
            } finally {
              useSessionStore.getState().setCreatingRepo(false);
            }
          }}
        />
      )}
    </div>
  );
}
