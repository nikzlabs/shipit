// eslint-disable-next-line no-restricted-imports -- useEffect: external-system sync (Issues/tracker fetch-on-open, pr_tab_active WS signal, mobile sidebar route mirror)
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
import { useKeybinding } from "./keybindings/use-keybinding.js";
import { useAutoFix } from "./hooks/useAutoFix.js";
import { useAppBootstrap } from "./hooks/useAppBootstrap.js";
import { useSessionActivation } from "./hooks/useSessionActivation.js";
import { useAppKeyboardShortcuts } from "./hooks/useAppKeyboardShortcuts.js";
import { useAppModals } from "./hooks/useAppModals.js";
import { CircleNotchIcon, EyeIcon, HardDrivesIcon, BookOpenIcon, ListChecksIcon, FilesIcon, TerminalWindowIcon, ClockCounterClockwiseIcon, PresentationChartIcon, GitPullRequestIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "./design-tokens.js";
import { Tab } from "./components/ui/tab.js";
import { useTabLabelCollapse } from "./hooks/useTabLabelCollapse.js";
import { useApi } from "./hooks/useApi.js";
import { formatErrorForMessage } from "./components/PreviewFrame.js";
import { MessageInput, type SendPayload } from "./components/MessageInput.js";
import { MessageList } from "./components/MessageList.js";
import type { RewindGapAction } from "./components/RewindPoint.js";
import { RocketLaunch } from "./components/RocketLaunch.js";
import { PreviewFrame } from "./components/PreviewFrame.js";
import { RepoTrustBanner } from "./components/RepoTrustBanner.js";
import { usePreviewErrors, type PreviewError } from "./hooks/usePreviewErrors.js";
import { GitHistory } from "./components/GitHistory.js";
import { AuthOverlayContainer } from "./AuthOverlay.js";
import { Settings } from "./components/Settings.js";
import { ProjectSettings } from "./components/ProjectSettings.js";
import { AppLayout } from "./AppLayout.js";
import { DocsViewer } from "./components/DocsViewer.js";
import { IssuesPanel } from "./components/IssuesPanel.js";
import { useIssuesStore } from "./stores/issues-store.js";
import { FileTree } from "./components/FileTree.js";
import { FilePreviewModal } from "./components/FilePreviewModal.js";
import { FileEditModal } from "./components/FileEditModal.js";
import { TerminalPanel } from "./components/TerminalPanel.js";
import { InteractiveTerminal, type InteractiveTerminalHandle } from "./components/InteractiveTerminal.js";
import { PreviewServicesDrawer } from "./components/PreviewServicesDrawer.js";
import { SearchBar } from "./components/SearchBar.js";
import { ConnectionBanner } from "./components/ConnectionBanner.js";
import { KeyboardShortcutsOverlay } from "./components/KeyboardShortcutsOverlay.js";
import { HomeScreen } from "./components/HomeScreen.js";
import { AddRepoDialog } from "./components/AddRepoDialog.js";
import { AllSessionsDialog } from "./components/AllSessionsDialog.js";
import { NewRepoDialog } from "./components/NewRepoDialog.js";
import { SandboxDialog } from "./components/SandboxDialog.js";
import { UsageModal } from "./components/UsageModal.js";
import type { TurnDiffData } from "./components/DiffPanel.js";
import type { TurnUsage } from "../server/shared/types.js";
import { deriveEffectivePreviewStatus } from "./utils/preview-status.js";
import { isEditableFilePath } from "./utils/file-preview-type.js";

/** Stable empty fallback so the zustand selector never returns a fresh array. */
const EMPTY_TURN_USAGE: TurnUsage[] = [];

// eslint-disable-next-line no-restricted-syntax -- lazy() named-export pattern
const DiffPanel = lazy(() => import("./components/DiffPanel.js").then(m => ({ default: m.DiffPanel })));
import { PrLifecycleCard } from "./components/PrLifecycleCard.js";
import { SandboxBanner } from "./components/SandboxBanner.js";
import { PrDetailPanel } from "./components/PrDetailPanel.js";
import { PresentPane } from "./components/PresentPane.js";
import { HostPanel } from "./components/HostPanel.js";
import { RebaseBanner } from "./components/RebaseBanner.js";
import { QueueIndicator } from "./components/QueueIndicator.js";
import { AgentStatusBar } from "./components/AgentStatusBar.js";
import type { AgentOption } from "./agent-types.js";
import type { AgentId, DocEntry, ProviderAccount, TrackerIssue, ReleaseMechanism } from "../server/shared/types.js";

import { useSessionStore } from "./stores/session-store.js";
import { useGitStore } from "./stores/git-store.js";
import { useFileStore, markUploadDeleted } from "./stores/file-store.js";
import { usePreviewStore } from "./stores/preview-store.js";
import { usePresentStore } from "./stores/present-store.js";
import { useTerminalStore } from "./stores/terminal-store.js";
import { useLogStore } from "./stores/log-store.js";
import { usePrStore } from "./stores/pr-store.js";
import { useSettingsStore } from "./stores/settings-store.js";
import { useUiStore } from "./stores/ui-store.js";
import { useRepoStore } from "./stores/repo-store.js";
import { composeReviewMessage, resolveReviewer } from "./utils/compose-review-body.js";
import { handleSessionResume } from "./stores/actions/session-actions.js";
import { parseRepoLabel, repoLabelToNewPath, parseNewSessionSlug } from "./utils/repo-label.js";
import { saveAgentId, saveModelId } from "./utils/local-storage.js";
import { siblingsOf, orderSiblingsForTabs, siblingTabLabel, isPlanPath } from "./utils/doc-paths.js";
import { dispatchAgentMessage } from "./utils/dispatch-agent-message.js";
import { sendUserMessage } from "./utils/send-user-message.js";
import { buildReleaseConfirmMessage } from "./utils/release-confirm-message.js";
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
  const terminalRef = useRef<InteractiveTerminalHandle>(null);
  const messages = useSessionStore((s) => s.messages);
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
  const previewLine = useFileStore((s) => s.previewLine);
  const editFile = useFileStore((s) => s.editFile);
  const editContent = useFileStore((s) => s.editContent);
  const editOriginalContent = useFileStore((s) => s.editOriginalContent);
  const editLoading = useFileStore((s) => s.editLoading);
  const editSaving = useFileStore((s) => s.editSaving);
  const editError = useFileStore((s) => s.editError);

  // Direct file editing is only offered once a session has graduated (left the
  // warm pool). The graduated-sessions list excludes warm sessions, so a
  // current session present in it has taken its first turn; a brand-new,
  // not-yet-started session is absent and edits stay disabled. The server
  // enforces this authoritatively too (PUT /files rejects warm sessions).
  const sessionGraduated = useSessionStore((s) => s.sessions.some((x) => x.id === s.sessionId));

  const previewStatus = usePreviewStore((s) => s.status);
  const selectedPort = usePreviewStore((s) => s.selectedPort);
  const composeServices = usePreviewStore((s) => s.services);
  const presentations = usePresentStore((s) => s.presentations);
  const presentUnseenCount = usePresentStore((s) => s.unseenCount);

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
  // docs/211 — a sandbox session has no app preview and no PR lifecycle, so those
  // tabs are REMOVED (not just disabled — there is no Host replacement either).
  // Coerce a persisted preview/pr selection to Files so the panel never lands on
  // a tab that isn't rendered for this kind of session.
  const isSandboxSession = useMemo(
    () => sessions.find((s) => s.id === wsSessionId)?.kind === "sandbox",
    [sessions, wsSessionId],
  );
  const rightTab = (() => {
    if (isOpsSession && (rightTabRaw === "preview" || rightTabRaw === "pr")) return "host";
    if (!isOpsSession && rightTabRaw === "host") return "files";
    if (isSandboxSession && (rightTabRaw === "preview" || rightTabRaw === "pr")) return "files";
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
  const sandboxDialogOpen = useUiStore((s) => s.sandboxDialogOpen);
  const quickCaptureHotkey = useKeybinding("quick-capture");
  const voiceInputEnabled = useSettingsStore((s) => s.voiceInputEnabled);
  const voiceHotkeyModeB = useKeybinding("voice-mode-b");
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

  const liveSteeringActive = liveSteering && (agentList.find((a) => a.id === activeAgentId)?.supportsSteering ?? false);

  const noAgentReady = agentList.length > 0 && !agentList.some(a => a.installed && a.authConfigured);
  // GitHub is the only onboarding door — the manual git-identity / sandbox
  // fallback was removed, so gate step 1 on GitHub auth rather than git
  // identity. A user with a legacy/manual identity (set in Settings) but no
  // GitHub token must still pass Connect-GitHub. Gate on `bootstrapLoaded` so
  // the default `githubStatus.authenticated: false` can't flash the wizard
  // before the real status arrives from bootstrap.
  const githubNeeded = bootstrapLoaded && !githubStatus.authenticated;
  const needsOnboarding = githubNeeded || noAgentReady;
  // Latch: once onboarding is triggered, it stays active until the user
  // clicks "Get Started". This prevents the dialog from closing reactively
  // when e.g. Claude auth completes and noAgentReady flips to false mid-wizard.
  const onboardingTriggeredRef = useRef(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  // docs/211 — sandbox create is in flight; disables the dialog controls. The
  // dialog itself is rendered once here (not in SessionSidebar) so the empty
  // HomeScreen can open it on mobile, where the sidebar unmounts when closed.
  const [creatingSandbox, setCreatingSandbox] = useState(false);
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
  const { searchOpen, setSearchOpen, shortcutsOpen, setShortcutsOpen, githubOrgs, setGithubOrgs } = useAppModals();
  // Derive the repo URL from the /{slug}/new URL pattern (replaces useState)
  const newSessionRepoUrl = useMemo(() => {
    if (!newSessionRepoSlug) return undefined;
    return repos.find((r) => parseRepoLabel(r.url) === newSessionRepoSlug)?.url;
  }, [newSessionRepoSlug, repos]);
  // A freshly-claimed session stays *warm* (warm=1) until its first turn
  // graduates it, and warm sessions are excluded from the broadcast session
  // list — so `currentSession` is undefined during that window. Fall back to
  // the /{slug}/new route's repo so trust-banner / preview wiring keyed on the
  // repo URL works before graduation (otherwise the RepoTrustBanner only
  // appears after the first agent turn — see docs/178).
  const currentRepoUrl = currentSession?.remoteUrl ?? newSessionRepoUrl;
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

  // App bootstrap wiring (per-session WS connect handling, delayed bootstrap
  // spinner, WS message dispatcher, restore-rewind browser-event bridge). The
  // global SSE (`useServerEvents`) and per-session WS (`useSessionWebSocket`)
  // stay above so their effects register first and their handles flow through
  // the rest of App.
  const { showBootstrapSpinner } = useAppBootstrap({
    status,
    send,
    lastMessage,
    drainMessages,
    terminalRef,
    bootstrapLoaded,
    reconnect,
  });

  // Session resume/claim/routing: the four route-sync effects + the
  // new-session claim handlers. Effect ordering and dependency arrays are
  // preserved exactly (race-condition sensitive). `useAppKeyboardShortcuts`
  // below consumes `handleNewSessionShortcut` returned here.
  const { handleNewSessionForRepo, handleNewSessionShortcut, handleQuickSessionCreated } = useSessionActivation({
    urlSessionId,
    sessionId,
    isNewSessionRoute,
    newSessionRepoSlug,
    newSessionRepoUrl,
    bootstrapLoaded,
    reposLength: repos.length,
    disableAutoFix,
    navigate,
  });

  // ── Callback helpers ──
  const handleSend = useCallback(
    async (payload: SendPayload) => {
      const { text, uploadRefs, uploads: payloadUploads, resetMergedBranch } = payload;
      // docs/203, docs/220 — `/review [@path]` is a chat-native entry point to AI
      // review: same composed prompt as the modal button, sent as a normal
      // `send_message`. The reviewer (cross-agent vs fresh subagent) is resolved
      // here, at click time, from the settings store + agent registry — the prompt
      // is concrete. Cross-agent output is surfaced by the consult card (docs/220);
      // a same-model review is narrated as prose. No review tool is involved.
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
        const prompt = composeReviewMessage(targetFile, resolveReviewer({
          enableSubAgents: useSettingsStore.getState().enableSubAgents,
          agentList: useUiStore.getState().agentList,
          activeAgentId: useUiStore.getState().activeAgentId,
        }));
        // On /{slug}/new route — graduate: transition URL to /session/{id}, so
        // a /review sent from a fresh session doesn't leave the URL on .../new.
        if (isNewSessionRoute) {
          void navigate(`/session/${sid}`, { replace: true });
        }
        useFileStore.getState().closePreview();
        sendUserMessage({
          bubble: { role: "user", text: prompt },
          activity: "Reviewing...",
          dispatch: () => send({ type: "send_message", text: prompt, sessionId: sid }),
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
          // docs/218 — per-send opt-out for the auto-reset-merged-branch control.
          ...(resetMergedBranch !== undefined ? { resetMergedBranch } : {}),
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
    const sid = useSessionStore.getState().sessionId;
    if (!sid) return;
    const lines = [`The Docker Compose service "${serviceName}" is in state "${status}". Recent logs:`, ""];
    if (logs) {
      lines.push("```", logs, "```", "");
    }
    lines.push("Please investigate and fix the issue.");
    // Prefill the composer instead of dispatching directly: service logs are
    // noisy and the user usually wants to trim them or add context before
    // sending (same edit-then-send pattern as "Start Session from doc").
    useSessionStore.getState().setPrefillText(lines.join("\n"));
    useUiStore.getState().setMobilePanel("chat");
  }, []);

  const handleAnswerQuestion = useCallback(
    (toolUseId: string, answers: Record<string, string>, text: string) => {
      // Forward the session's current permission mode so answering a clarifying
      // question stays in the same mode it was asked in. Without this, an answer
      // given in plan mode resumes the CLI in default mode and the agent starts
      // implementing — silently "exiting plan mode" the user never approved.
      // Mirrors handleSendFollowUp's permission-mode plumbing.
      const session = useSessionStore.getState();
      const pm = useSettingsStore.getState().getPermissionMode(session.sessionId);
      sendUserMessage({
        bubble: { role: "user", text },
        activity: "Thinking...",
        dispatch: () =>
          send({
            type: "answer_question",
            toolUseId,
            answers,
            text,
            ...(pm !== "auto" ? { permissionMode: pm } : {}),
          }),
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

  // docs/171 — confirm/cancel a proposed release. These send a chat message
  // (answering the agent's proposal) through the same user-message surface as
  // any other reply — NOT a shell command (CLAUDE.md §5). The agent's follow-up
  // turn performs the bump/PR-or-tag and the release flow advances the card.
  //
  // The confirm wording is mechanism-aware (docs/214): a `release-branch` repo
  // (ShipIt's own) is released by merging a version-bump PR into the maintenance
  // branch — CI tags + publishes — so the message must NOT tell the agent to
  // push a tag (a hand-pushed tag collides with CI). Only a `tag-triggered` repo
  // pushes the tag. Anything else (absent/unknown/brokered) defaults to the
  // tag-triggered wording, matching the platform default.
  const handleReleaseConfirm = useCallback(
    (version: string, mechanism: ReleaseMechanism) => {
      const session = useSessionStore.getState();
      const pm = useSettingsStore.getState().getPermissionMode(session.sessionId);
      const text = buildReleaseConfirmMessage(version, mechanism);
      sendUserMessage({
        bubble: { role: "user", text },
        activity: "Publishing release...",
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

  const handleReleaseCancel = useCallback(
    (version: string) => {
      const session = useSessionStore.getState();
      const text = `Cancel the ${version} release — do not bump, tag, or push anything.`;
      sendUserMessage({
        bubble: { role: "user", text },
        activity: "Thinking...",
        dispatch: () => send({ type: "send_message", text, sessionId: session.sessionId ?? undefined }),
      });
    },
    [send],
  );

  // App-level keyboard wiring (shortcuts overlay + new-session chord, text and
  // voice quick-capture hotkeys). Lives at this position so its keydown effects
  // register in the same order as before. The resolved chords stay selected
  // above so their `useKeybinding` selectors keep their original positions.
  useAppKeyboardShortcuts({
    setShortcutsOpen,
    handleNewSessionShortcut,
    quickCaptureHotkey,
    voiceInputEnabled,
    voiceHotkeyModeB,
  });

  const handleTabChange = useCallback(
    (tab: "preview" | "docs" | "issues" | "files" | "terminal" | "history" | "pr" | "host" | "present") => {
      useUiStore.getState().setRightTab(tab);
      const sid = useSessionStore.getState().sessionId;
      if (tab === "docs" && useFileStore.getState().docFiles.length === 0 && sid) useFileStore.getState().fetchDocs(sid).catch(() => {});
      if (tab === "files" && sid) { useFileStore.getState().fetchTree(sid).catch(() => {}); }
      if (tab === "history" && sid) useGitStore.getState().fetchLog(sid).catch(() => {});
      if (tab === "present") usePresentStore.getState().markSeen();
    },
    [],
  );

  // docs/189 — open an issue's inline detail view from a chat card (the agent's
  // read/write cards). Switches the right panel to the Issues tab (and reveals
  // it on mobile), then loads the issue into the master-detail view. The
  // rightTab change also fires the fetch-on-open effect below for the list.
  const handleOpenIssue = useCallback(
    (ref: {
      tracker: "linear" | "github";
      id?: string;
      identifier: string;
      title?: string;
      url?: string;
      anchorCommentId?: string;
    }) => {
      useUiStore.getState().setRightTab("issues");
      useUiStore.getState().setMobilePanel("preview");
      void useIssuesStore.getState().openIssue(ref);
    },
    [],
  );

  // Fetch-on-open for the Issues tab (docs/170): trackers (for the sub-tabs)
  // then the active list. This lives in an effect rather than handleTabChange
  // because a page reload restores rightTab from localStorage WITHOUT going
  // through handleTabChange — so a reload directly onto the Issues tab would
  // otherwise never fetch and render an empty "Not connected" panel until the
  // user bounced to another tab and back. Keyed on rightTab so it also covers
  // the click-to-open path; the prior inline fetch in handleTabChange was
  // removed to avoid a double fetch.
  // eslint-disable-next-line no-restricted-syntax -- external system sync: fetch issues when the tab becomes active (incl. reload-restored tab)
  useEffect(() => {
    if (rightTab !== "issues") return;
    void (async () => {
      await useIssuesStore.getState().fetchTrackers();
      await useIssuesStore.getState().fetchIssues();
    })();
  }, [rightTab]);

  // Warm the tracker-connected state independently of the Issues tab so that a
  // Linear/GitHub *issue* link clicked in chat/PR markdown can decide whether to
  // open the in-app viewer vs. link out (see `MarkdownLink`). Without this the
  // `trackers` list is cold until the user first opens the Issues tab, and a
  // click would wrongly link out. Keyed on `sessionId` because the GitHub
  // tracker's `configured` state resolves against the active session's repo
  // binding; Linear ignores it. `fetchTrackers` is idempotent and cheap.
  // eslint-disable-next-line no-restricted-syntax -- external system sync: warm tracker config for inline issue-link interception
  useEffect(() => {
    void useIssuesStore.getState().fetchTrackers();
  }, [sessionId]);

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

  const handleSettingsOpen = useCallback(async (tab?: "agent-claude" | "agent-codex" | "integrations" | "git" | "instructions" | "advanced" | "keyboard") => {
    useUiStore.getState().setSettingsTab(tab);
    useUiStore.getState().setSettingsOpen(true);
    try {
      const data = await apiGet<{ settings: { gitIdentity: { name: string; email: string }; systemPrompt: string; agents: AgentOption[]; maxIdleContainers?: number; agentSystemInstructionsEnabled?: boolean; agentSystemInstructions?: string; autoCreatePr?: boolean; liveSteering?: boolean; autoResolveConflicts?: boolean; autoFixCi?: boolean; autoResetMergedBranch?: boolean; enableSubAgents?: boolean; agentSubAgentDefaults?: Record<string, { reasoningEffort?: string }>; voiceDeliveryMode?: "native" | "external" | "both"; voiceWebhookConfigured?: boolean; providerAccounts?: ProviderAccount[] } }>("/api/bootstrap");
      useGitStore.getState().setIdentity(data.settings.gitIdentity);
      useSettingsStore.getState().setSystemPromptContent(data.settings.systemPrompt);
      useSettingsStore.getState().setHasSystemPrompt(data.settings.systemPrompt.length > 0);
      if (data.settings.maxIdleContainers !== null && data.settings.maxIdleContainers !== undefined) useSettingsStore.getState().setMaxIdleContainers(data.settings.maxIdleContainers);
      if (data.settings.agentSystemInstructionsEnabled !== undefined) useSettingsStore.getState().setAgentSystemInstructionsEnabled(data.settings.agentSystemInstructionsEnabled);
      if (data.settings.agentSystemInstructions) useSettingsStore.getState().setAgentSystemInstructions(data.settings.agentSystemInstructions);
      if (data.settings.autoCreatePr !== undefined) useSettingsStore.getState().setAutoCreatePr(data.settings.autoCreatePr);
      if (data.settings.liveSteering !== undefined) useSettingsStore.getState().setLiveSteering(data.settings.liveSteering);
      if (data.settings.autoResolveConflicts !== undefined) useSettingsStore.getState().setAutoResolveConflicts(data.settings.autoResolveConflicts);
      if (data.settings.autoFixCi !== undefined) useSettingsStore.getState().setAutoFixCi(data.settings.autoFixCi);
      if (data.settings.autoResetMergedBranch !== undefined) useSettingsStore.getState().setAutoResetMergedBranch(data.settings.autoResetMergedBranch);
      if (data.settings.enableSubAgents !== undefined) useSettingsStore.getState().setEnableSubAgents(data.settings.enableSubAgents);
      if (data.settings.agentSubAgentDefaults !== undefined) useSettingsStore.getState().setAgentSubAgentDefaults(data.settings.agentSubAgentDefaults);
      if (data.settings.voiceDeliveryMode !== undefined) useSettingsStore.getState().setVoiceDeliveryMode(data.settings.voiceDeliveryMode);
      if (data.settings.voiceWebhookConfigured !== undefined) useSettingsStore.getState().setVoiceWebhookConfigured(data.settings.voiceWebhookConfigured);
      if (data.settings.providerAccounts) useSettingsStore.getState().setProviderAccounts(data.settings.providerAccounts);
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

  const handleOpenDoc = useCallback(
    (filePath: string, doc?: DocEntry) => {
      const sid = useSessionStore.getState().sessionId;
      if (!sid) return;
      // docs/168: status was removed from docs, so gate the seed-a-session
      // action on the structural "this is a work doc" signal instead — a
      // feature-directory plan.md or a doc carrying an issue: pointer.
      const isWorkDoc = !!doc && (isPlanPath(doc.path) || doc.issue !== undefined);
      const actions = isWorkDoc
        ? [{ label: "Start Session", onClick: () => handleDocStartSession(doc), variant: "primary" as const }]
        : undefined;
      void useFileStore.getState().openPreview(sid, filePath, { actions });
    },
    [],
  );

  const handleOpenFilePreview = useCallback(
    (filePath: string) => {
      const { sessionId: sid, sessions } = useSessionStore.getState();
      if (sid) {
        // Mirror the FileTree gate: only a graduated session (present in the
        // warm-excluding list) may edit; the server rejects warm-session writes.
        const graduated = sessions.some((s) => s.id === sid);
        const downloadAction = {
          label: "Download",
          onClick: () => {
            const a = document.createElement("a");
            a.href = `/api/sessions/${sid}/files/download/${filePath}`;
            a.download = "";
            document.body.appendChild(a);
            a.click();
            a.remove();
          },
        };
        const actions = isEditableFilePath(filePath) && graduated
          ? [
              {
                label: "Edit",
                onClick: () => {
                  void useFileStore.getState().openEditor(sid, filePath);
                },
              },
              downloadAction,
            ]
          : [downloadAction];
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

  // Issues tab "Start session" (docs/170) mirrors handleDocStartSession: rather
  // than firing a headless session that auto-sends, it seeds the chat input with
  // the issue's context so the user can edit/augment the prompt before sending.
  const handleIssueStartSession = useCallback(
    async (issue: TrackerIssue) => {
      const { messages, sessions, sessionId } = useSessionStore.getState();
      const repoUrl =
        sessions.find((s) => s.id === sessionId)?.remoteUrl ??
        useRepoStore.getState().activeRepoUrl;

      // If the current session already has messages, switch to a fresh session
      // first so the prefilled prompt doesn't append to an unrelated thread.
      if (messages.length > 0 && repoUrl) {
        await handleNewSessionForRepo(repoUrl);
      }

      // Same prompt the server's seedFromIssueRef would have sent — now editable
      // in the input instead of dispatched immediately.
      const lines = [`You are working on issue ${issue.identifier}: ${issue.title}`];
      if (issue.description?.trim()) lines.push("", issue.description.trim());
      if (issue.url?.trim()) lines.push("", `Issue link: ${issue.url.trim()}`);
      useSessionStore.getState().setPrefillText(lines.join("\n"));
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
        dispatch: () => send({ type: "send_message", text: prompt, sessionId: sid ?? undefined, userReview: { filePaths, commentCount } }),
      });
    },
    [send],
  );

  // docs/203 — "Ask agent to review": start a chat-native review turn. Distinct
  // from send_message so the orchestrator authorizes the review tool for this
  // file. The reviewer (cross-agent vs fresh subagent) is resolved here at click
  // time from the settings store + agent registry, then baked into the prompt.
  // Closing the modal shifts focus to the chat; the review lands in chat
  // (a consult card for cross-agent, prose for same-model — docs/220).
  const handleAskAgentReview = useCallback(
    (reviewFilePath: string) => {
      const sid = useSessionStore.getState().sessionId;
      const prompt = composeReviewMessage(reviewFilePath, resolveReviewer({
        enableSubAgents: useSettingsStore.getState().enableSubAgents,
        agentList: useUiStore.getState().agentList,
        activeAgentId: useUiStore.getState().activeAgentId,
      }));
      // On /{slug}/new route — graduate: transition URL to /session/{id}, same
      // as handleSend. Without this the session becomes real but the URL stays
      // stuck on .../new.
      if (sid && isNewSessionRoute) {
        void navigate(`/session/${sid}`, { replace: true });
      }
      useFileStore.getState().closePreview();
      useUiStore.getState().setMobilePanel("chat");
      sendUserMessage({
        bubble: { role: "user", text: prompt },
        activity: "Reviewing...",
        dispatch: () => send({ type: "send_message", text: prompt, sessionId: sid }),
      });
    },
    [send, navigate, isNewSessionRoute],
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

  // docs/217 — Control B: per-session reasoning effort for the active agent's
  // own turns. The seed save (per-agent localStorage) happens inside the
  // ReasoningSelector; here we just push it to the server for this session.
  const handleReasoningChange = useCallback((effort: string | null) => {
    send({ type: "set_reasoning", effort });
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
  // Whether the always-mounted PreviewFrame (+ Services drawer) is the visible
  // tab. The `pr && !hasPr` case keeps the preview up while a PR is pending.
  const previewVisible = !isLocalMode && (rightTab === "preview" || (rightTab === "pr" && !hasPr));
  // Re-measure the tab bar whenever the set of visible tabs changes so the
  // icon-only collapse adapts to the actual tab count, not a fixed worst-case
  // width. (See useTabLabelCollapse.)
  const tabBarRef = useTabLabelCollapse(
    [isLocalMode, isOpsSession, isSandboxSession, presentations.length > 0, hasPr, rightTab !== "present" && presentUnseenCount > 0].join("|"),
  );
  const rightPanel = (
    <>
      {/* Tabs collapse to icon-only when they'd overflow the bar (driven by
          useTabLabelCollapse via data-collapsed). When even the icons don't fit
          — narrow phones with PR + Present present — the bar scrolls
          horizontally so every tab stays reachable instead of clipping off the
          right edge. Persistent views sit on the left; transient Present/PR are
          grouped to the right. */}
      <div ref={tabBarRef} className="group/tabs flex h-10.25 min-w-0 overflow-x-auto no-scrollbar border-b border-(--color-border-primary) bg-(--color-bg-secondary)">
        {!isLocalMode && !isOpsSession && !isSandboxSession && (
          <Tab icon={<EyeIcon size={ICON_SIZE.SM} />} label="Preview" active={rightTab === "preview"} onClick={() => handleTabChange("preview")} />
        )}
        {isOpsSession && (
          <Tab icon={<HardDrivesIcon size={ICON_SIZE.SM} />} label="Host" active={rightTab === "host"} onClick={() => handleTabChange("host")} />
        )}
        <Tab icon={<BookOpenIcon size={ICON_SIZE.SM} />} label="Docs" active={rightTab === "docs"} onClick={() => handleTabChange("docs")} />
        <Tab icon={<ListChecksIcon size={ICON_SIZE.SM} />} label="Issues" active={rightTab === "issues"} onClick={() => handleTabChange("issues")} />
        <Tab icon={<FilesIcon size={ICON_SIZE.SM} />} label="Files" active={rightTab === "files"} onClick={() => handleTabChange("files")} />
        {!isLocalMode && (
          <Tab icon={<TerminalWindowIcon size={ICON_SIZE.SM} />} label="Terminal" active={rightTab === "terminal"} onClick={() => handleTabChange("terminal")} />
        )}
        <Tab icon={<ClockCounterClockwiseIcon size={ICON_SIZE.SM} />} label="History" active={rightTab === "history"} onClick={() => handleTabChange("history")} />
        <span className="flex-1" />
        {(presentations.length > 0 || (hasPr && !isOpsSession && !isSandboxSession)) && (
          <span className="self-center h-[18px] w-px bg-(--color-border-secondary) mx-1" aria-hidden="true" />
        )}
        {presentations.length > 0 && (
          <Tab
            icon={<PresentationChartIcon size={ICON_SIZE.SM} />}
            label="Present"
            active={rightTab === "present"}
            onClick={() => handleTabChange("present")}
            badge={rightTab !== "present" && presentUnseenCount > 0 ? (
              <span className="inline-flex items-center justify-center min-w-[1.25rem] h-4 px-1 rounded-full bg-(--color-accent) text-(--color-accent-text) text-[10px] font-semibold leading-none">{presentUnseenCount}</span>
            ) : undefined}
          />
        )}
        {hasPr && !isOpsSession && !isSandboxSession && (
          <Tab icon={<GitPullRequestIcon size={ICON_SIZE.SM} />} label="PR" tone="pr" active={rightTab === "pr"} onClick={() => handleTabChange("pr")} />
        )}
      </div>
      <div className="flex-1 min-h-0 relative">
        {/* PreviewFrame is always rendered to preserve iframe state; hidden via CSS when another tab is active.
            The Services drawer (docs/175) docks below it in the same flex column so a log tail can sit under the live render. */}
        <div className={`absolute inset-0 flex flex-col ${previewVisible ? "" : "invisible pointer-events-none"}`}>
          <div className="flex-1 min-h-0 relative">
            <PreviewFrame preview={effectivePreviewStatus} sessionId={sessionId} mergedSessionIds={mergedPreviewSessionIds} detectedPorts={detectedPorts} selectedPort={selectedPort} onSelectPort={(p) => usePreviewStore.getState().setSelectedPort(p)} errors={previewErrors} onSendErrors={handleSendErrors} onClearErrors={clearPreviewErrors} onSendCrashToAgent={handleSendComposeErrorToAgent} onSendComposeHintToAgent={handleSendComposeHintToAgent} />
            {/* docs/178 — restricted empty state overlaying the (empty) preview
                frame when the repo is untrusted. Inside the preview wrapper, so
                it only shows on the Preview tab. */}
            <RepoTrustBanner key={currentRepoUrl} repoUrl={currentRepoUrl} />
          </div>
          <PreviewServicesDrawer services={composeServices} sessionId={sessionId} active={previewVisible} send={send} onSendToAgent={handleSendServiceLogsToAgent} onSelectPreviewPort={(port) => usePreviewStore.getState().setSelectedPort(port)} />
        </div>
        {rightTab === "docs" ? (
          <DocsViewer files={docFiles} onFileClick={(f) => { const doc = docFiles.find((d) => d.path === f); handleOpenDoc(f, doc); }} onRefresh={() => { const sid = useSessionStore.getState().sessionId; if (sid) useFileStore.getState().fetchDocs(sid).catch(() => {}); }} onOpenIssue={handleOpenIssue} />
        ) : rightTab === "issues" ? (
          <IssuesPanel onStartSession={handleIssueStartSession} onConnect={() => { void handleSettingsOpen("integrations"); }} />
        ) : rightTab === "terminal" ? (
          <TerminalPanel onClear={() => { useLogStore.getState().clearChannel("agent"); send({ type: "log_clear", channel: "agent" }); }} terminalMode={terminalMode} onTerminalModeChange={(m) => useTerminalStore.getState().setMode(m)} send={send} sessionId={wsSessionId} onReconnectWs={reconnect} shellContent={
            (shellStarted || terminalMode === "shell") ? (
              <InteractiveTerminal ref={terminalRef} onInput={(d) => send({ type: "terminal_input", data: d })} onResize={(cols, rows) => send({ type: "terminal_resize", cols, rows })} onStart={(cols, rows) => { send({ type: "terminal_start", cols, rows }); useTerminalStore.getState().setShellStarted(true); }} />
            ) : null
          } />
        ) : rightTab === "history" ? (
          <GitHistory commits={gitCommits} onRefresh={() => { const sid = useSessionStore.getState().sessionId; if (sid) useGitStore.getState().fetchLog(sid).catch(() => {}); }} onViewDiff={handleViewDiff} />
        ) : rightTab === "pr" && hasPr && wsSessionId ? (
          <PrDetailPanel sessionId={wsSessionId} />
        ) : rightTab === "files" ? (
          <FileTree tree={fileTree} onRefresh={() => { const sid = useSessionStore.getState().sessionId; if (sid) { useFileStore.getState().fetchTree(sid).catch(() => {}); void useFileStore.getState().hydrateUploads(sid); } }} onFileClick={handleOpenFilePreview} onEdit={sessionGraduated ? (f) => { const sid = useSessionStore.getState().sessionId; if (sid) void useFileStore.getState().openEditor(sid, f); } : undefined} onAddToChat={(f) => useSettingsStore.getState().addPendingFile(f)} onDownload={(f) => { const sid = useSessionStore.getState().sessionId; if (sid) { const a = document.createElement("a"); a.href = `/api/sessions/${sid}/files/download/${f}`; a.download = ""; document.body.appendChild(a); a.click(); a.remove(); } }} uploads={sessionUploads} onDeleteUpload={(u) => { const sid = useSessionStore.getState().sessionId; if (u.path) markUploadDeleted(u.path); if (sid && u.path) { const filename = u.path.replace(/^\/uploads\//, ""); void fetch(`/api/sessions/${sid}/files/uploads/${encodeURIComponent(filename)}`, { method: "DELETE" }); } if (u.previewUrl) URL.revokeObjectURL(u.previewUrl); if (u.path) useFileStore.getState().removeSessionUpload(u.path); else useFileStore.getState().removeSessionUploadById(u.id); }} />
        ) : rightTab === "present" ? (
          <PresentPane isActiveTab={rightTab === "present"} onSendComments={handleFileSendComments} onAskAgentReview={handleAskAgentReview} />
        ) : rightTab === "host" ? (
          <HostPanel isActiveTab={rightTab === "host"} />
        ) : null}
      </div>
    </>
  );

  // ── Chat panel ──
  const chatPanel = (
    <>
      {searchOpen && <SearchBar query={search.query} onQueryChange={search.setQuery} matches={search.matches} currentMatchIndex={search.currentMatchIndex} onNext={search.goToNext} onPrev={search.goToPrev} onClose={() => { setSearchOpen(false); search.clear(); }} />}
      {/*
        docs/156 — the PR lifecycle card IS the chat panel's top chrome.
        It always renders for an active session (even pre-PR) so search and
        the overflow menu have a stable home. The previous `SessionTopBar`
        is gone; rename/archive moved to the sidebar row overflow.
      */}
      {/* docs/211 — for a sandbox session the PR-card slot holds the orientation
          banner instead (derived chrome from kind/capabilities — never a chat
          card). Other sessions keep the PR lifecycle card as their top chrome. */}
      {!showHomeScreen && !showNewSessionView && wsSessionId && (
        isSandboxSession ? (
          <SandboxBanner capabilities={sessions.find((s) => s.id === wsSessionId)?.capabilities} />
        ) : (
          <PrLifecycleCard
            sessionId={wsSessionId}
            onOpenDetails={() => {
              handleTabChange("pr");
              useUiStore.getState().setMobilePanel("preview");
            }}
            onCreatePr={handleCreatePr}
            canAutoMerge={!!currentSession?.remoteUrl}
            onSearch={() => setSearchOpen(true)}
          />
        )
      )}
      {!showHomeScreen && !showNewSessionView && wsSessionId && isMobile && (
        <div className="relative z-30 flex justify-center px-3 py-1.5 bg-(--color-bg-primary) pointer-events-none">
          <div className="pointer-events-auto max-w-full">
            <ConnectionBanner status={status} reconnectAttempt={reconnectAttempt} onReconnect={reconnect} compact />
          </div>
        </div>
      )}
      {showHomeScreen ? (
        <HomeScreen
          onAddRepo={() => useRepoStore.getState().setAddRepoDialogOpen(true)}
          githubAuthenticated={githubStatus.authenticated}
          hasRepos={repos.length > 0}
        />
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
            onSubmitBugReport={(cardId, title, body) =>
              send({ type: "submit_bug_report", cardId, title, body })
            }
            onResolvePermission={(requestId, behavior, remember) =>
              send({ type: "resolve_permission", requestId, behavior, ...(remember ? { remember: true } : {}) })
            }
            onEgressDecision={(cardId, host, action) =>
              send({ type: "egress_decision", cardId, host, action })
            }
            onUndoIssueWrite={(cardId) => send({ type: "undo_issue_write", cardId })}
            onOpenIssue={handleOpenIssue}
            onResumeSession={(sid) => handleSessionResume(sid, navigate)}
            onReleaseConfirm={handleReleaseConfirm}
            onReleaseCancel={handleReleaseCancel}
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
      {(!showHomeScreen || showNewSessionView) && <MessageInput onSend={handleSend} disabled={showNewSessionView ? status !== "open" && !sessionId : status !== "open"} isLoading={isLoading} onInterrupt={() => send({ type: "interrupt_agent" })} permissionMode={permissionMode} onPermissionModeChange={(m) => useSettingsStore.getState().setPermissionMode(useSessionStore.getState().sessionId, m)} pendingFiles={pendingFiles} onRemoveFile={(i) => useSettingsStore.getState().removePendingFile(i)} onAddFile={(f) => useSettingsStore.getState().addPendingFile(f)} fileTree={fileTree} skills={skills} sessionId={wsSessionId} agents={agentList} activeAgentId={activeAgentId} onAgentChange={handleAgentChange} onModelChange={handleModelChange} onReasoningChange={handleReasoningChange} sessionReasoning={currentSession?.reasoningEffort} modelInfo={modelInfo} contextTokens={contextTokens} hasActiveSession={!showNewSessionView && !!sessionId} onOpenUsageDetails={handleUsageBadgeClick} focusKey={messageInputFocusKey} liveSteeringActive={liveSteeringActive} />}
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
        githubNeeded={githubNeeded}
        agentList={agentList}
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
      {shortcutsOpen && (
        <KeyboardShortcutsOverlay
          onClose={() => setShortcutsOpen(false)}
          onEdit={() => { setShortcutsOpen(false); void handleSettingsOpen("keyboard"); }}
        />
      )}
      {previewFile && previewType && (
        <FilePreviewModal
          filePath={previewFile}
          content={previewContent}
          fileType={previewType}
          line={previewLine}
          actions={previewActions}
          siblings={previewSiblings}
          onSwitchSibling={handleSwitchSibling}
          onClose={() => useFileStore.getState().closePreview()}
          onSendComments={handleFileSendComments}
          onAskAgentReview={handleAskAgentReview}
        />
      )}
      {editFile && (
        <FileEditModal
          filePath={editFile}
          content={editContent}
          originalContent={editOriginalContent}
          loading={editLoading}
          saving={editSaving}
          error={editError}
          onChange={(content) => useFileStore.getState().setEditContent(content)}
          onSave={async () => {
            const sid = useSessionStore.getState().sessionId;
            if (sid) await useFileStore.getState().saveEditor(sid);
          }}
          onClose={() => useFileStore.getState().closeEditor()}
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
          onSecretsLoad={async (repoUrl) => { const data = await apiGet<{ keys: string[] }>(`/api/secrets?repoUrl=${encodeURIComponent(repoUrl)}`); return data.keys; }}
          onSecretsSave={(repoUrl, payload) => { apiPut("/api/secrets", { repoUrl, ...payload }).catch(() => {}); }}
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
        onQuickSessionCreated={handleQuickSessionCreated}
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
        onArchiveSession={async (sid: string) => { await useSessionStore.getState().archiveSession(sid); if (sid === useSessionStore.getState().sessionId) { const repoUrl = sessions.find((s) => s.id === sid)?.remoteUrl ?? activeRepoUrl; if (repoUrl) void handleNewSessionForRepo(repoUrl, { preserveMobileView: true }); } }}
        onNewSessionForRepo={handleNewSessionForRepo}
        onToggleSidebarCollapse={() => useUiStore.getState().setSidebarCollapsed(!sidebarCollapsed)}
        repos={repos}
        onAddRepo={() => useRepoStore.getState().setAddRepoDialogOpen(true)}
        onCreateNewRepo={() => {
          // Creating a repo is GitHub-backed. Without a connected account the
          // NewRepoDialog would dead-end on a 401, so route to the AddRepoDialog
          // (which shows an inline Connect GitHub prompt) instead.
          if (!githubStatus.authenticated) {
            useRepoStore.getState().setAddRepoDialogOpen(true);
            return;
          }
          useRepoStore.getState().setAddRepoDialogOpen(false);
          // eslint-disable-next-line no-restricted-syntax -- fire-and-forget one-liner
          if (templates.length === 0) apiGet<{ templates: typeof templates }>("/api/bootstrap").then((d) => useUiStore.getState().setTemplates(d.templates)).catch(() => {});
          // eslint-disable-next-line no-restricted-syntax -- fire-and-forget one-liner
          apiGet<{ orgs: { login: string }[] }>("/api/github/orgs").then((d) => setGithubOrgs(d.orgs.map((o) => o.login))).catch(() => {});
          useRepoStore.getState().setNewRepoDialogOpen(true);
        }}
        toast={toast}
      />
      <AddRepoDialog
        open={addRepoDialogOpen}
        githubAuthenticated={githubStatus.authenticated}
        onGitHubTokenSubmit={async (token: string) => { const result = await useSettingsStore.getState().submitGitHubToken(token); if (result) { usePrStore.getState().setImportSearchResults(result.repos); return true; } return false; }}
        onClose={() => useRepoStore.getState().setAddRepoDialogOpen(false)}
        onAdd={async (url) => { await useRepoStore.getState().addRepo(url); }}
        onRepoReady={(url) => { useRepoStore.getState().setActiveRepoUrl(url); void navigate(repoLabelToNewPath(url)); }}
        onCreateNew={() => {
          useRepoStore.getState().setAddRepoDialogOpen(false);
          // eslint-disable-next-line no-restricted-syntax -- fire-and-forget one-liner
          if (templates.length === 0) apiGet<{ templates: typeof templates }>("/api/bootstrap").then((d) => useUiStore.getState().setTemplates(d.templates)).catch(() => {});
          // eslint-disable-next-line no-restricted-syntax -- fire-and-forget one-liner
          apiGet<{ orgs: { login: string }[] }>("/api/github/orgs").then((d) => setGithubOrgs(d.orgs.map((o) => o.login))).catch(() => {});
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
          orgs={githubOrgs}
          templates={templates}
          creating={creatingRepo}
          onClose={() => useRepoStore.getState().setNewRepoDialogOpen(false)}
          onSubmit={async (name, description, isPrivate, templateId, owner) => {
            useSessionStore.getState().setCreatingRepo(true);
            try {
              const res = await apiPost<{ success: boolean; repoUrl?: string; message?: string }>(
                "/api/repos",
                { repoName: name, description, isPrivate, templateId, owner },
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
      <SandboxDialog
        open={sandboxDialogOpen}
        onOpenChange={(open) => useUiStore.getState().setSandboxDialogOpen(open)}
        creating={creatingSandbox}
        onCreate={async (capabilities) => {
          setCreatingSandbox(true);
          try {
            const newId = await useSessionStore.getState().createSandboxSession(capabilities);
            if (newId) {
              useUiStore.getState().setSandboxDialogOpen(false);
              handleSessionResume(newId, navigate);
            } else {
              useUiStore.getState().setToast({ message: "Failed to create sandbox session" });
            }
          } finally {
            setCreatingSandbox(false);
          }
        }}
      />
    </div>
    </TooltipProvider>
  );
}
