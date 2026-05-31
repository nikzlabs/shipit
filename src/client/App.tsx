// eslint-disable-next-line no-restricted-imports -- useEffect: bootstrap timer (setTimeout cleanup), URL/route sync (browser navigation is external), session claim (AbortController cleanup)
import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from "react";
import { Dialog, DialogContent } from "./components/ui/dialog.js";
import { TooltipProvider } from "./components/ui/tooltip.js";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useSessionWebSocket } from "./hooks/useSessionWebSocket.js";
import { useServerEvents } from "./hooks/useServerEvents.js";
import { useResizablePanel } from "./hooks/useResizablePanel.js";
import { useSearch } from "./hooks/useSearch.js";
import { useIsMobile } from "./hooks/useMediaQuery.js";
import { useNotification } from "./hooks/useNotification.js";
import { useAttentionNotifications } from "./hooks/useAttentionNotifications.js";
import { useTheme } from "./hooks/useTheme.js";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts.js";
import { useQuickCaptureHotkey } from "./hooks/useQuickCaptureHotkey.js";
import { useConnectionSync } from "./hooks/useConnectionSync.js";
import { useAutoFix } from "./hooks/useAutoFix.js";
import { CircleNotchIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "./design-tokens.js";
import { useMessageHandler } from "./hooks/useMessageHandler.js";
import { useApi } from "./hooks/useApi.js";
import { formatErrorForMessage } from "./components/PreviewFrame.js";
import { MessageInput, type SendPayload } from "./components/MessageInput.js";
import { MessageList } from "./components/MessageList.js";
import type { RewindGapAction } from "./components/RewindPoint.js";
import { RocketLaunch } from "./components/RocketLaunch.js";
import { PreviewFrame } from "./components/PreviewFrame.js";
import { usePreviewErrors, type PreviewError } from "./hooks/usePreviewErrors.js";
import { GitHistory } from "./components/GitHistory.js";
import { AuthOverlayContainer } from "./AuthOverlay.js";
import { Settings } from "./components/Settings.js";
import { ProjectSettings } from "./components/ProjectSettings.js";
import { AppLayout } from "./AppLayout.js";
import { DocsViewer } from "./components/DocsViewer.js";
import { FileTree } from "./components/FileTree.js";
import { FilePreviewModal } from "./components/FilePreviewModal.js";
import { TerminalPanel } from "./components/TerminalPanel.js";
import { InteractiveTerminal, type InteractiveTerminalHandle } from "./components/InteractiveTerminal.js";
import { ServicesPanel } from "./components/ServicesPanel.js";
import { SearchBar } from "./components/SearchBar.js";
import { KeyboardShortcutsOverlay } from "./components/KeyboardShortcutsOverlay.js";
import { HomeScreen } from "./components/HomeScreen.js";
import { AddRepoDialog } from "./components/AddRepoDialog.js";
import { AllSessionsDialog } from "./components/AllSessionsDialog.js";
import { NewRepoDialog } from "./components/NewRepoDialog.js";
import { UsageModal } from "./components/UsageModal.js";
import type { TurnDiffData } from "./components/DiffPanel.js";
import type { TurnUsage } from "../server/shared/types.js";
import { deriveEffectivePreviewStatus } from "./utils/preview-status.js";

/** Stable empty fallback so the zustand selector never returns a fresh array. */
const EMPTY_TURN_USAGE: TurnUsage[] = [];

// eslint-disable-next-line no-restricted-syntax -- lazy() named-export pattern
const DiffPanel = lazy(() => import("./components/DiffPanel.js").then(m => ({ default: m.DiffPanel })));
import { PrLifecycleCard } from "./components/PrLifecycleCard.js";
import { PrDetailPanel } from "./components/PrDetailPanel.js";
import { PresentPane } from "./components/PresentPane.js";
import { HostPanel } from "./components/HostPanel.js";
import { RebaseBanner } from "./components/RebaseBanner.js";
import { QueueIndicator } from "./components/QueueIndicator.js";
import { AgentStatusBar } from "./components/AgentStatusBar.js";
import type { AgentOption } from "./agent-types.js";
import type { AgentId, DocEntry, ProviderAccount } from "../server/shared/types.js";

import { useSessionStore } from "./stores/session-store.js";
import { useGitStore } from "./stores/git-store.js";
import { useFileStore, markUploadDeleted } from "./stores/file-store.js";
import { usePreviewStore } from "./stores/preview-store.js";
import { usePresentStore } from "./stores/present-store.js";
import { useTerminalStore } from "./stores/terminal-store.js";
import { usePrStore } from "./stores/pr-store.js";
import { useSettingsStore } from "./stores/settings-store.js";
import { useUiStore } from "./stores/ui-store.js";
import { useRepoStore } from "./stores/repo-store.js";
import { useFileReviewStore } from "./stores/file-review-store.js";
import { composeReviewMessage } from "./utils/compose-review-body.js";
import { resumeSessionInternal, handleSessionResume, resetSessionState } from "./stores/actions/session-actions.js";
import { parseRepoLabel, repoLabelToNewPath, parseNewSessionSlug, shouldAdoptClaimedSession } from "./utils/repo-label.js";
import { saveAgentId, saveModelId } from "./utils/local-storage.js";
import { siblingsOf, orderSiblingsForTabs, siblingTabLabel } from "./utils/doc-paths.js";
import { dispatchAgentMessage } from "./utils/dispatch-agent-message.js";
import { sendUserMessage } from "./utils/send-user-message.js";
import type { SendCommentsPayload } from "./components/FilePreviewModal.js";

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
  const { send, lastMessage, drainMessages, status, reconnectAttempt, reconnect } = useSessionWebSocket(wsSessionId);
  const { get: apiGet, post: apiPost, put: apiPut, del: apiDel } = useApi();
  const claimAbortRef = useRef<AbortController | null>(null);
  const previousNewSessionRouteRef = useRef<string | undefined>(undefined);
  const terminalRef = useRef<InteractiveTerminalHandle>(null);
  const messages = useSessionStore((s) => s.messages);
  const rewindRecoveries = useSessionStore((s) => s.rewindRecoveries);
  const rewindPreviews = useSessionStore((s) => s.rewindPreviews);
  const isLoading = useSessionStore((s) => s.isLoading);
  const activity = useSessionStore((s) => s.activity);
  const sessions = useSessionStore((s) => s.sessions);
  const authUrl = useSessionStore((s) => s.authUrl);
  const queuedMessages = useSessionStore((s) => s.queuedMessages);
  const historyLoaded = useSessionStore((s) => s.historyLoaded);
  // Per-turn usage for the active session — feeds the UsageModal's per-turn
  // breakdown. Sourced from `usage_turns` via `/history` so reload-time data
  // is complete (not just turns observed during the current WS connection).
  const turnUsageForActiveSession = useSessionStore((s) =>
    sessionId ? s.turnUsage[sessionId] ?? EMPTY_TURN_USAGE : EMPTY_TURN_USAGE,
  );

  // Upload chips, the "+" attach button, and drop-zone behavior live inside
  // MessageInput now (docs/145) — the chat parent only needs the session-wide
  // upload list for the side panel (file tree → attached uploads section).
  const sessionUploads = useFileStore((s) => s.sessionUploads);

  const gitCommits = useGitStore((s) => s.commits);
  const gitIdentityNeeded = useGitStore((s) => s.identityNeeded);
  const gitIdentity = useGitStore((s) => s.identity);
  const turnDiff = useGitStore((s) => s.turnDiff);
  const diffDialogOpen = useGitStore((s) => s.diffDialogOpen);
  const diffDialogTitle = useGitStore((s) => s.diffDialogTitle);

  const fileTree = useFileStore((s) => s.tree);
  const docFiles = useFileStore((s) => s.docFiles);
  const skills = useFileStore((s) => s.skills);
  const previewFile = useFileStore((s) => s.previewFile);
  const previewContent = useFileStore((s) => s.previewContent);
  const previewType = useFileStore((s) => s.previewType);
  const previewActions = useFileStore((s) => s.previewActions);
  const previewMode = useFileStore((s) => s.previewMode);
  const previewAgentReview = useFileStore((s) => s.previewAgentReview);
  const previewLoading = useFileStore((s) => s.previewLoading);

  const previewStatus = usePreviewStore((s) => s.status);
  const selectedPort = usePreviewStore((s) => s.selectedPort);
  const composeServices = usePreviewStore((s) => s.services);
  const presentations = usePresentStore((s) => s.presentations);
  const presentUnseenCount = usePresentStore((s) => s.unseenCount);

  const logEntries = useTerminalStore((s) => s.entries);

  const terminalMode = useTerminalStore((s) => s.mode);
  const shellStarted = useTerminalStore((s) => s.shellStarted);

  const importSearchResults = usePrStore((s) => s.importSearchResults);
  // The PR tab is shown only when the active session actually has a PR (open,
  // merged, or closed) — mirroring how the Services tab is conditional on
  // composeServices. The ready/creating/error phases have no PR to detail.
  const hasPr = usePrStore((s) => {
    if (!wsSessionId) return false;
    const card = s.cardBySession[wsSessionId];
    return !!card?.pr && (card.phase === "open" || card.phase === "merged" || card.phase === "closed");
  });
  const prCardsBySession = usePrStore((s) => s.cardBySession);
  const mergedPreviewSessionIds = useMemo(
    () => Object.entries(prCardsBySession)
      .filter(([, card]) => card.phase === "merged")
      .map(([id]) => id),
    [prCardsBySession],
  );

  // Permission mode is keyed per-session (with a fallback to the pre-session
  // default). This subscription recomputes whenever wsSessionId or any
  // settings-store field changes, so toggling plan mode in one session never
  // leaks into the toggle/Accept-button state of another session.
  const permissionMode = useSettingsStore((s) =>
    wsSessionId && wsSessionId in s.permissionModeBySession
      ? s.permissionModeBySession[wsSessionId]
      : s.permissionMode,
  );
  const pendingFiles = useSettingsStore((s) => s.pendingFiles);
  const githubStatus = useSettingsStore((s) => s.githubStatus);
  const hasSystemPrompt = useSettingsStore((s) => s.hasSystemPrompt);
  const systemPromptContent = useSettingsStore((s) => s.systemPromptContent);
  const agentSystemInstructionsEnabled = useSettingsStore((s) => s.agentSystemInstructionsEnabled);
  const agentSystemInstructions = useSettingsStore((s) => s.agentSystemInstructions);
  const maxIdleContainers = useSettingsStore((s) => s.maxIdleContainers);
  const codexDeviceAuth = useSettingsStore((s) => s.codexDeviceAuth);
  const codexDeviceAuthError = useSettingsStore((s) => s.codexDeviceAuthError);

  const rightTabRaw = useUiStore((s) => s.rightTab);
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  // Feature 118 (local mode): the Preview and Terminal panels are
  // container-backed and don't function in the in-process orchestrator, so we
  // hide their tabs. Coerce a persisted "preview"/"terminal" selection to a
  // panel that does work, so the right panel never lands on a dead tab.
  const isLocalMode = runtimeMode === "local";
  // docs/128 — an ops session has no app preview and no PR lifecycle, so those
  // tabs are hidden; a dedicated read-only "Host" tab takes their place. Coerce
  // a persisted preview/pr selection to Host so the panel never lands on a tab
  // that isn't rendered for this kind of session.
  const isOpsSession = useMemo(
    () => sessions.find((s) => s.id === wsSessionId)?.kind === "ops",
    [sessions, wsSessionId],
  );
  const rightTab = (() => {
    if (isOpsSession && (rightTabRaw === "preview" || rightTabRaw === "pr")) return "host";
    if (!isOpsSession && rightTabRaw === "host") return "files";
    if (isLocalMode && (rightTabRaw === "preview" || rightTabRaw === "terminal")) return "files";
    return rightTabRaw;
  })();
  const mobilePanel = useUiStore((s) => s.mobilePanel);
  const showTemplates = useUiStore((s) => s.showTemplates);
  const templates = useUiStore((s) => s.templates);
  const agentList = useUiStore((s) => s.agentList);
  const activeAgentId = useUiStore((s) => s.activeAgentId);
  const liveSteering = useSettingsStore((s) => s.liveSteering);
  const showUsageModal = useUiStore((s) => s.showUsageModal);
  const currentSessionUsage = useUiStore((s) => s.currentSessionUsage);
  const allUsageStats = useUiStore((s) => s.allUsageStats);
  const modelInfo = useUiStore((s) => s.modelInfo);
  const contextTokens = useUiStore((s) => s.contextTokens);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const quickCaptureHotkey = useSettingsStore((s) => s.quickCaptureHotkey);
  const voiceInputEnabled = useSettingsStore((s) => s.voiceInputEnabled);
  const voiceHotkeyModeB = useSettingsStore((s) => s.voiceHotkeyModeB);
  const projectSettingsRepoUrl = useUiStore((s) => s.projectSettingsRepoUrl);
  const projectSettingsTab = useUiStore((s) => s.projectSettingsTab);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const mobileSidebarOpen = useUiStore((s) => s.mobileSidebarOpen);
  const toast = useUiStore((s) => s.toast);
  const dockerMemory = useUiStore((s) => s.dockerMemory);
  const processStartedAt = useUiStore((s) => s.processStartedAt);
  const subscriptionLimits = useUiStore((s) => s.subscriptionLimits);

  const bootstrapLoaded = useUiStore((s) => s.bootstrapLoaded);

  const repos = useRepoStore((s) => s.repos);
  const activeRepoUrl = useRepoStore((s) => s.activeRepoUrl);
  const addRepoDialogOpen = useRepoStore((s) => s.addRepoDialogOpen);
  const newRepoDialogOpen = useRepoStore((s) => s.newRepoDialogOpen);
  const creatingRepo = useSessionStore((s) => s.creatingRepo);
  const allSessionsDialogOpen = useSessionStore((s) => s.allSessionsDialogOpen);
  const allSessions = useSessionStore((s) => s.allSessions);
  const currentSession = useMemo(
    () => sessions.find((s) => s.id === sessionId),
    [sessions, sessionId],
  );
  const currentRepoUrl = currentSession?.remoteUrl;

  const liveSteeringActive = liveSteering && (agentList.find((a) => a.id === activeAgentId)?.supportsSteering ?? false);

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
  // Derive the repo URL from the /{slug}/new URL pattern (replaces useState)
  const newSessionRepoUrl = useMemo(() => {
    if (!newSessionRepoSlug) return undefined;
    return repos.find((r) => parseRepoLabel(r.url) === newSessionRepoSlug)?.url;
  }, [newSessionRepoSlug, repos]);
  const search = useSearch(messages);
  const { notify, requestPermission } = useNotification();
  useAttentionNotifications(notify);
  const { theme, setTheme } = useTheme();
  const { errors: previewErrors, clearErrors: clearPreviewErrors } = usePreviewErrors();

  const { disableAutoFix } = useAutoFix({
    previewErrors,
    isLoading,
    status,
  });

  // useKeyboardShortcuts is called after handleNewSessionForRepo is defined
  // (further down) — the new-session shortcut needs it. See below.

  useConnectionSync({ status, send, onSessionConnect: (sid: string) => {
    void useFileStore.getState().hydrateUploads(sid);
    // Load user-invocable skills for the composer's `/` autocomplete (doc 138).
    void useFileStore.getState().fetchSkills(sid, useUiStore.getState().activeAgentId).catch(() => {});
    // Re-fetch docs if the docs tab is currently active. loadSessionHistory()
    // populates the file tree and commit log but not docs, so without this a
    // session switch leaves the DocsViewer stuck on "No docs found" until the
    // user clicks Refresh.
    if (useUiStore.getState().rightTab === "docs") {
      void useFileStore.getState().fetchDocs(sid).catch(() => {});
    }
  } });

  // Delayed spinner for bootstrap loading gate — only show after 1s
  const [showBootstrapSpinner, setShowBootstrapSpinner] = useState(false);
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (bootstrapLoaded) return;
    const timer = setTimeout(() => setShowBootstrapSpinner(true), 1000);
    return () => clearTimeout(timer);
  }, [bootstrapLoaded]);

  useMessageHandler({
    lastMessage,
    drainMessages,
    send,
    terminalRef,
  });

  // eslint-disable-next-line no-restricted-syntax -- browser event bridges toast/topbar actions to the active WS sender
  useEffect(() => {
    const handleRestore = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      const targetSessionId = detail?.sessionId ?? useSessionStore.getState().sessionId;
      if (targetSessionId) send({ type: "rewind_restore_request", sessionId: targetSessionId });
    };
    window.addEventListener("shipit:restore-rewind", handleRestore);
    return () => window.removeEventListener("shipit:restore-rewind", handleRestore);
  }, [send]);

  // Initialize sessionId from URL on mount
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (urlSessionId) {
      useSessionStore.getState().setSessionId(urlSessionId);
    }
    if (!urlSessionId && !isNewSessionRoute) {
      useUiStore.getState().setShowTemplates(true);
    }
  }, []);

  // Sync session state with the URL. Keep `sessionId` in the dependency list:
  // late async writers (claim-session/history paths) can update the store
  // after the route is already on a different session, and the URL must win.
  // WS auto-connects/disconnects via useSessionWebSocket(wsSessionId)
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const newSessionRouteKey = isNewSessionRoute ? newSessionRepoSlug : undefined;
    if (newSessionRouteKey && previousNewSessionRouteRef.current !== newSessionRouteKey) {
      previousNewSessionRouteRef.current = newSessionRouteKey;
      if (sessionId) {
        useSessionStore.getState().setSessionId(undefined);
        resetSessionState();
        disableAutoFix();
      }
      return;
    }
    if (!newSessionRouteKey) {
      previousNewSessionRouteRef.current = undefined;
    }

    if (urlSessionId && urlSessionId !== sessionId) {
      resumeSessionInternal(urlSessionId);
      disableAutoFix();
    } else if (!urlSessionId && !isNewSessionRoute && sessionId) {
      // Clear stale sessionId — prevents WS from connecting to old session.
      useSessionStore.getState().setSessionId(undefined);
      resetSessionState();
      disableAutoFix();
      useUiStore.getState().setShowTemplates(true);
    }
  }, [urlSessionId, sessionId, isNewSessionRoute, newSessionRepoSlug, disableAutoFix]);

  // Auto-claim session when landing on /{slug}/new (direct URL navigation or page refresh)
  // eslint-disable-next-line no-restricted-syntax -- existing usage
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
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (isNewSessionRoute && !newSessionRepoUrl && bootstrapLoaded && repos.length > 0) {
      void navigate("/", { replace: true });
    }
  }, [isNewSessionRoute, newSessionRepoUrl, bootstrapLoaded, repos.length, navigate]);

  // ── Callback helpers ──
  const handleSend = useCallback(
    async (payload: SendPayload) => {
      const { text, uploadRefs, uploads: payloadUploads } = payload;
      // docs/125 — `/review [@path]` is the chat-native entry point to AI
      // review: same composed prompt as the modal button, routed through
      // `send_review_message` so the orchestrator authorizes the review tool.
      const trimmed = text.trim();
      if (/^\/review(?:\s|$)/.test(trimmed)) {
        const argMatch = /^\/review\s+@?(\S+)/.exec(trimmed);
        const targetFile = argMatch?.[1] ?? useFileStore.getState().previewFile ?? undefined;
        const sid = useSessionStore.getState().sessionId;
        if (!sid) {
          useUiStore.getState().setToast({ message: "Start a session before running /review." });
          return;
        }
        if (useSessionStore.getState().isLoading) {
          useUiStore.getState().setToast({
            message: "Wait for the current turn to finish before running /review.",
          });
          return;
        }
        if (!targetFile) {
          useUiStore.getState().setToast({
            message: "/review needs a file — open one in preview, or use /review @path/to/file.",
          });
          return;
        }
        const reviewStore = useFileReviewStore.getState();
        // Ensure a draft exists so the review tool has somewhere to write and
        // the server can tell "sent mid-review" from "fresh review".
        await reviewStore.load(sid, targetFile);
        const prompt = composeReviewMessage(
          targetFile,
          reviewStore.getDraft(sid, targetFile),
          reviewStore.getHistory(sid, targetFile),
        );
        useFileStore.getState().closePreview();
        sendUserMessage({
          bubble: { role: "user", text: prompt },
          activity: "Reviewing...",
          dispatch: () => send({ type: "send_review_message", text: prompt, sessionId: sid, reviewFilePath: targetFile }),
        });
        return;
      }

      requestPermission();
      disableAutoFix();
      const session = useSessionStore.getState();
      const settings = useSettingsStore.getState();
      useUiStore.getState().setShowTemplates(false);
      // Separate image uploads (have previewUrl) from non-image uploads for display
      const readyUploads = payloadUploads.filter((u) => u.status === "ready" && u.path);
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

      const currentSessionId = session.sessionId;
      if (currentSessionId) {
        // On /{slug}/new route — graduate: transition URL to /session/{id}
        if (isNewSessionRoute) {
          void navigate(`/session/${currentSessionId}`, { replace: true });
        }

        const message = {
          type: "send_message" as const,
          text,
          sessionId: currentSessionId,
          files: settings.pendingFiles.length > 0 ? settings.pendingFiles : undefined,
          uploads: uploadRefs.length > 0 ? uploadRefs : undefined,
          permissionMode: (() => {
            const pm = settings.getPermissionMode(currentSessionId);
            return pm !== "auto" ? pm : undefined;
          })(),
        };

        sendUserMessage({
          bubble: { role: "user", text, files: filesForMessage, images: imagesForMessage, uploadPaths: uploadPathsForMessage },
          activity: "Thinking...",
          dispatch: () => {
            if (status === "open") {
              // Send directly over WS
              send(message);
            } else {
              // The session exists but the WS isn't open yet — e.g. we just claimed
              // a session on /{slug}/new and the socket is still connecting. Calling
              // send() here would silently drop the message (useWebSocket.send only
              // writes when readyState === OPEN), leaving the user with an optimistic
              // bubble + spinner and no response. Stash it so useConnectionSync
              // flushes it the moment the WS opens. (docs/144 fix #2)
              useSessionStore.getState().setPendingWsMessage(message);
            }
          },
        });
      } else {
        // No session — can't send without one (sessions are created via claim-session).
        // Still append the optimistic bubble so the user sees what they typed,
        // but DON'T flip isLoading: there's no agent to wait on.
        console.warn("[session] No active session — cannot send message");
        session.setMessages((prev) => [...prev, { role: "user", text, files: filesForMessage, images: imagesForMessage, uploadPaths: uploadPathsForMessage }]);
      }
      settings.clearPendingFiles();
      // MessageInput has already cleared its own upload chips at this point.
    },
    [send, status, requestPermission, disableAutoFix, navigate, isNewSessionRoute],
  );

  const handleRequestRewindPreview = useCallback(
    (gapPosition: number, action: RewindGapAction) => {
      send({ type: "rewind_preview_request", gapPosition, action });
    },
    [send],
  );

  const handleRewindAtGap = useCallback(
    (gapPosition: number, action: RewindGapAction, sessionName?: string) => {
      if (action === "fork") {
        send({ type: "rewind_at_gap", gapPosition, action, sessionName: sessionName?.trim() || undefined });
        return;
      }
      send({ type: "rewind_at_gap", gapPosition, action });
    },
    [send],
  );

  // docs/150 — one in-flight ref per converted callsite swallows rapid
  // double-clicks (compose-error overlays can flicker as services restart).
  // The ref is set true at dispatch start and cleared in `.finally`; the
  // existing `isLoading` flag also disables most buttons.
  const sendErrorsInFlight = useRef(false);
  const createPrInFlight = useRef(false);
  const composeErrorInFlight = useRef(false);
  const composeHintInFlight = useRef(false);
  const serviceLogsInFlight = useRef(false);

  const handleSendErrors = useCallback(
    (errors: PreviewError[]) => {
      if (sendErrorsInFlight.current) return;
      const sid = useSessionStore.getState().sessionId;
      if (!sid) return;
      const text = formatErrorForMessage(errors);
      requestPermission();
      useUiStore.getState().setShowTemplates(false);
      sendErrorsInFlight.current = true;
      void dispatchAgentMessage({ sessionId: sid, text, activity: "Fixing preview errors…", apiPost })
        .catch(() => { /* helper surfaces toast */ })
        .finally(() => { sendErrorsInFlight.current = false; });
    },
    [requestPermission, apiPost],
  );

  // "Create PR" on the PR lifecycle card dispatches a turn to the agent (via
  // the docs/150 HTTP dispatch route) instead of calling the orchestrator's
  // quick-create route. The agent has the turn-by-turn context (what changed,
  // why, which files), so it picks a better title and writes a more accurate
  // Summary/Changes/Test plan body than the server-side LLM call could.
  const handleCreatePr = useCallback(() => {
    if (createPrInFlight.current) return;
    const sid = useSessionStore.getState().sessionId;
    if (!sid) return;
    const text = "Please create a pull request for the changes in this session.";
    requestPermission();
    useUiStore.getState().setShowTemplates(false);
    createPrInFlight.current = true;
    void dispatchAgentMessage({ sessionId: sid, text, activity: "Creating PR…", apiPost })
      .catch(() => { /* helper surfaces toast */ })
      .finally(() => { createPrInFlight.current = false; });
  }, [requestPermission, apiPost]);

  const handleSendComposeErrorToAgent = useCallback(() => {
    if (composeErrorInFlight.current) return;
    const { composeError } = usePreviewStore.getState();
    if (!composeError) return;
    const sid = useSessionStore.getState().sessionId;
    if (!sid) return;
    const text = `Docker Compose failed to start:\n\n\`\`\`\n${composeError.trim()}\n\`\`\`\n\nPlease fix this error so the services can start successfully.`;
    requestPermission();
    composeErrorInFlight.current = true;
    void dispatchAgentMessage({ sessionId: sid, text, activity: "Fixing compose error…", apiPost })
      .catch(() => { /* helper surfaces toast */ })
      .finally(() => { composeErrorInFlight.current = false; });
  }, [requestPermission, apiPost]);

  const handleSendComposeHintToAgent = useCallback(() => {
    if (composeHintInFlight.current) return;
    const sid = useSessionStore.getState().sessionId;
    if (!sid) return;
    const text = "The preview panel needs a Docker Compose configuration. Please add a `compose` key to `shipit.yaml` pointing to the project's compose file so that previews can be enabled.";
    requestPermission();
    composeHintInFlight.current = true;
    void dispatchAgentMessage({ sessionId: sid, text, activity: "Setting up preview…", apiPost })
      .catch(() => { /* helper surfaces toast */ })
      .finally(() => { composeHintInFlight.current = false; });
  }, [requestPermission, apiPost]);

  const handleSendServiceLogsToAgent = useCallback((serviceName: string, status: string, logs: string) => {
    if (serviceLogsInFlight.current) return;
    const sid = useSessionStore.getState().sessionId;
    if (!sid) return;
    const lines = [`The Docker Compose service "${serviceName}" is in state "${status}". Recent logs:`, ""];
    if (logs) {
      lines.push("```", logs, "```", "");
    }
    lines.push("Please investigate and fix the issue.");
    const text = lines.join("\n");
    requestPermission();
    serviceLogsInFlight.current = true;
    void dispatchAgentMessage({ sessionId: sid, text, activity: "Investigating service…", apiPost })
      .catch(() => { /* helper surfaces toast */ })
      .finally(() => { serviceLogsInFlight.current = false; });
  }, [requestPermission, apiPost]);

  const handleAnswerQuestion = useCallback(
    (toolUseId: string, answers: Record<string, string>, text: string) => {
      sendUserMessage({
        bubble: { role: "user", text },
        activity: "Thinking...",
        dispatch: () => send({ type: "answer_question", toolUseId, answers, text }),
      });
    },
    [send],
  );

  const handleSendFollowUp = useCallback(
    (text: string) => {
      const session = useSessionStore.getState();
      const pm = useSettingsStore.getState().getPermissionMode(session.sessionId);
      sendUserMessage({
        bubble: { role: "user", text },
        activity: "Thinking...",
        dispatch: () => send({
          type: "send_message",
          text,
          sessionId: session.sessionId,
          permissionMode: pm !== "auto" ? pm : undefined,
        }),
      });
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
      // Guard against a late-resolving claim clobbering the active session.
      // `ac` is only aborted by a *subsequent* "New Session" click — NOT by the
      // user navigating to an existing session (handleSessionResume) while the
      // claim is in flight. Without the URL check, a claim that resolves after
      // such a navigation would overwrite the store's sessionId with the
      // freshly-claimed warm session, and the user's next message would
      // graduate that warm session into a brand-new session instead of going
      // to the session they switched to. See shouldAdoptClaimedSession.
      if (
        shouldAdoptClaimedSession({
          claimed: !!result,
          aborted: ac.signal.aborted,
          currentPathname: window.location.pathname,
          repoUrl,
        })
      ) {
        useSessionStore.getState().setSessionId(result!.sessionId);
      }
    },
    [navigate],
  );

  // Keyboard shortcut: Cmd/Ctrl+Shift+O. Prefers the current session's repo,
  // then the active repo, then falls back to navigating home.
  const handleNewSessionShortcut = useCallback(() => {
    const session = useSessionStore.getState();
    const currentRepo = session.sessions.find((s) => s.id === session.sessionId)?.remoteUrl;
    const repo = currentRepo ?? useRepoStore.getState().activeRepoUrl;
    if (repo) {
      void handleNewSessionForRepo(repo);
    } else {
      void navigate("/");
    }
  }, [handleNewSessionForRepo, navigate]);

  useKeyboardShortcuts({
    searchOpen,
    shortcutsOpen,
    setShortcutsOpen: (updater) => setShortcutsOpen(updater),
    isLoading,
    settingsOpen,
    handleInterrupt: () => send({ type: "interrupt_agent" }),
    handleNewSession: handleNewSessionShortcut,
  });

  useQuickCaptureHotkey(quickCaptureHotkey, () => {
    useUiStore.getState().setQuickCaptureOpen(true);
  });

  // docs/144 Mode B — voice hotkey opens the overlay *and* auto-starts mic.
  // Only active when voice input is enabled; reuses the same conflict-checked
  // matcher as the text-only quick-capture hotkey.
  useQuickCaptureHotkey(voiceInputEnabled ? voiceHotkeyModeB : "", () => {
    useUiStore.getState().setQuickCaptureOpen(true, true);
  });

  const handleTabChange = useCallback(
    (tab: "preview" | "docs" | "files" | "terminal" | "history" | "services" | "pr" | "host" | "present") => {
      useUiStore.getState().setRightTab(tab);
      const sid = useSessionStore.getState().sessionId;
      if (tab === "docs" && useFileStore.getState().docFiles.length === 0 && sid) useFileStore.getState().fetchDocs(sid).catch(() => {});
      if (tab === "files" && sid) { useFileStore.getState().fetchTree(sid).catch(() => {}); }
      if (tab === "history" && sid) useGitStore.getState().fetchLog(sid).catch(() => {});
      if (tab === "present") usePresentStore.getState().markSeen();
    },
    [],
  );

  // docs/133 Phase 4: tell the server whether the PR tab is the active
  // right-panel tab for this session, so the poller fetches the heavier
  // conversation fields (issue comments + review threads) only while the panel
  // is open. Keyed on connection status so it re-emits across reconnects and
  // session switches; `send` no-ops when the socket is closed.
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (!wsSessionId || status !== "open") return;
    const active = rightTab === "pr" && hasPr;
    if (!active) return;
    send({ type: "pr_tab_active", sessionId: wsSessionId, active: true });
    return () => {
      send({ type: "pr_tab_active", sessionId: wsSessionId, active: false });
    };
  }, [rightTab, hasPr, wsSessionId, status, send]);

  const handleSettingsOpen = useCallback(async (tab?: "agent-claude" | "agent-codex" | "github" | "git" | "instructions" | "advanced") => {
    useUiStore.getState().setSettingsTab(tab);
    useUiStore.getState().setSettingsOpen(true);
    try {
      const data = await apiGet<{ settings: { gitIdentity: { name: string; email: string }; systemPrompt: string; agents: AgentOption[]; maxIdleContainers?: number; agentSystemInstructionsEnabled?: boolean; agentSystemInstructions?: string; autoCreatePr?: boolean; liveSteering?: boolean; autoResolveConflicts?: boolean; providerAccounts?: ProviderAccount[] }; previewSubdomains?: "auto" | "always" }>("/api/bootstrap");
      useGitStore.getState().setIdentity(data.settings.gitIdentity);
      useSettingsStore.getState().setSystemPromptContent(data.settings.systemPrompt);
      useSettingsStore.getState().setHasSystemPrompt(data.settings.systemPrompt.length > 0);
      if (data.settings.maxIdleContainers !== null && data.settings.maxIdleContainers !== undefined) useSettingsStore.getState().setMaxIdleContainers(data.settings.maxIdleContainers);
      if (data.settings.agentSystemInstructionsEnabled !== undefined) useSettingsStore.getState().setAgentSystemInstructionsEnabled(data.settings.agentSystemInstructionsEnabled);
      if (data.settings.agentSystemInstructions) useSettingsStore.getState().setAgentSystemInstructions(data.settings.agentSystemInstructions);
      if (data.settings.autoCreatePr !== undefined) useSettingsStore.getState().setAutoCreatePr(data.settings.autoCreatePr);
      if (data.settings.liveSteering !== undefined) useSettingsStore.getState().setLiveSteering(data.settings.liveSteering);
      if (data.settings.autoResolveConflicts !== undefined) useSettingsStore.getState().setAutoResolveConflicts(data.settings.autoResolveConflicts);
      if (data.settings.providerAccounts) useSettingsStore.getState().setProviderAccounts(data.settings.providerAccounts);
      useUiStore.getState().setAgentList(data.settings.agents);
      useUiStore.getState().setPreviewSubdomains(data.previewSubdomains ?? "auto");
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
    async (doc: DocEntry) => {
      useFileStore.getState().closePreview();

      const { messages, sessions, sessionId } = useSessionStore.getState();
      // Prefer the current session's repo — the doc was opened from this
      // session's workspace, so a fresh session for it must land in the same
      // repo. `activeRepoUrl` is only a fallback because it can drift away
      // from the current session on URL-based navigation.
      const repoUrl =
        sessions.find((s) => s.id === sessionId)?.remoteUrl ??
        useRepoStore.getState().activeRepoUrl;

      // If the current session already has messages, switch to a fresh session first
      if (messages.length > 0 && repoUrl) {
        await handleNewSessionForRepo(repoUrl);
      }

      const text = `Work on: ${doc.title}\n\nPlease read the plan at ${doc.path}, then proceed with the implementation.`;
      useSessionStore.getState().setPrefillText(text);
      useUiStore.getState().setMobilePanel("chat");
    },
    [handleNewSessionForRepo],
  );

  const handleFileSendComments = useCallback(
    (payload: SendCommentsPayload) => {
      const { prompt, filePaths, commentCount } = payload;
      useFileStore.getState().closePreview();
      useUiStore.getState().setMobilePanel("chat");
      const sid = useSessionStore.getState().sessionId;
      sendUserMessage({
        bubble: {
          role: "user",
          text: prompt,
          userReview: { filePaths, commentCount },
        },
        activity: "Working on comments...",
        dispatch: () => send({ type: "send_message", text: prompt, sessionId: sid ?? undefined }),
      });
    },
    [send],
  );

  // docs/125 — "Ask agent to review": start a chat-native review turn. Distinct
  // from send_message so the orchestrator authorizes the review tool for this
  // file. Closing the modal shifts focus to the chat where the agent works;
  // new AI comments stream back into the (reopened) modal via `review_updated`.
  const handleAskAgentReview = useCallback(
    (prompt: string, reviewFilePath: string) => {
      const sid = useSessionStore.getState().sessionId;
      useFileStore.getState().closePreview();
      useUiStore.getState().setMobilePanel("chat");
      sendUserMessage({
        bubble: { role: "user", text: prompt },
        activity: "Reviewing...",
        dispatch: () => send({ type: "send_review_message", text: prompt, sessionId: sid, reviewFilePath }),
      });
    },
    [send],
  );

  const handleSwitchSibling = useCallback(
    (path: string) => {
      const doc = useFileStore.getState().docFiles.find((d) => d.path === path);
      handleOpenDoc(path, doc);
    },
    [handleOpenDoc],
  );

  // Sibling tabs for the preview modal: only computed for markdown previews
  // (the tab strip is meaningful for docs, not arbitrary code/binary files).
  const previewSiblings = useMemo(() => {
    if (!previewFile || previewType !== "markdown") return undefined;
    const inDir = siblingsOf(previewFile, docFiles);
    if (inDir.length < 2) return undefined;
    return orderSiblingsForTabs(inDir).map((d) => ({
      path: d.path,
      label: siblingTabLabel(d.path),
    }));
  }, [previewFile, previewType, docFiles]);

  const handleUsageBadgeClick = useCallback(() => {
    useUiStore.getState().setShowUsageModal(true);
    const sid = useSessionStore.getState().sessionId;
    if (sid) useUiStore.getState().fetchUsageStats(sid).catch(() => {});
  }, []);

  const handleAgentChange = useCallback((agentId: AgentId) => {
    saveAgentId(agentId);
    useUiStore.getState().setActiveAgentId(agentId);
    send({ type: "set_agent", agentId });
    // Skills are per-backend (Claude scans .claude/skills, Codex .codex/skills),
    // so re-fetch when the active agent switches.
    const sid = useSessionStore.getState().sessionId;
    if (sid) void useFileStore.getState().fetchSkills(sid, agentId).catch(() => {});
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
  // Derive an effective preview status from the union of `preview_status` and
  // `service_status`. The orchestrator emits both whenever a compose service
  // changes state, but `preview_status` can lag `service_status` in some
  // races (most visibly when dogfooding ShipIt-in-ShipIt with a manual `dev`
  // service) — see `utils/preview-status.ts` for the full rationale.
  const effectivePreviewStatus = deriveEffectivePreviewStatus(
    previewStatus,
    composeServices,
    sessionId,
  );
  const detectedPorts = effectivePreviewStatus?.detectedPorts ?? [];
  const showNewSessionView = isNewSessionRoute && !urlSessionId;
  const showHomeScreen = !showNewSessionView && (!sessionId || (showTemplates && messages.length === 0 && !isLoading));
  // On mobile, the homepage's primary content is the session list — open the
  // drawer on the home route and close it on any other route. URL-driven so
  // the brief pre-hydration window on a session URL doesn't count as "home"
  // and spuriously open the drawer; mirroring the route also guarantees the
  // drawer can't linger over the session view after a navigation.
  const isHomeRoute = !urlSessionId && !isNewSessionRoute;
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (!isMobile) return;
    useUiStore.getState().setMobileSidebarOpen(isHomeRoute);
  }, [isMobile, isHomeRoute]);
  // Empty-state rocket: no messages yet, not mid-turn. We gate on historyLoaded
  // so we don't briefly flash the rocket on session switches before history
  // arrives — except for a brand-new-session route, where there's no history to
  // load and the rocket should appear the moment the route mounts.
  const showRocket = messages.length === 0 && !isLoading && (historyLoaded || showNewSessionView);
  // MessageInput's per-session draft persistence is keyed on focusKey. While the
  // user is on the new-session view (`/{slug}/new`) we MUST keep this stable as
  // "new", even after `claimSession()` resolves and `wsSessionId` becomes the
  // real session ID. Otherwise focusKey flips mid-typing and the draft-swap
  // logic loads the (empty) draft for the brand-new session, wiping whatever
  // the user has typed. The graduation to the real session ID happens when the
  // URL transitions to `/session/{id}` inside handleSend — at that point the
  // textarea has already been cleared by setText("") so there's nothing to lose.
  const messageInputFocusKey = showNewSessionView ? "new" : wsSessionId;

  // ── Right panel ──
  const rightPanel = (
    <>
      <div className="flex h-10.25 border-b border-(--color-border-primary) bg-(--color-bg-secondary)">
        {!isLocalMode && !isOpsSession && (
          <button onClick={() => handleTabChange("preview")} className={`px-3 sm:px-4 h-full inline-flex items-center text-xs sm:text-sm font-medium transition-colors border-b-2 ${rightTab === "preview" ? "text-(--color-text-primary) border-(--color-border-focus)" : "text-(--color-text-secondary) border-transparent hover:text-(--color-text-primary)"}`}>Preview</button>
        )}
        {isOpsSession && (
          <button onClick={() => handleTabChange("host")} className={`px-3 sm:px-4 h-full inline-flex items-center text-xs sm:text-sm font-medium transition-colors border-b-2 ${rightTab === "host" ? "text-(--color-text-primary) border-(--color-border-focus)" : "text-(--color-text-secondary) border-transparent hover:text-(--color-text-primary)"}`}>Host</button>
        )}
        {composeServices.length > 0 && (
          <button onClick={() => handleTabChange("services")} className={`px-3 sm:px-4 h-full inline-flex items-center text-xs sm:text-sm font-medium transition-colors border-b-2 ${rightTab === "services" ? "text-(--color-text-primary) border-(--color-border-focus)" : "text-(--color-text-secondary) border-transparent hover:text-(--color-text-primary)"}`}>Services</button>
        )}
        <button onClick={() => handleTabChange("docs")} className={`px-3 sm:px-4 h-full inline-flex items-center text-xs sm:text-sm font-medium transition-colors border-b-2 ${rightTab === "docs" ? "text-(--color-text-primary) border-(--color-border-focus)" : "text-(--color-text-secondary) border-transparent hover:text-(--color-text-primary)"}`}>Docs</button>
        <button onClick={() => handleTabChange("files")} className={`px-3 sm:px-4 h-full inline-flex items-center text-xs sm:text-sm font-medium transition-colors border-b-2 ${rightTab === "files" ? "text-(--color-text-primary) border-(--color-border-focus)" : "text-(--color-text-secondary) border-transparent hover:text-(--color-text-primary)"}`}>Files</button>
        {!isLocalMode && (
          <button onClick={() => handleTabChange("terminal")} className={`px-3 sm:px-4 h-full inline-flex items-center text-xs sm:text-sm font-medium transition-colors border-b-2 ${rightTab === "terminal" ? "text-(--color-text-primary) border-(--color-border-focus)" : "text-(--color-text-secondary) border-transparent hover:text-(--color-text-primary)"}`}>Terminal</button>
        )}
        {presentations.length > 0 && (
          <button onClick={() => handleTabChange("present")} className={`px-3 sm:px-4 h-full inline-flex items-center gap-1.5 text-xs sm:text-sm font-medium transition-colors border-b-2 ${rightTab === "present" ? "text-(--color-text-primary) border-(--color-border-focus)" : "text-(--color-text-secondary) border-transparent hover:text-(--color-text-primary)"}`}>
            Present
            {rightTab !== "present" && presentUnseenCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[1.25rem] h-4 px-1 rounded-full bg-(--color-accent) text-(--color-accent-text) text-[10px] font-semibold leading-none">{presentUnseenCount}</span>
            )}
          </button>
        )}
        <button onClick={() => handleTabChange("history")} className={`px-3 sm:px-4 h-full inline-flex items-center text-xs sm:text-sm font-medium transition-colors border-b-2 ${rightTab === "history" ? "text-(--color-text-primary) border-(--color-border-focus)" : "text-(--color-text-secondary) border-transparent hover:text-(--color-text-primary)"}`}>History</button>
        {hasPr && !isOpsSession && (
          <button onClick={() => handleTabChange("pr")} className={`px-3 sm:px-4 h-full inline-flex items-center text-xs sm:text-sm font-medium transition-colors border-b-2 ${rightTab === "pr" ? "text-(--color-text-primary) border-(--color-border-focus)" : "text-(--color-text-secondary) border-transparent hover:text-(--color-text-primary)"}`}>PR</button>
        )}
      </div>
      <div className="flex-1 min-h-0 relative">
        {/* PreviewFrame is always rendered to preserve iframe state; hidden via CSS when another tab is active */}
        <div className={`absolute inset-0 ${(!isLocalMode && (rightTab === "preview" || (rightTab === "pr" && !hasPr))) ? "" : "invisible pointer-events-none"}`}>
          <PreviewFrame preview={effectivePreviewStatus} sessionId={sessionId} mergedSessionIds={mergedPreviewSessionIds} detectedPorts={detectedPorts} selectedPort={selectedPort} onSelectPort={(p) => usePreviewStore.getState().setSelectedPort(p)} errors={previewErrors} onSendErrors={handleSendErrors} onClearErrors={clearPreviewErrors} onSendCrashToAgent={handleSendComposeErrorToAgent} onSendComposeHintToAgent={handleSendComposeHintToAgent} onStartService={(name) => send({ type: "start_service", name })} onStopService={(name) => send({ type: "stop_service", name })} />
        </div>
        {rightTab === "docs" ? (
          <DocsViewer files={docFiles} onFileClick={(f) => { const doc = docFiles.find((d) => d.path === f); handleOpenDoc(f, doc); }} onRefresh={() => { const sid = useSessionStore.getState().sessionId; if (sid) useFileStore.getState().fetchDocs(sid).catch(() => {}); }} />
        ) : rightTab === "terminal" ? (
          <TerminalPanel entries={logEntries} onClear={() => { useTerminalStore.getState().clearEntries(); send({ type: "clear_logs" }); }} terminalMode={terminalMode} onTerminalModeChange={(m) => useTerminalStore.getState().setMode(m)} sessionId={wsSessionId} onReconnectWs={reconnect} shellContent={
            (shellStarted || terminalMode === "shell") ? (
              <InteractiveTerminal ref={terminalRef} onInput={(d) => send({ type: "terminal_input", data: d })} onResize={(cols, rows) => send({ type: "terminal_resize", cols, rows })} onStart={(cols, rows) => { send({ type: "terminal_start", cols, rows }); useTerminalStore.getState().setShellStarted(true); }} />
            ) : null
          } />
        ) : rightTab === "history" ? (
          <GitHistory commits={gitCommits} onRefresh={() => { const sid = useSessionStore.getState().sessionId; if (sid) useGitStore.getState().fetchLog(sid).catch(() => {}); }} onViewDiff={handleViewDiff} />
        ) : rightTab === "services" ? (
          <ServicesPanel lastMessage={lastMessage} drainMessages={drainMessages} send={send} onSendToAgent={handleSendServiceLogsToAgent} />
        ) : rightTab === "pr" && hasPr && wsSessionId ? (
          <PrDetailPanel sessionId={wsSessionId} />
        ) : rightTab === "files" ? (
          <FileTree tree={fileTree} onRefresh={() => { const sid = useSessionStore.getState().sessionId; if (sid) { useFileStore.getState().fetchTree(sid).catch(() => {}); void useFileStore.getState().hydrateUploads(sid); } }} onFileClick={handleOpenFilePreview} onAddToChat={(f) => useSettingsStore.getState().addPendingFile(f)} onDownload={(f) => { const sid = useSessionStore.getState().sessionId; if (sid) { const a = document.createElement("a"); a.href = `/api/sessions/${sid}/files/download/${f}`; a.download = ""; document.body.appendChild(a); a.click(); a.remove(); } }} uploads={sessionUploads} onDeleteUpload={(u) => { const sid = useSessionStore.getState().sessionId; if (u.path) markUploadDeleted(u.path); if (sid && u.path) { const filename = u.path.replace(/^\/uploads\//, ""); void fetch(`/api/sessions/${sid}/files/uploads/${encodeURIComponent(filename)}`, { method: "DELETE" }); } if (u.previewUrl) URL.revokeObjectURL(u.previewUrl); if (u.path) useFileStore.getState().removeSessionUpload(u.path); else useFileStore.getState().removeSessionUploadById(u.id); }} />
        ) : rightTab === "present" ? (
          <PresentPane isActiveTab={rightTab === "present"} />
        ) : rightTab === "host" ? (
          <HostPanel isActiveTab={rightTab === "host"} />
        ) : null}
      </div>
    </>
  );

  // ── Chat panel ──
  const currentRewindRecovery = sessionId ? rewindRecoveries[sessionId] : undefined;
  const recoverRewindAvailable = Boolean(currentRewindRecovery && currentRewindRecovery.expiresAt > Date.now());
  const chatPanel = (
    <>
      {searchOpen && <SearchBar query={search.query} onQueryChange={search.setQuery} matches={search.matches} currentMatchIndex={search.currentMatchIndex} onNext={search.goToNext} onPrev={search.goToPrev} onClose={() => { setSearchOpen(false); search.clear(); }} />}
      {/*
        docs/156 — the PR lifecycle card IS the chat panel's top chrome.
        It always renders for an active session (even pre-PR) so search and
        the overflow menu have a stable home. The previous `SessionTopBar`
        is gone; rename/archive moved to the sidebar row overflow.
      */}
      {!showHomeScreen && !showNewSessionView && wsSessionId && (
        <PrLifecycleCard
          sessionId={wsSessionId}
          onOpenDetails={() => handleTabChange("pr")}
          onCreatePr={handleCreatePr}
          canAutoMerge={!!currentSession?.remoteUrl}
          onSearch={() => setSearchOpen(true)}
          onDownloadChat={handleDownloadChat}
          recoverRewindAvailable={recoverRewindAvailable}
          onRecoverRewind={() => { if (currentSession) window.dispatchEvent(new CustomEvent("shipit:restore-rewind", { detail: { sessionId: currentSession.id } })); }}
        />
      )}
      {showHomeScreen ? (
        <HomeScreen onAddRepo={() => useRepoStore.getState().setAddRepoDialogOpen(true)} hasRepos={repos.length > 0} />
      ) : (
        // Wrapping the message list + bottom-stack (status bar / attachments / rebase / PR card) in a single
        // flex-1 container gives the rocket overlay stable bounds. Anything that grows here (e.g. attachments
        // appearing) just shrinks MessageList inside the wrapper — the wrapper itself, and so the rocket
        // anchored to its bottom, stays put.
        <div className="flex-1 min-h-0 flex flex-col relative isolate">
          {showRocket && (
            <div className="absolute inset-0 pointer-events-none overflow-hidden" style={{ clipPath: "inset(0 0 -80px 0)", zIndex: -1 }}>
              <RocketLaunch />
            </div>
          )}
          <MessageList
            messages={messages}
            isLoading={isLoading}
            searchMatches={search.matches}
            currentMatch={search.currentMatch}
            onAnswerQuestion={handleAnswerQuestion}
            onSendFollowUp={handleSendFollowUp}
            rewindPreviews={rewindPreviews}
            sessionTitle={currentSession?.title}
            onRequestRewindPreview={handleRequestRewindPreview}
            onRewindAtGap={handleRewindAtGap}
          />
          {/*
            Bottom stack: thinking indicator, rebase banner, queue indicator.
            `gap-2` gives a consistent 8px gap between every rendered sibling, so
            spacing no longer has to be encoded as `mt-2`/`mb-2` on each individual
            card. Each child uses `last:pb-2` (or `last:mb-2`) to add the 8px to
            MessageInput when nothing renders below it.
            docs/156 — the PR lifecycle card is no longer rendered above the
            input; it lives at the top of the chat panel as the session's top
            chrome, so the destructive Merge button is no longer adjacent to the
            send button.
          */}
          <div className="flex flex-col gap-2">
            {isLoading && <AgentStatusBar activity={activity} />}
            {wsSessionId && <RebaseBanner sessionId={wsSessionId} />}
            {queuedMessages.length > 0 && <QueueIndicator queue={queuedMessages} onCancel={(pos) => send({ type: "cancel_queued_message", position: pos })} />}
          </div>
        </div>
      )}
      {(!showHomeScreen || showNewSessionView) && <MessageInput onSend={handleSend} disabled={showNewSessionView ? status !== "open" && !sessionId : status !== "open"} isLoading={isLoading} onInterrupt={() => send({ type: "interrupt_agent" })} permissionMode={permissionMode} onPermissionModeChange={(m) => useSettingsStore.getState().setPermissionMode(useSessionStore.getState().sessionId, m)} pendingFiles={pendingFiles} onRemoveFile={(i) => useSettingsStore.getState().removePendingFile(i)} onAddFile={(f) => useSettingsStore.getState().addPendingFile(f)} fileTree={fileTree} skills={skills} sessionId={wsSessionId} agents={agentList} activeAgentId={activeAgentId} onAgentChange={handleAgentChange} onModelChange={handleModelChange} modelInfo={modelInfo} contextTokens={contextTokens} hasActiveSession={!showNewSessionView && !!sessionId} onOpenUsageDetails={handleUsageBadgeClick} focusKey={messageInputFocusKey} liveSteeringActive={liveSteeringActive} />}
    </>
  );

  // ── Bootstrap loading gate ──
  if (!bootstrapLoaded) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-(--color-bg-primary)">
        {showBootstrapSpinner && (
          <CircleNotchIcon size={ICON_SIZE.MD} className="animate-spin text-(--color-text-tertiary)" />
        )}
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
    <div className="flex flex-col h-[100dvh] bg-(--color-bg-primary) text-(--color-text-primary)">
      <AuthOverlayContainer
        authUrl={authUrl}
        showOnboarding={showOnboarding}
        onPasteCode={(code: string) => { apiPost("/api/auth/code", { code }).catch(() => {}); }}
        onApiKey={(key: string) => { apiPost("/api/auth/api-key", { key }).catch(() => {}); }}
        onDismissAuth={() => { useSessionStore.getState().setAuthUrl(null); }}
        gitIdentityNeeded={gitIdentityNeeded}
        agentList={agentList}
        onGitIdentitySubmit={(name: string, email: string) => useGitStore.getState().submitGitIdentity(name, email).catch(() => {})}
        onGitHubTokenSubmit={async (token: string) => { const result = await useSettingsStore.getState().submitGitHubToken(token); if (result) { usePrStore.getState().setImportSearchResults(result.repos); return true; } return false; }}
        onClaudeApiKeySubmit={async (key: string) => { try { await apiPost("/api/auth/api-key", { key }); const data = await apiGet<{ agents: AgentOption[] }>("/api/bootstrap"); useUiStore.getState().setAgentList(data.agents); return true; } catch { return false; } }}
        onCodexApiKeySubmit={async (key: string) => { try { const result = await apiPost<{ agents: AgentOption[] }>(`/api/agents/codex/env`, { key: "OPENAI_API_KEY", value: key }); useUiStore.getState().setAgentList(result.agents); return true; } catch { return false; } }}
        onStartClaudeAuth={() => { apiPost("/api/auth/start", {}).catch(() => {}); }}
        onPasteAuthCode={(code: string) => { apiPost("/api/auth/code", { code }).catch(() => {}); }}
        onRefreshAgents={async () => { const data = await apiGet<{ agents: AgentOption[] }>("/api/bootstrap"); useUiStore.getState().setAgentList(data.agents); }}
        codexDeviceAuth={codexDeviceAuth}
        codexDeviceAuthError={codexDeviceAuthError}
        onStartCodexDeviceAuth={() => { apiPost("/api/codex-auth/start", {}).catch(() => {}); }}
        onCancelCodexDeviceAuth={() => { apiPost("/api/codex-auth/cancel", {}).catch(() => {}); }}
        onComplete={() => { setOnboardingDismissed(true); if (gitIdentityNeeded) useGitStore.getState().setIdentityNeeded(false); }}
      />
      {shortcutsOpen && <KeyboardShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}
      {(previewFile || (previewMode === "agent-review" && previewLoading)) && previewType && (
        <FilePreviewModal
          filePath={previewFile ?? ""}
          content={previewContent}
          fileType={previewType}
          actions={previewMode === "agent-review" ? [] : previewActions}
          {...(previewMode === "agent-review"
            ? {}
            : { siblings: previewSiblings, onSwitchSibling: handleSwitchSibling })}
          mode={previewMode}
          agentReview={previewAgentReview}
          onClose={() => useFileStore.getState().closePreview()}
          {...(previewMode === "agent-review"
            ? {}
            : {
                onSendComments: handleFileSendComments,
                onAskAgentReview: handleAskAgentReview,
              })}
          onSwitchToLive={
            previewMode === "agent-review" && wsSessionId && previewAgentReview
              ? () => {
                  void useFileStore.getState().openPreview(wsSessionId, previewAgentReview.filePath);
                }
              : undefined
          }
        />
      )}
      {settingsOpen && (
        <Settings
          initialContent={systemPromptContent} onSaveInstructions={handleInstructionsSave}
          onResumeSession={(sid) => handleSessionResume(sid, navigate)}
          githubStatus={githubStatus}
          onGitHubTokenSubmit={async (token) => { const result = await useSettingsStore.getState().submitGitHubToken(token); if (result) usePrStore.getState().setImportSearchResults(result.repos); }}
          onGitHubLogout={() => useSettingsStore.getState().gitHubLogout().catch(() => {})}
          authUrl={authUrl}
          onApiKey={(key) => { apiPost("/api/auth/api-key", { key }).catch(() => {}); }}
          onClearApiKey={async () => {
            // Full Claude sign-out: clears the stored API key AND the OAuth
            // credentials on disk. The DELETE response carries the refreshed
            // agent list; the server also fires an SSE `agent_list` broadcast
            // so other open tabs repaint too. Mirrors onSignOutCodex.
            try {
              const result = await apiDel<{ agents?: AgentOption[] }>("/api/auth/api-key");
              if (result.agents) {
                useUiStore.getState().setAgentList(result.agents);
              }
            } catch (err) {
              console.error("[settings] Claude sign-out failed:", err);
            }
          }}
          onStartAuth={() => { apiPost("/api/auth/start", {}).catch(() => {}); }}
          onPasteCode={(code) => { apiPost("/api/auth/code", { code }).catch(() => {}); }}
          agentList={agentList}
          onSetAgentEnv={(agentId, key, value) => { apiPost(`/api/agents/${agentId}/env`, { key, value }).catch(() => {}); }}
          codexDeviceAuth={codexDeviceAuth}
          codexDeviceAuthError={codexDeviceAuthError}
          onStartCodexDeviceAuth={() => { apiPost("/api/codex-auth/start", {}).catch(() => {}); }}
          onCancelCodexDeviceAuth={() => { apiPost("/api/codex-auth/cancel", {}).catch(() => {}); }}
          onSignOutCodex={async () => {
            // The DELETE response includes the refreshed agent list, so we
            // don't need a follow-up bootstrap fetch — but the SSE
            // `agent_list` broadcast from the server will repaint the list
            // for any other open tab too.
            try {
              const result = await apiDel<{ agents?: AgentOption[] }>("/api/codex-auth");
              if (result.agents) {
                useUiStore.getState().setAgentList(result.agents);
              }
            } catch (err) {
              console.error("[settings] Codex sign-out failed:", err);
            }
          }}
          onFullReset={async () => { try { await apiPost("/api/reset", {}); } catch (err) { console.error("[settings] Full reset failed:", err); } }}
          gitIdentity={gitIdentity}
          onGitIdentitySave={(name, email) => useGitStore.getState().submitGitIdentity(name, email).catch(() => {})}
          maxIdleContainers={maxIdleContainers}
          onMaxIdleContainersSave={async (n) => { try { const raw = await apiPut("/api/settings", { maxIdleContainers: n }); const res = raw as Record<string, unknown>; if (res.maxIdleContainers !== null && res.maxIdleContainers !== undefined) useSettingsStore.getState().setMaxIdleContainers(res.maxIdleContainers as number); } catch (err) { console.error("[settings] Failed to save max idle containers:", err); } }}
          agentSystemInstructionsEnabled={agentSystemInstructionsEnabled}
          agentSystemInstructions={agentSystemInstructions}
          onToggleAgentSystemInstructions={async (enabled) => { try { const raw = await apiPut("/api/settings", { agentSystemInstructionsEnabled: enabled }); const res = raw as Record<string, unknown>; if (res.agentSystemInstructionsEnabled !== undefined) useSettingsStore.getState().setAgentSystemInstructionsEnabled(!!res.agentSystemInstructionsEnabled); } catch (err) { console.error("[settings] Failed to toggle agent system instructions:", err); } }}
          hasActiveSession={!!sessionId}
          onClose={() => { useUiStore.getState().setSettingsOpen(false); useUiStore.getState().setSettingsTab(undefined); }}
        />
      )}
      {projectSettingsRepoUrl && (
        <ProjectSettings
          repoUrl={projectSettingsRepoUrl}
          repoName={parseRepoLabel(projectSettingsRepoUrl)}
          initialTab={projectSettingsTab}
          onSecretsLoad={async (repoUrl) => { const data = await apiGet<{ secrets: Record<string, string> }>(`/api/secrets?repoUrl=${encodeURIComponent(repoUrl)}`); return data.secrets; }}
          onSecretsSave={(repoUrl, secrets) => { apiPut("/api/secrets", { repoUrl, secrets }).catch(() => {}); }}
          onClose={() => { useUiStore.getState().setProjectSettingsRepoUrl(null); }}
        />
      )}
      {showUsageModal && <UsageModal currentSessionUsage={currentSessionUsage} allUsage={allUsageStats} sessions={sessions} onClose={() => useUiStore.getState().setShowUsageModal(false)} modelInfo={modelInfo} contextTokens={contextTokens} turnUsage={turnUsageForActiveSession} />}
      {diffDialogOpen && turnDiff && (
        <Dialog open onOpenChange={(isOpen) => { if (!isOpen) useGitStore.getState().closeDiffDialog(); }}>
          <DialogContent className="w-[90vw] h-[85vh] max-h-[85vh]! overflow-hidden! flex flex-col" aria-label="Diff view">
            <Suspense fallback={<div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">Loading diff viewer...</div>}>
              <DiffPanel diff={turnDiff} onClose={() => useGitStore.getState().closeDiffDialog()} commitMessage={diffDialogTitle} onSendComments={handleFileSendComments} />
            </Suspense>
          </DialogContent>
        </Dialog>
      )}

      <AppLayout
        theme={theme}
        onSelectTheme={setTheme}
        onSettingsOpen={() => handleSettingsOpen()}
        onShortcutsOpen={() => setShortcutsOpen(true)}
        hasSystemPrompt={hasSystemPrompt}
        githubAuthenticated={githubStatus.authenticated}
        dockerMemory={dockerMemory}
        processStartedAt={processStartedAt}
        subscriptionLimits={subscriptionLimits}
        onNavigateHome={() => navigate("/")}
        onOpenSessions={() => useUiStore.getState().setMobileSidebarOpen(true)}
        showConnectionBanner={!showNewSessionView && !!wsSessionId}
        connectionStatus={status}
        reconnectAttempt={reconnectAttempt}
        onReconnect={reconnect}
        isMobile={isMobile}
        showHomeScreen={showHomeScreen}
        showNewSessionView={showNewSessionView}
        mobilePanel={mobilePanel}
        onMobilePanelChange={(p) => {
          // Selecting a content tab also dismisses the session drawer — the
          // three form one mutually-exclusive segmented control.
          useUiStore.getState().setMobilePanel(p);
          useUiStore.getState().setMobileSidebarOpen(false);
        }}
        onMobileNewSession={handleNewSessionShortcut}
        onMobileQuickSession={() => useUiStore.getState().setQuickCaptureOpen(true)}
        onMobileVoiceSession={() => useUiStore.getState().setQuickCaptureOpen(true, true)}
        chatPanel={chatPanel}
        rightPanel={rightPanel}
        fraction={fraction}
        isDragging={isDragging}
        onMouseDown={onMouseDown}
        onTouchStart={onTouchStart}
        containerRef={containerRef}
        sessions={sessions}
        currentSessionId={sessionId}
        activeNewSessionRepoUrl={showNewSessionView ? newSessionRepoUrl : undefined}
        sidebarCollapsed={sidebarCollapsed}
        mobileSidebarOpen={mobileSidebarOpen}
        onCloseMobileSidebar={() => useUiStore.getState().setMobileSidebarOpen(false)}
        onResumeSession={(sid: string) => {
          const session = sessions.find((s) => s.id === sid);
          if (session?.remoteUrl) useRepoStore.getState().setActiveRepoUrl(session.remoteUrl);
          handleSessionResume(sid, navigate);
        }}
        onArchiveSession={async (sid: string) => { await useSessionStore.getState().archiveSession(sid); if (sid === useSessionStore.getState().sessionId) { const repoUrl = sessions.find((s) => s.id === sid)?.remoteUrl ?? activeRepoUrl; if (repoUrl) void handleNewSessionForRepo(repoUrl); } }}
        onNewSessionForRepo={handleNewSessionForRepo}
        onToggleSidebarCollapse={() => useUiStore.getState().setSidebarCollapsed(!sidebarCollapsed)}
        repos={repos}
        onAddRepo={() => useRepoStore.getState().setAddRepoDialogOpen(true)}
        onCreateNewRepo={() => {
          useRepoStore.getState().setAddRepoDialogOpen(false);
          // eslint-disable-next-line no-restricted-syntax -- fire-and-forget one-liner
          if (templates.length === 0) apiGet<{ templates: typeof templates }>("/api/bootstrap").then((d) => useUiStore.getState().setTemplates(d.templates)).catch(() => {});
          useRepoStore.getState().setNewRepoDialogOpen(true);
        }}
        toast={toast}
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
    </TooltipProvider>
  );
}
