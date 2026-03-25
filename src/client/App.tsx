// eslint-disable-next-line no-restricted-imports -- useEffect: bootstrap timer (setTimeout cleanup), URL/route sync (browser navigation is external), session claim (AbortController cleanup)
import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from "react";
import { Modal } from "./components/ui/modal.js";
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
import { useFileUpload } from "./hooks/useFileUpload.js";
import { CircleNotchIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "./design-tokens.js";
import { useMessageHandler } from "./hooks/useMessageHandler.js";
import { useApi } from "./hooks/useApi.js";
import { formatErrorForMessage } from "./components/PreviewFrame.js";
import { SessionTopBar } from "./components/SessionTopBar.js";
import { MessageInput } from "./components/MessageInput.js";
import { MessageList } from "./components/MessageList.js";
import { PreviewFrame } from "./components/PreviewFrame.js";
import { usePreviewErrors, type PreviewError } from "./hooks/usePreviewErrors.js";
import { GitHistory } from "./components/GitHistory.js";
import { AuthOverlayContainer } from "./AuthOverlay.js";
import { Settings } from "./components/Settings.js";
import { AppLayout } from "./AppLayout.js";
import { DocsViewer } from "./components/DocsViewer.js";
import { DocReviewPanel } from "./components/DocReviewPanel.js";
import { FileTree } from "./components/FileTree.js";
import { FilePreviewModal } from "./components/FilePreviewModal.js";
import { TerminalPanel } from "./components/TerminalPanel.js";
import { InteractiveTerminal, type InteractiveTerminalHandle } from "./components/InteractiveTerminal.js";
import { SearchBar } from "./components/SearchBar.js";
import { KeyboardShortcutsOverlay } from "./components/KeyboardShortcutsOverlay.js";
import { HomeScreen } from "./components/HomeScreen.js";
import { AddRepoDialog } from "./components/AddRepoDialog.js";
import { AllSessionsDialog } from "./components/AllSessionsDialog.js";
import { NewRepoDialog } from "./components/NewRepoDialog.js";
import { UsageModal } from "./components/UsageModal.js";
import type { TurnDiffData } from "./components/DiffPanel.js";
// eslint-disable-next-line no-restricted-syntax -- lazy() named-export pattern
const DiffPanel = lazy(() => import("./components/DiffPanel.js").then(m => ({ default: m.DiffPanel })));
import { PrLifecycleCard } from "./components/PrLifecycleCard.js";
import { QueueIndicator } from "./components/QueueIndicator.js";
import type { AgentOption } from "./components/AgentPicker.js";
import type { AgentId, DocEntry } from "../server/shared/types.js";

import { useSessionStore } from "./stores/session-store.js";
import { useGitStore } from "./stores/git-store.js";
import { useFileStore, markUploadDeleted } from "./stores/file-store.js";
import { usePreviewStore } from "./stores/preview-store.js";
import { useTerminalStore } from "./stores/terminal-store.js";
import { usePrStore } from "./stores/pr-store.js";
import { useSettingsStore } from "./stores/settings-store.js";
import { useUiStore } from "./stores/ui-store.js";
import { useRepoStore } from "./stores/repo-store.js";
import { resumeSessionInternal, handleSessionResume, resetSessionState } from "./stores/actions/session-actions.js";
import { parseRepoLabel, parseRepoName, repoLabelToNewPath, parseNewSessionSlug } from "./utils/repo-label.js";
import { saveModelId } from "./utils/local-storage.js";

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
  const queuedMessages = useSessionStore((s) => s.queuedMessages);

  const {
    uploads, uploadFiles, removeUpload, retryUpload,
    getUploadRefs, clearUploads,
  } = useFileUpload(wsSessionId);
  const sessionUploads = useFileStore((s) => s.sessionUploads);

  const gitCommits = useGitStore((s) => s.commits);
  const gitIdentityNeeded = useGitStore((s) => s.identityNeeded);
  const gitIdentity = useGitStore((s) => s.identity);
  const turnDiff = useGitStore((s) => s.turnDiff);
  const diffDialogOpen = useGitStore((s) => s.diffDialogOpen);
  const diffDialogTitle = useGitStore((s) => s.diffDialogTitle);

  const fileTree = useFileStore((s) => s.tree);
  const docFiles = useFileStore((s) => s.docFiles);
  const previewFile = useFileStore((s) => s.previewFile);
  const previewContent = useFileStore((s) => s.previewContent);
  const previewType = useFileStore((s) => s.previewType);
  const previewActions = useFileStore((s) => s.previewActions);

  const previewStatus = usePreviewStore((s) => s.status);
  const selectedPort = usePreviewStore((s) => s.selectedPort);
  const configMissing = usePreviewStore((s) => s.configMissing);
  const crashInfo = usePreviewStore((s) => s.crashInfo);

  const logEntries = useTerminalStore((s) => s.entries);

  const terminalMode = useTerminalStore((s) => s.mode);
  const shellStarted = useTerminalStore((s) => s.shellStarted);

  const importSearchResults = usePrStore((s) => s.importSearchResults);
  const hasPrCard = usePrStore((s) => wsSessionId ? !!s.cardBySession[wsSessionId] : false);

  const permissionMode = useSettingsStore((s) => s.permissionMode);
  const pendingFiles = useSettingsStore((s) => s.pendingFiles);
  const githubStatus = useSettingsStore((s) => s.githubStatus);
  const hasSystemPrompt = useSettingsStore((s) => s.hasSystemPrompt);
  const systemPromptContent = useSettingsStore((s) => s.systemPromptContent);
  const agentSystemInstructionsEnabled = useSettingsStore((s) => s.agentSystemInstructionsEnabled);
  const agentSystemInstructions = useSettingsStore((s) => s.agentSystemInstructions);
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
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toast = useUiStore((s) => s.toast);
  const dockerMemory = useUiStore((s) => s.dockerMemory);

  const bootstrapLoaded = useUiStore((s) => s.bootstrapLoaded);

  const repos = useRepoStore((s) => s.repos);
  const activeRepoUrl = useRepoStore((s) => s.activeRepoUrl);
  const repoSwitcherOpen = useRepoStore((s) => s.repoSwitcherOpen);
  const addRepoDialogOpen = useRepoStore((s) => s.addRepoDialogOpen);
  const newRepoDialogOpen = useRepoStore((s) => s.newRepoDialogOpen);
  const activeRepoName = useMemo(() => activeRepoUrl ? parseRepoName(activeRepoUrl) : "", [activeRepoUrl]);
  const activeRepo = useMemo(() => repos.find((r) => r.url === activeRepoUrl), [repos, activeRepoUrl]);

  const creatingRepo = useSessionStore((s) => s.creatingRepo);
  const allSessionsDialogOpen = useSessionStore((s) => s.allSessionsDialogOpen);
  const allSessions = useSessionStore((s) => s.allSessions);
  const currentSession = useMemo(
    () => sessions.find((s) => s.id === sessionId),
    [sessions, sessionId],
  );
  const currentRepoUrl = currentSession?.remoteUrl;

  const noAgentReady = agentList.length > 0 && !agentList.some(a => a.installed && a.authConfigured);
  const needsOnboarding = gitIdentityNeeded || noAgentReady;
  // Latch: once onboarding is triggered, it stays active until the user
  // clicks "Get Started". This prevents the dialog from closing reactively
  // when e.g. Claude auth completes and noAgentReady flips to false mid-wizard.
  const onboardingTriggeredRef = useRef(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  if (needsOnboarding && !onboardingTriggeredRef.current) {
    onboardingTriggeredRef.current = true;
  }
  const showOnboarding = onboardingTriggeredRef.current && !onboardingDismissed;

  // ── Non-store hooks ──
  const { fraction, isDragging, onMouseDown, onTouchStart, containerRef } = useResizablePanel({
    initialFraction: 0.5,
    minFraction: 0.25,
    storageKey: "vibe-panel-split",
  });
  const isMobile = useIsMobile();
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [reviewingDoc, setReviewingDoc] = useState<{ doc: DocEntry; content: string } | null>(null);
  // Derive the repo URL from the /{slug}/new URL pattern (replaces useState)
  const newSessionRepoUrl = useMemo(() => {
    if (!newSessionRepoSlug) return undefined;
    return repos.find((r) => parseRepoLabel(r.url) === newSessionRepoSlug)?.url;
  }, [newSessionRepoSlug, repos]);
  const search = useSearch(messages);
  const { notify, requestPermission } = useNotification();
  const { theme, setTheme } = useTheme();
  const { errors: previewErrors, clearErrors: clearPreviewErrors } = usePreviewErrors();

  const { disableAutoFix } = useAutoFix({
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

  useConnectionSync({ status, send, onSessionConnect: (sid: string) => { void useFileStore.getState().hydrateUploads(sid); } });

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
      disableAutoFix();
    } else if (!urlSessionId && useSessionStore.getState().sessionId) {
      // Clear stale sessionId — prevents WS from connecting to old session.
      // On /new route, the auto-claim effect will set the correct sessionId.
      useSessionStore.getState().setSessionId(undefined);
      resetSessionState();
      disableAutoFix();
      if (!isNewSessionRoute) {
        useUiStore.getState().setShowTemplates(true);
      }
    }
  }, [urlSessionId, isNewSessionRoute, disableAutoFix]);

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
      void navigate("/", { replace: true });
    }
  }, [isNewSessionRoute, newSessionRepoUrl, bootstrapLoaded, repos.length, navigate]);

  // ── Callback helpers ──
  const handleSend = useCallback(
    async (text: string) => {
      requestPermission();
      disableAutoFix();
      const session = useSessionStore.getState();
      const settings = useSettingsStore.getState();
      useUiStore.getState().setShowTemplates(false);
      const uploadRefs = getUploadRefs();
      // Separate image uploads (have previewUrl) from non-image uploads for display
      const readyUploads = uploads.filter((u) => u.status === "ready" && u.path);
      const imageUploads = readyUploads.filter((u) => u.previewUrl);
      const nonImageUploadRefs = uploadRefs.filter(
        (ref) => !imageUploads.some((u) => u.path === ref.path),
      );
      const allFiles: { path: string; contentPreview: string }[] = [
        ...settings.pendingFiles.map((f) => ({ path: f.path, contentPreview: "" })),
        ...nonImageUploadRefs.map((u) => ({ path: u.path, contentPreview: "" })),
      ];
      const filesForMessage = allFiles.length > 0 ? allFiles : undefined;
      const imagesForMessage = imageUploads.length > 0
        ? imageUploads.map((u) => ({ data: "", mediaType: u.mimeType ?? "image/png", src: u.dataUrl ?? u.previewUrl! }))
        : undefined;
      const uploadPathsForMessage = uploadRefs.length > 0 ? uploadRefs.map((u) => u.path) : undefined;
      session.setMessages((prev) => [...prev, { role: "user", text, files: filesForMessage, images: imagesForMessage, uploadPaths: uploadPathsForMessage }]);
      session.setIsLoading(true);
      session.setActivity({ label: "Thinking..." });

      const currentSessionId = session.sessionId;
      if (currentSessionId) {
        // On /{slug}/new route — graduate: transition URL to /session/{id}
        if (isNewSessionRoute) {
          void navigate(`/session/${currentSessionId}`, { replace: true });
        }

        // Send directly over WS
        send({
          type: "send_message",
          text,
          sessionId: currentSessionId,
          files: settings.pendingFiles.length > 0 ? settings.pendingFiles : undefined,
          uploads: uploadRefs.length > 0 ? uploadRefs : undefined,
          permissionMode: settings.permissionMode !== "auto" ? settings.permissionMode : undefined,
        });
      } else {
        // No session — can't send without one (sessions are created via claim-session)
        console.warn("[session] No active session — cannot send message");
        session.setIsLoading(false);
        session.setActivity(undefined);
      }
      settings.clearPendingFiles();
      clearUploads();
    },
    [send, requestPermission, disableAutoFix, navigate, isNewSessionRoute, getUploadRefs, clearUploads, uploads],
  );

  const handleRewind = useCallback(
    (messageIndex: number, mode: "fork_chat" | "rewind_code" | "rewind_all") => {
      send({ type: "rewind_to_message", messageIndex, mode });
    },
    [send],
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
    const lines = [`The preview server crashed${  crash.exitCode !== null ? ` (exit code ${crash.exitCode})` : ""  }:`, ""];
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

  const handleSendFollowUp = useCallback(
    (text: string) => {
      const session = useSessionStore.getState();
      session.setMessages((prev) => [...prev, { role: "user", text }]);
      session.setIsLoading(true);
      session.setActivity({ label: "Thinking..." });
      const pm = useSettingsStore.getState().permissionMode;
      send({ type: "send_message", text, sessionId: session.sessionId, permissionMode: pm !== "auto" ? pm : undefined });
    },
    [send],
  );

  const handleRollback = useCallback(
    (messageIndex: number, mode: "code" | "code_and_chat" | "fork", parentCommitHash: string) => {
      if (mode === "code") {
        send({ type: "rollback_code", messageIndex, parentCommitHash });
      } else if (mode === "code_and_chat") {
        send({ type: "rollback_code_and_chat", messageIndex, parentCommitHash });
      } else {
        send({ type: "fork_session_from_message", messageIndex, parentCommitHash });
      }
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
      void navigate(repoLabelToNewPath(repoUrl));

      // 3. Claim session in background — sets sessionId, triggers WS connect + preview
      const result = await useRepoStore.getState().claimSession(repoUrl, ac.signal);
      if (result && !ac.signal.aborted) {
        useSessionStore.getState().setSessionId(result.sessionId);
      }
    },
    [navigate],
  );

  const handleTabChange = useCallback(
    (tab: "preview" | "docs" | "files" | "terminal" | "history") => {
      useUiStore.getState().setRightTab(tab);
      const sid = useSessionStore.getState().sessionId;
      if (tab === "docs" && useFileStore.getState().docFiles.length === 0 && sid) useFileStore.getState().fetchDocs(sid).catch(() => {});
      if (tab === "files" && sid) { useFileStore.getState().fetchTree(sid).catch(() => {}); }
      if (tab === "history" && sid) useGitStore.getState().fetchLog(sid).catch(() => {});
    },
    [],
  );

  const handleSettingsOpen = useCallback(async (tab?: "agent" | "github" | "git" | "instructions" | "advanced") => {
    useUiStore.getState().setSettingsTab(tab);
    useUiStore.getState().setSettingsOpen(true);
    try {
      const data = await apiGet<{ settings: { gitIdentity: { name: string; email: string }; systemPrompt: string; agents: AgentOption[]; defaultAgentId: string; maxIdleContainers?: number; agentSystemInstructionsEnabled?: boolean; agentSystemInstructions?: string } }>("/api/bootstrap");
      useGitStore.getState().setIdentity(data.settings.gitIdentity);
      useSettingsStore.getState().setSystemPromptContent(data.settings.systemPrompt);
      useSettingsStore.getState().setHasSystemPrompt(data.settings.systemPrompt.length > 0);
      if (data.settings.maxIdleContainers !== null && data.settings.maxIdleContainers !== undefined) useSettingsStore.getState().setMaxIdleContainers(data.settings.maxIdleContainers);
      if (data.settings.agentSystemInstructionsEnabled !== undefined) useSettingsStore.getState().setAgentSystemInstructionsEnabled(data.settings.agentSystemInstructionsEnabled);
      if (data.settings.agentSystemInstructions) useSettingsStore.getState().setAgentSystemInstructions(data.settings.agentSystemInstructions);
      useUiStore.getState().setAgentList(data.settings.agents);
    } catch { /* ignore */ }
  }, [apiGet]);

  const GIT_EMPTY_TREE = "4b825dc642cb6404f32168ace2c04d9f6e8f59b6";

  const handleViewDiff = useCallback(async (commitHash: string, parentHash: string | null) => {
    const sid = useSessionStore.getState().sessionId;
    if (!sid) return;
    const from = parentHash ?? GIT_EMPTY_TREE;
    try {
      const res = await fetch(`/api/sessions/${sid}/git/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(commitHash)}`);
      if (!res.ok) return;
      const data = await res.json() as TurnDiffData;
      const commitMsg = useGitStore.getState().commits.find((c) => c.hash === commitHash)?.message;
      useGitStore.getState().setTurnDiff(data);
      useGitStore.getState().openDiffDialog(commitMsg);
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

  const handleOpenDoc = useCallback(
    (filePath: string, doc?: DocEntry) => {
      const sid = useSessionStore.getState().sessionId;
      if (!sid) return;
      const actions = doc?.status
        ? [{ label: "Start Session", onClick: () => handleDocStartSession(doc), variant: "primary" as const }]
        : undefined;
      void useFileStore.getState().openPreview(sid, filePath, { actions });
    },
    [],
  );

  const handleOpenFilePreview = useCallback(
    (filePath: string) => {
      const sid = useSessionStore.getState().sessionId;
      if (sid) {
        const actions = [{
          label: "Download",
          onClick: () => {
            const a = document.createElement("a");
            a.href = `/api/sessions/${sid}/files/download/${filePath}`;
            a.download = "";
            document.body.appendChild(a);
            a.click();
            a.remove();
          },
        }];
        void useFileStore.getState().openPreview(sid, filePath, { actions });
      }
    },
    [],
  );

  const handleDocStartSession = useCallback(
    (doc: DocEntry) => {
      useFileStore.getState().closePreview();
      const text = `Work on: ${doc.title}\n\nPlease read the plan at ${doc.path}, then proceed with the implementation.`;
      useSessionStore.getState().setPrefillText(text);
      useUiStore.getState().setMobilePanel("chat");
    },
    [],
  );

  const handleReviewFeature = useCallback(
    async (doc: DocEntry) => {
      const sid = useSessionStore.getState().sessionId;
      if (!sid) return;
      try {
        const res = await fetch(`/api/sessions/${sid}/files/content?path=${encodeURIComponent(doc.path)}`);
        if (!res.ok) return;
        const data = await res.json() as { content: string };
        setReviewingDoc({ doc, content: data.content });
      } catch (err) {
        console.error("[review] Failed to load doc content:", err);
      }
    },
    [],
  );

  const handleReviewSendComments = useCallback(
    (feature: DocEntry, prompt: string) => {
      setReviewingDoc(null);
      // Send the prompt to the current session
      send({ type: "send_message", text: prompt });
    },
    [send],
  );

  const handleFileSendComments = useCallback(
    (prompt: string) => {
      useFileStore.getState().closePreview();
      send({ type: "send_message", text: prompt });
    },
    [send],
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

  const handleModelChange = useCallback((model: string) => {
    saveModelId(model);
    send({ type: "set_model", model });
  }, [send]);

  const handleInstructionsSave = useCallback(async (content: string) => {
    await useSettingsStore.getState().saveInstructions(content).catch(() => {});
    useUiStore.getState().setSettingsOpen(false);
  }, []);

  // ── Computed values ──
  const detectedPorts = previewStatus?.detectedPorts ?? [];
  const showNewSessionView = isNewSessionRoute && !urlSessionId;
  const showHomeScreen = !showNewSessionView && (!sessionId || (showTemplates && messages.length === 0 && !isLoading));

  // ── Right panel ──
  const rightPanel = (
    <>
      <div className="flex h-10 border-b border-(--color-border-primary) bg-(--color-bg-secondary)">
        <button onClick={() => handleTabChange("preview")} className={`px-3 sm:px-4 h-full inline-flex items-center text-xs sm:text-sm font-medium transition-colors ${rightTab === "preview" ? "text-(--color-text-primary) border-b-2 border-(--color-border-focus)" : "text-(--color-text-secondary) hover:text-(--color-text-primary)"}`}>Preview</button>
        <button onClick={() => handleTabChange("docs")} className={`px-3 sm:px-4 h-full inline-flex items-center text-xs sm:text-sm font-medium transition-colors ${rightTab === "docs" ? "text-(--color-text-primary) border-b-2 border-(--color-border-focus)" : "text-(--color-text-secondary) hover:text-(--color-text-primary)"}`}>Docs</button>
        <button onClick={() => handleTabChange("files")} className={`px-3 sm:px-4 h-full inline-flex items-center text-xs sm:text-sm font-medium transition-colors ${rightTab === "files" ? "text-(--color-text-primary) border-b-2 border-(--color-border-focus)" : "text-(--color-text-secondary) hover:text-(--color-text-primary)"}`}>Files</button>
        <button onClick={() => handleTabChange("terminal")} className={`px-3 sm:px-4 h-full inline-flex items-center text-xs sm:text-sm font-medium transition-colors ${rightTab === "terminal" ? "text-(--color-text-primary) border-b-2 border-(--color-border-focus)" : "text-(--color-text-secondary) hover:text-(--color-text-primary)"}`}>Terminal</button>
        <button onClick={() => handleTabChange("history")} className={`px-3 sm:px-4 h-full inline-flex items-center text-xs sm:text-sm font-medium transition-colors ${rightTab === "history" ? "text-(--color-text-primary) border-b-2 border-(--color-border-focus)" : "text-(--color-text-secondary) hover:text-(--color-text-primary)"}`}>History</button>
      </div>
      <div className="flex-1 min-h-0">
        {rightTab === "preview" ? (
          <PreviewFrame preview={previewStatus} sessionId={sessionId} detectedPorts={detectedPorts} selectedPort={selectedPort} onSelectPort={(p) => usePreviewStore.getState().setSelectedPort(p)} errors={previewErrors} onSendErrors={handleSendErrors} onClearErrors={clearPreviewErrors} configMissing={configMissing} onInitPreviewConfig={() => send({ type: "init_preview_config" })} crashInfo={crashInfo} onRestartPreview={handleRestartPreview} onSendCrashToAgent={handleSendCrashToAgent} />
        ) : rightTab === "docs" ? (
          reviewingDoc ? (
            <DocReviewPanel feature={reviewingDoc.doc} content={reviewingDoc.content} onSendComments={handleReviewSendComments} onClose={() => setReviewingDoc(null)} />
          ) : (
            <DocsViewer files={docFiles} onFileClick={(f) => { const doc = docFiles.find((d) => d.path === f); handleOpenDoc(f, doc); }} onRefresh={() => { const sid = useSessionStore.getState().sessionId; if (sid) useFileStore.getState().fetchDocs(sid).catch(() => {}); }} onReviewFeature={handleReviewFeature} />
          )
        ) : rightTab === "terminal" ? (
          <TerminalPanel entries={logEntries} onClear={() => { useTerminalStore.getState().clearEntries(); send({ type: "clear_logs" }); }} terminalMode={terminalMode} onTerminalModeChange={(m) => useTerminalStore.getState().setMode(m)} shellContent={
            (shellStarted || terminalMode === "shell") ? (
              <InteractiveTerminal ref={terminalRef} onInput={(d) => send({ type: "terminal_input", data: d })} onResize={(cols, rows) => send({ type: "terminal_resize", cols, rows })} onStart={(cols, rows) => { send({ type: "terminal_start", cols, rows }); useTerminalStore.getState().setShellStarted(true); }} />
            ) : null
          } />
        ) : rightTab === "history" ? (
          <GitHistory commits={gitCommits} onRefresh={() => { const sid = useSessionStore.getState().sessionId; if (sid) useGitStore.getState().fetchLog(sid).catch(() => {}); }} onViewDiff={handleViewDiff} />
        ) : (
          <FileTree tree={fileTree} onRefresh={() => { const sid = useSessionStore.getState().sessionId; if (sid) { useFileStore.getState().fetchTree(sid).catch(() => {}); void useFileStore.getState().hydrateUploads(sid); } }} onFileClick={handleOpenFilePreview} onAddToChat={(f) => useSettingsStore.getState().addPendingFile(f)} onDownload={(f) => { const sid = useSessionStore.getState().sessionId; if (sid) { const a = document.createElement("a"); a.href = `/api/sessions/${sid}/files/download/${f}`; a.download = ""; document.body.appendChild(a); a.click(); a.remove(); } }} uploads={sessionUploads} onDeleteUpload={(u) => { const sid = useSessionStore.getState().sessionId; if (u.path) markUploadDeleted(u.path); if (sid && u.path) { const filename = u.path.replace(/^\/uploads\//, ""); void fetch(`/api/sessions/${sid}/files/uploads/${encodeURIComponent(filename)}`, { method: "DELETE" }); } if (u.previewUrl) URL.revokeObjectURL(u.previewUrl); if (u.path) useFileStore.getState().removeSessionUpload(u.path); else useFileStore.getState().removeSessionUploadById(u.id); }} />
        )}
      </div>
    </>
  );

  // ── Chat panel ──
  const chatPanel = (
    <>
      {searchOpen && <SearchBar query={search.query} onQueryChange={search.setQuery} matches={search.matches} currentMatchIndex={search.currentMatchIndex} onNext={search.goToNext} onPrev={search.goToPrev} onClose={() => { setSearchOpen(false); search.clear(); }} />}
      {!showHomeScreen && !showNewSessionView && currentSession && (
        <SessionTopBar
          title={currentSession.title}
          onRename={(title) => useSessionStore.getState().renameSession(currentSession.id, title)}
          onDownloadChat={handleDownloadChat}
          onArchive={() => { void useSessionStore.getState().archiveSession(currentSession.id); if (activeRepoUrl) void handleNewSessionForRepo(activeRepoUrl); }}
        />
      )}
      {showHomeScreen ? (
        <HomeScreen onAddRepo={() => useRepoStore.getState().setAddRepoDialogOpen(true)} hasRepos={repos.length > 0} />
      ) : (
        <>
          <MessageList messages={messages} isLoading={isLoading} activity={activity} searchMatches={search.matches} currentMatch={search.currentMatch} onAnswerQuestion={handleAnswerQuestion} onSendFollowUp={handleSendFollowUp} onRollback={handleRollback} onRewind={handleRewind} />
          {wsSessionId && <PrLifecycleCard sessionId={wsSessionId} />}
        </>
      )}
      {!showHomeScreen && !showNewSessionView && queuedMessages.length > 0 && <QueueIndicator queue={queuedMessages} onCancel={(pos) => send({ type: "cancel_queued_message", position: pos })} />}
      {(!showHomeScreen || showNewSessionView) && <MessageInput onSend={handleSend} disabled={showNewSessionView ? status !== "open" && !sessionId : status !== "open"} isLoading={isLoading} onInterrupt={() => send({ type: "interrupt_claude" })} permissionMode={permissionMode} onPermissionModeChange={(m) => useSettingsStore.getState().setPermissionMode(m)} pendingFiles={pendingFiles} onRemoveFile={(i) => useSettingsStore.getState().removePendingFile(i)} onAddFile={(f) => useSettingsStore.getState().addPendingFile(f)} fileTree={fileTree} uploads={uploads} allUploads={sessionUploads} onUploadFiles={(files) => void uploadFiles(files)} onRemoveUpload={removeUpload} onRetryUpload={retryUpload} agents={agentList} activeAgentId={activeAgentId} onAgentChange={handleAgentChange} onModelChange={handleModelChange} modelInfo={modelInfo} contextTokens={contextTokens} hasActiveSession={!showNewSessionView && !!sessionId} focusKey={wsSessionId ?? (showNewSessionView ? "new" : undefined)} hasPrCard={hasPrCard} />}
    </>
  );

  // ── Bootstrap loading gate ──
  if (!bootstrapLoaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-(--color-bg-primary)">
        {showBootstrapSpinner && (
          <CircleNotchIcon size={ICON_SIZE.MD} className="animate-spin text-(--color-text-tertiary)" />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-(--color-bg-primary) text-(--color-text-primary)">
      <AuthOverlayContainer
        authUrl={authUrl}
        showOnboarding={showOnboarding}
        onPasteCode={(code: string) => { apiPost("/api/auth/code", { code }).catch(() => {}); }}
        onApiKey={(key: string) => { apiPost("/api/auth/api-key", { key }).catch(() => {}); }}
        gitIdentityNeeded={gitIdentityNeeded}
        agentList={agentList}
        onGitIdentitySubmit={(name: string, email: string) => useGitStore.getState().submitGitIdentity(name, email).catch(() => {})}
        onGitHubTokenSubmit={async (token: string) => { const result = await useSettingsStore.getState().submitGitHubToken(token); if (result) { usePrStore.getState().setImportSearchResults(result.repos); return true; } return false; }}
        onClaudeApiKeySubmit={async (key: string) => { try { await apiPost("/api/auth/api-key", { key }); const data = await apiGet<{ agents: AgentOption[] }>("/api/bootstrap"); useUiStore.getState().setAgentList(data.agents); return true; } catch { return false; } }}
        onCodexApiKeySubmit={async (key: string) => { try { const result = await apiPost<{ agents: AgentOption[] }>(`/api/agents/codex/env`, { key: "OPENAI_API_KEY", value: key }); useUiStore.getState().setAgentList(result.agents); return true; } catch { return false; } }}
        onStartClaudeAuth={() => { apiPost("/api/auth/start", {}).catch(() => {}); }}
        onPasteAuthCode={(code: string) => { apiPost("/api/auth/code", { code }).catch(() => {}); }}
        onRefreshAgents={async () => { const data = await apiGet<{ agents: AgentOption[] }>("/api/bootstrap"); useUiStore.getState().setAgentList(data.agents); }}
        onComplete={() => { setOnboardingDismissed(true); if (gitIdentityNeeded) useGitStore.getState().setIdentityNeeded(false); }}
      />
      {shortcutsOpen && <KeyboardShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}
      {previewFile && previewType && (
        <FilePreviewModal
          filePath={previewFile}
          content={previewContent}
          fileType={previewType}
          actions={previewActions}
          onClose={() => useFileStore.getState().closePreview()}
          onSendComments={handleFileSendComments}
        />
      )}
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
          onFullReset={async () => { try { await apiPost("/api/reset", {}); } catch (err) { console.error("[settings] Full reset failed:", err); } }}
          gitIdentity={gitIdentity}
          onGitIdentitySave={(name, email) => useGitStore.getState().submitGitIdentity(name, email).catch(() => {})}
          maxIdleContainers={maxIdleContainers}
          onMaxIdleContainersSave={async (n) => { try { const raw = await apiPut("/api/settings", { maxIdleContainers: n }); const res = raw as Record<string, unknown>; if (res.maxIdleContainers !== null && res.maxIdleContainers !== undefined) useSettingsStore.getState().setMaxIdleContainers(res.maxIdleContainers as number); } catch (err) { console.error("[settings] Failed to save max idle containers:", err); } }}
          agentSystemInstructionsEnabled={agentSystemInstructionsEnabled}
          agentSystemInstructions={agentSystemInstructions}
          onToggleAgentSystemInstructions={async (enabled) => { try { const raw = await apiPut("/api/settings", { agentSystemInstructionsEnabled: enabled }); const res = raw as Record<string, unknown>; if (res.agentSystemInstructionsEnabled !== undefined) useSettingsStore.getState().setAgentSystemInstructionsEnabled(!!res.agentSystemInstructionsEnabled); } catch (err) { console.error("[settings] Failed to toggle agent system instructions:", err); } }}
          hasActiveSession={!!sessionId}
          repoUrl={currentRepoUrl}
          onSecretsLoad={async (repoUrl) => { const data = await apiGet<{ secrets: Record<string, string> }>(`/api/secrets?repoUrl=${encodeURIComponent(repoUrl)}`); return data.secrets; }}
          onSecretsSave={(repoUrl, secrets) => { apiPut("/api/secrets", { repoUrl, secrets }).catch(() => {}); }}
          onClose={() => { useUiStore.getState().setSettingsOpen(false); useUiStore.getState().setSettingsTab(undefined); }}
        />
      )}
      {showUsageModal && <UsageModal currentSessionUsage={currentSessionUsage} allUsage={allUsageStats} sessions={sessions} onClose={() => useUiStore.getState().setShowUsageModal(false)} modelInfo={modelInfo} contextTokens={contextTokens} turnTokens={turnTokens} />}
      {diffDialogOpen && turnDiff && (
        <Modal onClose={() => useGitStore.getState().closeDiffDialog()} className="w-[90vw] h-[85vh] max-h-[85vh]! overflow-hidden! flex flex-col">
          <Suspense fallback={<div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">Loading diff viewer...</div>}>
            <DiffPanel diff={turnDiff} onClose={() => useGitStore.getState().closeDiffDialog()} commitMessage={diffDialogTitle} onSendComments={handleFileSendComments} />
          </Suspense>
        </Modal>
      )}

      <AppLayout
        theme={theme}
        onSelectTheme={setTheme}
        onSettingsOpen={() => handleSettingsOpen()}
        hasSystemPrompt={hasSystemPrompt}
        githubAuthenticated={githubStatus.authenticated}
        currentSessionUsage={currentSessionUsage}
        dockerMemory={dockerMemory}
        onUsageBadgeClick={handleUsageBadgeClick}
        onNavigateHome={() => navigate("/")}
        onOpenSessions={() => useSessionStore.getState().setAllSessionsDialogOpen(true)}
        showConnectionBanner={!showNewSessionView && !!wsSessionId}
        connectionStatus={status}
        reconnectAttempt={reconnectAttempt}
        onReconnect={reconnect}
        isMobile={isMobile}
        showHomeScreen={showHomeScreen}
        showNewSessionView={showNewSessionView}
        mobilePanel={mobilePanel}
        onMobilePanelChange={(p) => useUiStore.getState().setMobilePanel(p)}
        chatPanel={chatPanel}
        rightPanel={rightPanel}
        fraction={fraction}
        isDragging={isDragging}
        onMouseDown={onMouseDown}
        onTouchStart={onTouchStart}
        containerRef={containerRef}
        sessions={sessions}
        activeRepoUrl={activeRepoUrl}
        activeRepoName={activeRepoName}
        activeRepoStatus={activeRepo?.status}
        currentSessionId={sessionId}
        sidebarCollapsed={sidebarCollapsed}
        onResumeSession={(sid: string) => {
          const session = sessions.find((s) => s.id === sid);
          if (session?.remoteUrl) useRepoStore.getState().setActiveRepoUrl(session.remoteUrl);
          handleSessionResume(sid, navigate);
        }}
        onArchiveSession={async (sid: string) => { await useSessionStore.getState().archiveSession(sid); if (sid === useSessionStore.getState().sessionId && activeRepoUrl) { void handleNewSessionForRepo(activeRepoUrl); } }}
        onOpenRepoSwitcher={() => useRepoStore.getState().setRepoSwitcherOpen(!repoSwitcherOpen)}
        onNewSession={() => { if (activeRepoUrl) void handleNewSessionForRepo(activeRepoUrl); }}
        onToggleSidebarCollapse={() => useUiStore.getState().setSidebarCollapsed(!sidebarCollapsed)}
        repoSwitcherOpen={repoSwitcherOpen}
        onCloseRepoSwitcher={() => useRepoStore.getState().setRepoSwitcherOpen(false)}
        repos={repos}
        onSelectRepo={(url: string) => useRepoStore.getState().setActiveRepoUrl(url)}
        onAddRepo={() => useRepoStore.getState().setAddRepoDialogOpen(true)}
        onCreateNewRepo={() => {
          useRepoStore.getState().setAddRepoDialogOpen(false);
          // eslint-disable-next-line no-restricted-syntax -- fire-and-forget one-liner
          if (templates.length === 0) apiGet<{ templates: typeof templates }>("/api/bootstrap").then((d) => useUiStore.getState().setTemplates(d.templates)).catch(() => {});
          useRepoStore.getState().setNewRepoDialogOpen(true);
        }}
        toast={toast}
        onDismissToast={() => useUiStore.getState().setToast(null)}
      />
      <AddRepoDialog
        open={addRepoDialogOpen}
        onClose={() => useRepoStore.getState().setAddRepoDialogOpen(false)}
        onAdd={async (url) => { await useRepoStore.getState().addRepo(url); }}
        onRepoReady={(url) => { useRepoStore.getState().setActiveRepoUrl(url); void navigate(repoLabelToNewPath(url)); }}
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
      <AllSessionsDialog
        open={allSessionsDialogOpen}
        onClose={() => useSessionStore.getState().setAllSessionsDialogOpen(false)}
        sessions={allSessions}
        repos={repos}
        currentRepoUrl={currentRepoUrl}
        onFetch={() => useSessionStore.getState().fetchAllSessions()}
        onResume={(sid) => handleSessionResume(sid, navigate)}
        onUnarchive={(sid) => useSessionStore.getState().unarchiveSession(sid)}
        onArchive={(sid) => useSessionStore.getState().archiveSession(sid)}
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
              const res = await apiPost<{ success: boolean; repoUrl?: string; message?: string }>(
                "/api/repos",
                { repoName: name, description, isPrivate, templateId },
              );
              if (res.success && res.repoUrl) {
                useRepoStore.getState().setNewRepoDialogOpen(false);
                useRepoStore.getState().setActiveRepoUrl(res.repoUrl);
                void navigate(repoLabelToNewPath(res.repoUrl));
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
