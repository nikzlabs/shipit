/* eslint-disable no-restricted-imports -- App coordinates browser subscriptions and external-system synchronization. */
import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  lazy,
  Suspense,
} from "react";
/* eslint-enable no-restricted-imports */
import { Dialog, DialogContent } from "./components/ui/dialog.js";
import { mobileChatInFront } from "./components/MobileContentPanels.js";
import { TooltipProvider } from "./components/ui/tooltip.js";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useSessionWebSocket } from "./hooks/useSessionWebSocket.js";
import { useServerEvents } from "./hooks/useServerEvents.js";
import { useResizablePanel } from "./hooks/useResizablePanel.js";
import { useSearch } from "./hooks/useSearch.js";
import { useIsMobile } from "./hooks/useMediaQuery.js";
import { useAppViewportHeight } from "./hooks/useAppViewportHeight.js";
import { useNotification } from "./hooks/useNotification.js";
import { useAttentionNotifications } from "./hooks/useAttentionNotifications.js";
import { useTheme } from "./hooks/useTheme.js";
import { useKeybinding } from "./keybindings/use-keybinding.js";
import { useAutoFix } from "./hooks/useAutoFix.js";
import { useAppBootstrap } from "./hooks/useAppBootstrap.js";
import { usePreviewLinkIntent } from "./hooks/usePreviewLinkIntent.js";
import { useComposerNetworkMode } from "./hooks/useSessionNetworkMode.js";
import { useSessionActivation } from "./hooks/useSessionActivation.js";
import { useAppKeyboardShortcuts } from "./hooks/useAppKeyboardShortcuts.js";
import { useAppModals } from "./hooks/useAppModals.js";
import { EyeIcon,
  HardDrivesIcon,
  BookOpenIcon,
  ListChecksIcon,
  FilesIcon,
  TerminalWindowIcon,
  ClockCounterClockwiseIcon,
  PresentationChartIcon,
  GitPullRequestIcon,
  PlugsIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "./design-tokens.js";
import { Tab } from "./components/ui/tab.js";
import { useTabLabelCollapse } from "./hooks/useTabLabelCollapse.js";
import { useApi } from "./hooks/useApi.js";
import { formatErrorForMessage, PREVIEW_SETUP_PROMPT } from "./components/PreviewFrame.js";
import { MessageInput, type SendPayload } from "./components/MessageInput.js";
import { MessageList } from "./components/MessageList.js";
import type { RewindGapAction } from "./components/RewindPoint.js";
import { RocketLaunch } from "./components/RocketLaunch.js";
import { PreviewFrame } from "./components/PreviewFrame.js";
import { RepoTrustBanner } from "./components/RepoTrustBanner.js";
import { RepoTrustNotice } from "./components/RepoTrustNotice.js";
import {
  usePreviewErrors,
  type PreviewError,
} from "./hooks/usePreviewErrors.js";
import { GitHistory } from "./components/GitHistory.js";
import { AuthOverlayContainer } from "./AuthOverlay.js";
import { Settings } from "./components/Settings.js";
import { ProjectSettings } from "./components/ProjectSettings.js";
import type { TrackerId } from "../server/shared/types.js";
import { AppLayout } from "./AppLayout.js";
import { DocsViewer } from "./components/DocsViewer.js";
import { IssuesPanel } from "./components/IssuesPanel.js";
import { useIssuesStore } from "./stores/issues-store.js";
import { PluginReposPanel } from "./components/PluginReposPanel.js";
import {
  pluginsAttention,
  pluginsTabVisible,
  snapshotForSession,
  usePluginReposStore,
} from "./stores/plugin-repos-store.js";
import { FileTree } from "./components/FileTree.js";
import { FilePreviewModal } from "./components/FilePreviewModal.js";
import { FileEditModal } from "./components/FileEditModal.js";
import { TerminalPanel } from "./components/TerminalPanel.js";
import {
  InteractiveTerminal,
  type InteractiveTerminalHandle,
} from "./components/InteractiveTerminal.js";
import { PreviewServicesDrawer } from "./components/PreviewServicesDrawer.js";
import { SearchBar } from "./components/SearchBar.js";
import { ConnectionBanner } from "./components/ConnectionBanner.js";
import { KeyboardShortcutsOverlay } from "./components/KeyboardShortcutsOverlay.js";
import { HomeScreen } from "./components/HomeScreen.js";
import { HarnessOnboardingPanel } from "./components/HarnessOnboardingPanel.js";
import { AddRepoDialog } from "./components/AddRepoDialog.js";
import { AllSessionsDialog } from "./components/AllSessionsDialog.js";
import { NewRepoDialog } from "./components/NewRepoDialog.js";
import { SandboxDialog } from "./components/SandboxDialog.js";
import { SessionSettingsDialog } from "./components/SessionSidebar/SessionSettingsDialog.js";
import { UsageModal } from "./components/UsageModal.js";
import type { TurnDiffData } from "./components/DiffPanel.js";
import type { TurnUsage } from "../server/shared/types.js";
import { deriveEffectivePreviewStatus } from "./utils/preview-status.js";

// Zustand selectors need a stable fallback reference.
const EMPTY_TURN_USAGE: TurnUsage[] = [];

const DiffPanel = lazy(() => {
  // eslint-disable-next-line no-restricted-syntax -- React.lazy requires a promise transform
  return import("./components/DiffPanel.js").then((m) => ({ default: m.DiffPanel }));
});
import { PrLifecycleCard } from "./components/PrLifecycleCard.js";
import { SandboxBanner } from "./components/SandboxBanner.js";
import { NewSessionRepoBar } from "./components/NewSessionRepoBar.js";
import { PrDetailPanel } from "./components/PrDetailPanel.js";
import { PresentPane } from "./components/PresentPane.js";
import { HostPanel } from "./components/HostPanel.js";
import { RebaseBanner } from "./components/RebaseBanner.js";
import { SecretBlockBanner } from "./components/SecretBlockBanner.js";
import { QueueIndicator } from "./components/QueueIndicator.js";
import { AgentStatusBar } from "./components/AgentStatusBar.js";
import { StaleContainerBanner } from "./components/StaleContainerBanner.js";
import type { AgentOption, ModelChoice } from "./agent-types.js";
import type {
  AgentId,
  CredentialRoute,
  DocEntry,
  TrackerIssue,
  ReleaseMechanism,
} from "../server/shared/types.js";

import { useSessionStore } from "./stores/session-store.js";
import { useGitStore } from "./stores/git-store.js";
import { useFileStore, markUploadDeleted, noteUploadDismissed } from "./stores/file-store.js";
import { usePreviewStore } from "./stores/preview-store.js";
import { usePresentStore } from "./stores/present-store.js";
import { useTerminalStore } from "./stores/terminal-store.js";
import { useLogStore } from "./stores/log-store.js";
import { usePrStore } from "./stores/pr-store.js";
import { useSettingsStore } from "./stores/settings-store.js";
import { useUiStore, type RightTab } from "./stores/ui-store.js";
import { useRepoStore } from "./stores/repo-store.js";
import {
  composeReviewMessage,
  resolveReviewer,
} from "./utils/compose-review-body.js";
import { handleSessionResume } from "./stores/actions/session-actions.js";
import {
  parseRepoLabel,
  repoLabelToNewPath,
  parseNewSessionSlug,
} from "./utils/repo-label.js";
import { clearParkedHarness, saveModelId, saveModelSelection, saveRoleName } from "./utils/local-storage.js";
import { applyRoleSeeds } from "./utils/role-seed.js";
import { persistHarnessPick } from "./utils/harness-seed.js";
import {
  siblingsOf,
  orderSiblingsForTabs,
  siblingTabLabel,
  isPlanPath,
} from "./utils/doc-paths.js";
import { dispatchAgentMessage } from "./utils/dispatch-agent-message.js";
import type { ReviewerSlotView, RoleView } from "../server/shared/types/agent-types.js";
import type { AgentInterfaceProvenance } from "../server/shared/agent-interface-sdk/protocol.js";
import { buildIssueSeedPrompt } from "../server/shared/issue-ref.js";
import { sendUserMessage } from "./utils/send-user-message.js";
import { buildReleaseConfirmMessage } from "./utils/release-confirm-message.js";
import { isAgentMessagingBlocked } from "./utils/agent-messaging-trust.js";
import { useChatDisabledReason, useHarnessOnboardingPanelVisible } from "./utils/chat-runnable.js";
import { useGitHubGateLatch } from "./hooks/useGitHubGateLatch.js";
import type { SendCommentsPayload } from "./components/FilePreviewModal.js";
import { Spinner } from "./components/Spinner.js";
import { runSend } from "./utils/send-handler.js";
import { deleteUploadFromServer } from "./hooks/useFileUpload.js";
import { removeDraftUploads } from "./utils/local-storage.js";

export default function App() {
  const { sessionId: urlSessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  const newSessionRepoSlug = parseNewSessionSlug(location.pathname);
  const isNewSessionRoute = newSessionRepoSlug !== undefined;

  useServerEvents();

  const sessionId = useSessionStore((s) => s.sessionId);

  const wsSessionId =
    urlSessionId ?? (isNewSessionRoute ? sessionId : undefined);
  const {
    send,
    lastMessage,
    drainMessages,
    status,
    reconnectAttempt,
    reconnect,
  } = useSessionWebSocket(wsSessionId);
  const { get: apiGet, post: apiPost, put: apiPut } = useApi();
  const terminalRef = useRef<InteractiveTerminalHandle>(null);
  const messages = useSessionStore((s) => s.messages);
  const rewindPreviews = useSessionStore((s) => s.rewindPreviews);
  const isLoading = useSessionStore((s) => s.isLoading);
  const activity = useSessionStore((s) => s.activity);
  const sessions = useSessionStore((s) => s.sessions);
  const queuedMessages = useSessionStore((s) => s.queuedMessages);
  const historyLoaded = useSessionStore((s) => s.historyLoaded);
  const turnUsageForActiveSession = useSessionStore((s) =>
    sessionId ? (s.turnUsage[sessionId] ?? EMPTY_TURN_USAGE) : EMPTY_TURN_USAGE,
  );

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
  const previewOnDisk = useFileStore((s) => s.previewOnDisk);
  const previewLine = useFileStore((s) => s.previewLine);
  const editFile = useFileStore((s) => s.editFile);
  const editContent = useFileStore((s) => s.editContent);
  const editOriginalContent = useFileStore((s) => s.editOriginalContent);
  const editLoading = useFileStore((s) => s.editLoading);
  const editSaving = useFileStore((s) => s.editSaving);
  const editError = useFileStore((s) => s.editError);

  // Warm sessions are excluded from the session list.
  const sessionGraduated = useSessionStore((s) =>
    s.sessions.some((x) => x.id === s.sessionId),
  );

  const previewStatus = usePreviewStore((s) => s.status);
  const selectedPort = usePreviewStore((s) => s.selectedPort);
  const composeServices = usePreviewStore((s) => s.services);
  const presentations = usePresentStore((s) => s.presentations);
  const presentUnseenCount = usePresentStore((s) => s.unseenCount);

  const terminalMode = useTerminalStore((s) => s.mode);
  const shellStarted = useTerminalStore((s) => s.shellStarted);

  const importSearchResults = usePrStore((s) => s.importSearchResults);
  const hasPr = usePrStore((s) => {
    if (!wsSessionId) return false;
    const card = s.cardBySession[wsSessionId];
    return (
      !!card?.pr &&
      (card.phase === "open" ||
        card.phase === "merged" ||
        card.phase === "closed")
    );
  });
  const permissionMode = useSettingsStore((s) =>
    wsSessionId && wsSessionId in s.permissionModeBySession
      ? s.permissionModeBySession[wsSessionId]
      : s.permissionMode,
  );
  const pendingFiles = useSettingsStore((s) => s.pendingFiles);
  const githubStatus = useSettingsStore((s) => s.githubStatus);
  const hasSystemPrompt = useSettingsStore((s) => s.hasSystemPrompt);
  const systemPromptContent = useSettingsStore((s) => s.systemPromptContent);
  const agentSystemInstructionsEnabled = useSettingsStore(
    (s) => s.agentSystemInstructionsEnabled,
  );
  const agentSystemInstructions = useSettingsStore(
    (s) => s.agentSystemInstructions,
  );
  const memoryBudgetMb = useSettingsStore((s) => s.memoryBudgetMb);

  const rightTabRaw = useUiStore((s) => s.rightTab);
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const isLocalMode = runtimeMode === "local";
  const isOpsSession = useMemo(
    () => sessions.find((s) => s.id === wsSessionId)?.kind === "ops",
    [sessions, wsSessionId],
  );
  const isSandboxSession = useMemo(
    () => sessions.find((s) => s.id === wsSessionId)?.kind === "sandbox",
    [sessions, wsSessionId],
  );
  const pluginSnapshot = usePluginReposStore((s) => snapshotForSession(s, sessionId));
  const showPluginsTab = pluginsTabVisible(pluginSnapshot);
  const rightTab = (() => {
    if (isOpsSession && (rightTabRaw === "preview" || rightTabRaw === "pr"))
      {return "host";}
    if (!isOpsSession && rightTabRaw === "host") return "files";
    if (isSandboxSession && (rightTabRaw === "preview" || rightTabRaw === "pr"))
      {return "files";}
    if (
      isLocalMode &&
      (rightTabRaw === "preview" || rightTabRaw === "terminal")
    )
      {return "files";}
    if (rightTabRaw === "plugins" && !showPluginsTab) {
      return isLocalMode || isOpsSession || isSandboxSession ? "files" : "preview";
    }
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
  const sessionSettingsDialogOpen = useUiStore((s) => s.sessionSettingsDialogOpen);
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
  const allSessionsDialogRepoUrl = useSessionStore((s) => s.allSessionsDialogRepoUrl);
  const allSessions = useSessionStore((s) => s.allSessions);
  const currentSession = useMemo(
    () => sessions.find((s) => s.id === sessionId),
    [sessions, sessionId],
  );

  const liveSteeringActive =
    liveSteering &&
    (agentList.find((a) => a.id === activeAgentId)?.supportsSteering ?? false);

  const githubNeeded = bootstrapLoaded && !githubStatus.authenticated;
  const { showGitHubGate, dismiss: dismissGitHubGate } = useGitHubGateLatch(githubNeeded);
  const [creatingSandbox, setCreatingSandbox] = useState(false);
  const showHarnessOnboarding = useHarnessOnboardingPanelVisible(showGitHubGate);

  const { fraction, isDragging, onMouseDown, onTouchStart, containerRef } =
    useResizablePanel({
      initialFraction: 0.5,
      minFraction: 0.25,
      storageKey: "vibe-panel-split",
    });
  const isMobile = useIsMobile();
  useAppViewportHeight();
  const {
    searchOpen,
    setSearchOpen,
    shortcutsOpen,
    setShortcutsOpen,
    githubOrgs,
    setGithubOrgs,
  } = useAppModals();
  const newSessionRepoUrl = useMemo(() => {
    if (!newSessionRepoSlug) return undefined;
    return repos.find((r) => parseRepoLabel(r.url) === newSessionRepoSlug)?.url;
  }, [newSessionRepoSlug, repos]);
  const currentRepoUrl = currentSession?.remoteUrl ?? newSessionRepoUrl;
  const currentRepo = currentRepoUrl
    ? repos.find(
        (repo) => parseRepoLabel(repo.url) === parseRepoLabel(currentRepoUrl),
      )
    : undefined;
  const agentMessagingBlocked = isAgentMessagingBlocked(
    currentSession,
    currentRepoUrl,
    currentRepo,
  );
  const chatDisabledReason = useChatDisabledReason();
  const search = useSearch(messages);
  const { notify, requestPermission } = useNotification();
  useAttentionNotifications(notify);
  const { theme, setTheme } = useTheme();
  const { errors: previewErrors, clearErrors: clearPreviewErrors } =
    usePreviewErrors();

  const { disableAutoFix } = useAutoFix({
    previewErrors,
    isLoading,
    status,
  });

  const { showBootstrapSpinner } = useAppBootstrap({
    status,
    send,
    lastMessage,
    drainMessages,
    terminalRef,
    bootstrapLoaded,
    reconnect,
  });

  const composerNetworkState = useComposerNetworkMode(
    wsSessionId ?? null,
    isNewSessionRoute,
    newSessionRepoSlug ?? null,
  );
  const composerNetwork = useMemo(
    () => ({
      mode: composerNetworkState.mode,
      onChange: composerNetworkState.setMode,
      globalEnabled: composerNetworkState.globalEnabled,
      enforcementStatus: composerNetworkState.enforcementStatus,
      pendingRestart: composerNetworkState.pendingRestart,
      loaded: composerNetworkState.loaded,
      saving: composerNetworkState.saving,
      beforeFirstTurn: !currentSession,
    }),
    [composerNetworkState, currentSession],
  );

  const staleRunnerNonce = useSessionStore((s) => s.staleRunnerNonce);
  // eslint-disable-next-line no-restricted-syntax -- external system sync: reattach the WebSocket after the server replaced this session's runner
  useEffect(() => {
    // Zero is the initial value, not a replacement event.
    if (staleRunnerNonce > 0) reconnect();
  }, [staleRunnerNonce, reconnect]);

  usePreviewLinkIntent(sessionId, send);

  const {
    handleNewSessionForRepo,
    handleNewSessionShortcut,
    handleQuickSessionCreated,
  } = useSessionActivation({
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

  const handleSend = useCallback(
    (payload: SendPayload): boolean =>
      runSend(
        { send, requestPermission, disableAutoFix, navigate, isNewSessionRoute },
        payload,
      ),
    [send, requestPermission, disableAutoFix, navigate, isNewSessionRoute],
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
        send({
          type: "rewind_at_gap",
          gapPosition,
          action,
          sessionName: sessionName?.trim() || undefined,
        });
        return;
      }
      send({ type: "rewind_at_gap", gapPosition, action });
    },
    [send],
  );

  const sendErrorsInFlight = useRef(false);
  const createPrInFlight = useRef(false);
  const composeErrorInFlight = useRef(false);
  const composeHintInFlight = useRef(false);

  const handleAgentInterfaceMessage = useCallback(async (
    text: string,
    provenance: AgentInterfaceProvenance,
  ): Promise<void> => {
    const sid = useSessionStore.getState().sessionId;
    if (!sid) throw new Error("No active ShipIt session");
    await dispatchAgentMessage({
      sessionId: sid,
      text,
      activity: "Responding to interface…",
      apiPost,
      agentInterface: provenance,
    });
  }, [apiPost]);

  const handleSendErrors = useCallback(
    (errors: PreviewError[]) => {
      if (sendErrorsInFlight.current) return;
      const sid = useSessionStore.getState().sessionId;
      if (!sid) return;
      const text = formatErrorForMessage(errors);
      requestPermission();
      useUiStore.getState().setShowTemplates(false);
      sendErrorsInFlight.current = true;
      void dispatchAgentMessage({
        sessionId: sid,
        text,
        activity: "Fixing preview errors…",
        apiPost,
      })
        .catch(() => {
          /* helper surfaces toast */
        })
        .finally(() => {
          sendErrorsInFlight.current = false;
        });
    },
    [requestPermission, apiPost],
  );

  const handleCreatePr = useCallback(() => {
    if (createPrInFlight.current) return;
    const sid = useSessionStore.getState().sessionId;
    if (!sid) return;
    const text =
      "Please create a pull request for the changes in this session.";
    requestPermission();
    useUiStore.getState().setShowTemplates(false);
    createPrInFlight.current = true;
    void dispatchAgentMessage({
      sessionId: sid,
      text,
      activity: "Creating PR…",
      apiPost,
    })
      .catch(() => {
        /* helper surfaces toast */
      })
      .finally(() => {
        createPrInFlight.current = false;
      });
  }, [requestPermission, apiPost]);

  const handleSendComposeErrorToAgent = useCallback(() => {
    if (composeErrorInFlight.current) return;
    const { composeError } = usePreviewStore.getState();
    if (!composeError) return;
    const sid = useSessionStore.getState().sessionId;
    if (!sid) return;
    const text = `Docker Compose failed to start:\n\n\`\`\`\n${composeError.trim()}\n\`\`\`\n\nPlease fix this error so the services can start successfully.`;
    requestPermission();
    if (isNewSessionRoute) {
      void navigate(`/session/${sid}`, { replace: true });
    }
    useUiStore.getState().setMobilePanel("chat");
    composeErrorInFlight.current = true;
    void dispatchAgentMessage({
      sessionId: sid,
      text,
      activity: "Fixing compose error…",
      apiPost,
    })
      .catch(() => {
        /* helper surfaces toast */
      })
      .finally(() => {
        composeErrorInFlight.current = false;
      });
  }, [requestPermission, apiPost, isNewSessionRoute, navigate]);

  const handleSendComposeHintToAgent = useCallback(() => {
    if (composeHintInFlight.current) return;
    const sid = useSessionStore.getState().sessionId;
    if (!sid) return;
    const text = PREVIEW_SETUP_PROMPT;
    requestPermission();
    if (isNewSessionRoute) {
      void navigate(`/session/${sid}`, { replace: true });
    }
    useUiStore.getState().setMobilePanel("chat");
    composeHintInFlight.current = true;
    void dispatchAgentMessage({
      sessionId: sid,
      text,
      activity: "Setting up preview…",
      apiPost,
    })
      .catch(() => {
        /* helper surfaces toast */
      })
      .finally(() => {
        composeHintInFlight.current = false;
      });
  }, [requestPermission, apiPost, isNewSessionRoute, navigate]);

  const handleSendServiceLogsToAgent = useCallback(
    (serviceName: string, status: string, logs: string) => {
      const sid = useSessionStore.getState().sessionId;
      if (!sid) return;
      const lines = [
        `The Docker Compose service "${serviceName}" is in state "${status}". Recent logs:`,
        "",
      ];
      if (logs) {
        lines.push("```", logs, "```", "");
      }
      lines.push("Please investigate and fix the issue.");
      useSessionStore.getState().setPrefillText(lines.join("\n"));
      useUiStore.getState().setMobilePanel("chat");
    },
    [],
  );

  const handleAnswerQuestion = useCallback(
    (toolUseId: string, answers: Record<string, string>, text: string, dictated?: boolean): boolean => {
      const session = useSessionStore.getState();
      const pm = useSettingsStore
        .getState()
        .getPermissionMode(session.sessionId);
      return sendUserMessage({
        bubble: { role: "user", text },
        activity: "Thinking...",
        dispatch: (requestId) =>
          send({
            type: "answer_question",
            requestId,
            toolUseId,
            answers,
            text,
            ...(pm !== "auto" ? { permissionMode: pm } : {}),
            ...(dictated ? { dictated: true } : {}),
          }),
      });
    },
    [send],
  );

  const handleSendFollowUp = useCallback(
    (text: string): boolean => {
      const session = useSessionStore.getState();
      const pm = useSettingsStore
        .getState()
        .getPermissionMode(session.sessionId);
      return sendUserMessage({
        bubble: { role: "user", text },
        activity: "Thinking...",
        dispatch: (requestId) =>
          send({
            type: "send_message",
            requestId,
            text,
            sessionId: session.sessionId,
            permissionMode: pm !== "auto" ? pm : undefined,
          }),
      });
    },
    [send],
  );

  const handleReleaseConfirm = useCallback(
    (version: string, mechanism: ReleaseMechanism) => {
      const session = useSessionStore.getState();
      const pm = useSettingsStore
        .getState()
        .getPermissionMode(session.sessionId);
      const text = buildReleaseConfirmMessage(version, mechanism);
      sendUserMessage({
        bubble: { role: "user", text },
        activity: "Publishing release...",
        dispatch: (requestId) =>
          send({
            type: "send_message",
            requestId,
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
        dispatch: (requestId) =>
          send({
            type: "send_message",
            requestId,
            text,
            sessionId: session.sessionId ?? undefined,
          }),
      });
    },
    [send],
  );

  useAppKeyboardShortcuts({
    setShortcutsOpen,
    handleNewSessionShortcut,
    quickCaptureHotkey,
    voiceInputEnabled,
    voiceHotkeyModeB,
  });

  const handleTabChange = useCallback(
    (tab: RightTab) => {
      useUiStore.getState().setRightTab(tab);
      const sid = useSessionStore.getState().sessionId;
      if (
        tab === "docs" &&
        useFileStore.getState().docFiles.length === 0 &&
        sid
      )
        {useFileStore
          .getState()
          .fetchDocs(sid)
          .catch(() => {});}
      if (tab === "files" && sid) {
        useFileStore
          .getState()
          .fetchTree(sid)
          .catch(() => {});
      }
      if (tab === "history" && sid)
        {useGitStore
          .getState()
          .fetchLog(sid)
          .catch(() => {});}
      if (tab === "present") usePresentStore.getState().markSeen();
    },
    [],
  );

  const handleOpenIssue = useCallback(
    (ref: {
      tracker: TrackerId;
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

  // eslint-disable-next-line no-restricted-syntax -- external system sync: fetch issues when the tab becomes active (incl. reload-restored tab)
  useEffect(() => {
    if (rightTab !== "issues") return;
    void (async () => {
      await useIssuesStore.getState().warmTrackers();
      await useIssuesStore.getState().fetchIssues();
    })();
  }, [rightTab]);

  // eslint-disable-next-line no-restricted-syntax -- external system sync: seed plugin declarations for tab gating
  useEffect(() => {
    if (!sessionId) return;
    void usePluginReposStore.getState().fetchSnapshot(sessionId);
  }, [sessionId]);

  // eslint-disable-next-line no-restricted-syntax -- external system sync: warm tracker config for inline issue-link interception
  useEffect(() => {
    void (async () => {
      await useIssuesStore.getState().warmTrackers();
      if (useUiStore.getState().rightTab === "issues") {
        await useIssuesStore.getState().fetchIssues();
      }
    })();
  }, [sessionId]);

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

  const handleSettingsOpen = useCallback(
    async (
      tab?:
        | "services"
        | "integrations"
        | "git"
        | "instructions"
        | "advanced"
        | "keyboard",
    ) => {
      useUiStore.getState().setSettingsTab(tab);
      useUiStore.getState().setSettingsOpen(true);
      try {
        const data = await apiGet<{
          settings: {
            canRunTurns?: boolean;
            harnessOnboardingCompletedAt?: string;
            gitIdentity: { name: string; email: string };
            systemPrompt: string;
            agents: AgentOption[];
            memoryBudgetMb?: number | null;
            agentSystemInstructionsEnabled?: boolean;
            agentSystemInstructions?: string;
            autoCreatePr?: boolean;
            liveSteering?: boolean;
            autoResolveConflicts?: boolean;
            autoFixCi?: boolean;
            autoResetMergedBranch?: boolean;
            enableSubAgents?: boolean;
            voiceDeliveryMode?: "native" | "external" | "both";
            voiceWebhookConfigured?: boolean;
            providerAccounts?: CredentialRoute[];
            failoverCutoffs?: Record<string, { session: number; weekly: number }>;
            accountSelectionMode?: Record<string, "strict" | "balanced">;
            nonTurnModel?: { serviceId: string; billingMode: "sub" | "key"; modelId: string };
            nonTurnModelResolved?: {
              serviceId: string;
              billingMode: "sub" | "key";
              modelId: string;
              serviceName: string;
              label: string;
              harnessId: string;
              source: "pinned" | "default";
            };
            reviewers?: ReviewerSlotView[];
            roles?: RoleView[];
          };
        }>("/api/bootstrap");
        useGitStore.getState().setIdentity(data.settings.gitIdentity);
        if (data.settings.canRunTurns !== undefined)
          {useSettingsStore.getState().setCanRunTurns(data.settings.canRunTurns);}
        useSettingsStore.getState()
          .setHarnessOnboardingCompletedAt(data.settings.harnessOnboardingCompletedAt ?? null);
        useSettingsStore
          .getState()
          .setSystemPromptContent(data.settings.systemPrompt);
        useSettingsStore
          .getState()
          .setHasSystemPrompt(data.settings.systemPrompt.length > 0);
        if (data.settings.memoryBudgetMb !== undefined)
          {useSettingsStore
            .getState()
            .setMemoryBudgetMb(data.settings.memoryBudgetMb);}
        if (data.settings.agentSystemInstructionsEnabled !== undefined)
          {useSettingsStore
            .getState()
            .setAgentSystemInstructionsEnabled(
              data.settings.agentSystemInstructionsEnabled,
            );}
        if (data.settings.agentSystemInstructions)
          {useSettingsStore
            .getState()
            .setAgentSystemInstructions(data.settings.agentSystemInstructions);}
        if (data.settings.autoCreatePr !== undefined)
          {useSettingsStore
            .getState()
            .setAutoCreatePr(data.settings.autoCreatePr);}
        if (data.settings.liveSteering !== undefined)
          {useSettingsStore
            .getState()
            .setLiveSteering(data.settings.liveSteering);}
        if (data.settings.autoResolveConflicts !== undefined)
          {useSettingsStore
            .getState()
            .setAutoResolveConflicts(data.settings.autoResolveConflicts);}
        if (data.settings.autoFixCi !== undefined)
          {useSettingsStore.getState().setAutoFixCi(data.settings.autoFixCi);}
        if (data.settings.failoverCutoffs !== undefined) {
          for (const [agentId, cutoffs] of Object.entries(data.settings.failoverCutoffs)) {
            useSettingsStore.getState().setFailoverCutoffs(agentId, cutoffs);
          }
        }
        if (data.settings.accountSelectionMode !== undefined) {
          for (const [agentId, mode] of Object.entries(data.settings.accountSelectionMode)) {
            useSettingsStore.getState().setAccountSelectionMode(agentId, mode);
          }
        }
        if (data.settings.autoResetMergedBranch !== undefined)
          {useSettingsStore
            .getState()
            .setAutoResetMergedBranch(data.settings.autoResetMergedBranch);}
        if (data.settings.enableSubAgents !== undefined)
          {useSettingsStore
            .getState()
            .setEnableSubAgents(data.settings.enableSubAgents);}
        if (data.settings.voiceDeliveryMode !== undefined)
          {useSettingsStore
            .getState()
            .setVoiceDeliveryMode(data.settings.voiceDeliveryMode);}
        if (data.settings.voiceWebhookConfigured !== undefined)
          {useSettingsStore
            .getState()
            .setVoiceWebhookConfigured(data.settings.voiceWebhookConfigured);}
        useSettingsStore.getState().setNonTurnModel(
          data.settings.nonTurnModel ?? null,
          data.settings.nonTurnModelResolved ?? null,
        );
        if (data.settings.reviewers)
          {useSettingsStore.getState().setReviewers(data.settings.reviewers);}
        if (data.settings.roles) {useSettingsStore.getState().setRoles(data.settings.roles);}
        if (data.settings.providerAccounts)
          {useSettingsStore
            .getState()
            .setProviderAccounts(data.settings.providerAccounts);}
        useUiStore.getState().setAgentList(data.settings.agents);
      } catch {
        /* ignore */
      }
    },
    [apiGet],
  );

  const GIT_EMPTY_TREE = "4b825dc642cb6404f32168ace2c04d9f6e8f59b6";

  const handleViewDiff = useCallback(
    async (commitHash: string, parentHash: string | null) => {
      const sid = useSessionStore.getState().sessionId;
      if (!sid) return;
      const from = parentHash ?? GIT_EMPTY_TREE;
      try {
        const res = await fetch(
          `/api/sessions/${sid}/git/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(commitHash)}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as TurnDiffData;
        const commitMsg = useGitStore
          .getState()
          .commits.find((c) => c.hash === commitHash)?.message;
        useGitStore.getState().setTurnDiff(data);
        useGitStore.getState().openDiffDialog(commitMsg);
      } catch {
        /* ignore */
      }
    },
    [],
  );

  const handleOpenDoc = useCallback((filePath: string, doc?: DocEntry) => {
    const sid = useSessionStore.getState().sessionId;
    if (!sid) return;
    const isWorkDoc =
      !!doc && (isPlanPath(doc.path) || doc.issue !== undefined);
    const actions = isWorkDoc
      ? [
          {
            label: "Start Session",
            onClick: () => handleDocStartSession(doc),
            variant: "primary" as const,
          },
        ]
      : undefined;
    void useFileStore.getState().openPreview(sid, filePath, { actions });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `handleDocStartSession` is declared below and used only in the deferred onClick; naming it here would read the const before its initializer (TDZ)
  }, []);

  const handleOpenFilePreview = useCallback((filePath: string) => {
    const sid = useSessionStore.getState().sessionId;
    if (sid) void useFileStore.getState().openPreview(sid, filePath);
  }, []);

  const handleDocStartSession = useCallback(
    async (doc: DocEntry) => {
      useFileStore.getState().closePreview();

      const { messages, sessions, sessionId } = useSessionStore.getState();
      const repoUrl =
        sessions.find((s) => s.id === sessionId)?.remoteUrl ??
        useRepoStore.getState().activeRepoUrl;

      if (messages.length > 0 && repoUrl) {
        await handleNewSessionForRepo(repoUrl);
      }

      const text = `Work on: ${doc.title}\n\nPlease read the plan at ${doc.path}, then proceed with the implementation.`;
      useSessionStore.getState().setPrefillText(text);
      useUiStore.getState().setMobilePanel("chat");
    },
    [handleNewSessionForRepo],
  );

  const handleIssueStartSession = useCallback(
    async (issue: TrackerIssue, tracker: TrackerId, pickedRepoUrl?: string) => {
      const { messages, sessions, sessionId } = useSessionStore.getState();
      const defaultRepoUrl =
        sessions.find((s) => s.id === sessionId)?.remoteUrl ??
        useRepoStore.getState().activeRepoUrl;

      const repoUrl = pickedRepoUrl ?? defaultRepoUrl;
      const switchingRepo = Boolean(repoUrl) && repoUrl !== defaultRepoUrl;

      if (repoUrl && (switchingRepo || messages.length > 0)) {
        if (switchingRepo) useRepoStore.getState().setActiveRepoUrl(repoUrl);
        await handleNewSessionForRepo(repoUrl);
      }

      useSessionStore.getState().setPrefillText(buildIssueSeedPrompt(issue));

      // Keep provenance separate from the editable prompt.
      const seededSessionId = useSessionStore.getState().sessionId;
      useSessionStore.getState().setPendingIssueRef(
        seededSessionId
          ? {
            sessionId: seededSessionId,
            ref: {
              tracker,
              identifier: issue.identifier,
              title: issue.title,
              ...(issue.url ? { url: issue.url } : {}),
              ...(issue.description ? { description: issue.description } : {}),
            },
          }
          : undefined,
      );
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
        dispatch: (requestId) =>
          send({
            type: "send_message",
            requestId,
            text: prompt,
            sessionId: sid ?? undefined,
            userReview: { filePaths, commentCount },
          }),
      });
    },
    [send],
  );

  const handleAskAgentReview = useCallback(
    (reviewFilePath: string) => {
      const sid = useSessionStore.getState().sessionId;
      const prompt = composeReviewMessage(
        reviewFilePath,
        resolveReviewer({
          enableSubAgents: useSettingsStore.getState().enableSubAgents,
          activeAgentId: useUiStore.getState().activeAgentId,
        }),
      );
      if (sid && isNewSessionRoute) {
        void navigate(`/session/${sid}`, { replace: true });
      }
      useFileStore.getState().closePreview();
      useUiStore.getState().setMobilePanel("chat");
      sendUserMessage({
        bubble: { role: "user", text: prompt },
        activity: "Reviewing...",
        dispatch: (requestId) =>
          send({ type: "send_message", requestId, text: prompt, sessionId: sid }),
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
    if (sid)
      {useUiStore
        .getState()
        .fetchUsageStats(sid)
        .catch(() => {});}
  }, []);

  const handleAgentChange = useCallback(
    (agentId: AgentId) => {
      const liveModel = useUiStore.getState().modelInfo?.model;
      persistHarnessPick({
        agentId,
        agents: useUiStore.getState().agentList,
        ...(liveModel ? { current: { modelId: liveModel } } : {}),
      });
      useUiStore.getState().setActiveAgentId(agentId);
      send({ type: "set_agent", agentId });
      const sid = useSessionStore.getState().sessionId;
      if (sid)
        {void useFileStore
          .getState()
          .fetchSkills(sid, agentId)
          .catch(() => {});}
    },
    [send],
  );

  const handleModelChange = useCallback(
    (selection: ModelChoice) => {
      clearParkedHarness();
      if (selection.serviceId) {
        saveModelSelection({
          serviceId: selection.serviceId,
          billingMode: selection.billingMode,
          modelId: selection.modelId,
        });
      } else {
        saveModelId(selection.modelId);
      }
      send({
        type: "set_model",
        model: selection.modelId,
        ...(selection.serviceId
          ? { serviceId: selection.serviceId, billingMode: selection.billingMode }
          : {}),
      });
    },
    [send],
  );

  const handleReasoningChange = useCallback(
    (effort: string | null) => {
      send({ type: "set_reasoning", effort });
    },
    [send],
  );

  const handleRoleChange = useCallback(
    (roleName: string | undefined) => {
      saveRoleName(roleName);
      if (roleName === undefined) {
        send({ type: "set_role", roleName: null });
        return;
      }
      applyRoleSeeds(useSettingsStore.getState().roles.find((r) => r.name === roleName));
      clearParkedHarness();
      send({ type: "set_role", roleName });
    },
    [send],
  );

  const handleInstructionsSave = useCallback(async (content: string) => {
    await useSettingsStore
      .getState()
      .saveInstructions(content)
      .catch(() => {});
    useUiStore.getState().setSettingsOpen(false);
  }, []);

  const effectivePreviewStatus = deriveEffectivePreviewStatus(
    previewStatus,
    composeServices,
    sessionId,
  );
  const detectedPorts = effectivePreviewStatus?.detectedPorts ?? [];
  const showNewSessionView = isNewSessionRoute && !urlSessionId;
  const showHomeScreen =
    !showNewSessionView &&
    (!sessionId || (showTemplates && messages.length === 0 && !isLoading));
  const isHomeRoute = !urlSessionId && !isNewSessionRoute;
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (!isMobile) return;
    useUiStore.getState().setMobileSidebarOpen(isHomeRoute);
  }, [isMobile, isHomeRoute]);
  const showRocket =
    messages.length === 0 &&
    !isLoading &&
    (historyLoaded || showNewSessionView);
  // The route slug stays stable through claim and repo-list loading, preserving drafts.
  const messageInputFocusKey = showNewSessionView
    ? `new:${newSessionRepoSlug}`
    : wsSessionId;

  const previewVisible =
    !isLocalMode && (rightTab === "preview" || (rightTab === "pr" && !hasPr));
  const previewOnScreen =
    previewVisible &&
    !(isMobile && mobileChatInFront({ showHomeScreen, showNewSessionView, activePanel: mobilePanel }));
  const tabBarRef = useTabLabelCollapse(
    [
      isLocalMode,
      isOpsSession,
      isSandboxSession,
      presentations.length > 0,
      hasPr,
      rightTab !== "present" && presentUnseenCount > 0,
      showPluginsTab,
    ].join("|"),
  );
  const rightPanel = (
    <>
      <div
        ref={tabBarRef}
        className="group/tabs flex h-10.25 min-w-0 overflow-x-auto no-scrollbar border-b border-(--color-border-primary) bg-(--color-bg-secondary)"
      >
        {!isLocalMode && !isOpsSession && !isSandboxSession && (
          <Tab
            icon={<EyeIcon size={ICON_SIZE.SM} />}
            label="Preview"
            active={rightTab === "preview"}
            onClick={() => handleTabChange("preview")}
          />
        )}
        {isOpsSession && (
          <Tab
            icon={<HardDrivesIcon size={ICON_SIZE.SM} />}
            label="Host"
            active={rightTab === "host"}
            onClick={() => handleTabChange("host")}
          />
        )}
        <Tab
          icon={<BookOpenIcon size={ICON_SIZE.SM} />}
          label="Docs"
          active={rightTab === "docs"}
          onClick={() => handleTabChange("docs")}
        />
        <Tab
          icon={<ListChecksIcon size={ICON_SIZE.SM} />}
          label="Issues"
          active={rightTab === "issues"}
          onClick={() => handleTabChange("issues")}
        />
        <Tab
          icon={<FilesIcon size={ICON_SIZE.SM} />}
          label="Files"
          active={rightTab === "files"}
          onClick={() => handleTabChange("files")}
        />
        {showPluginsTab && (
          <Tab
            icon={<PlugsIcon size={ICON_SIZE.SM} />}
            label="Plugins"
            active={rightTab === "plugins"}
            onClick={() => handleTabChange("plugins")}
            badge={
              pluginsAttention(pluginSnapshot) ? (
                <span
                  role="img"
                  aria-label="Plugins — attention required"
                  className="inline-block w-2 h-2 rounded-full bg-(--color-warning)"
                />
              ) : undefined
            }
          />
        )}
        {!isLocalMode && (
          <Tab
            icon={<TerminalWindowIcon size={ICON_SIZE.SM} />}
            label="Terminal"
            active={rightTab === "terminal"}
            onClick={() => handleTabChange("terminal")}
          />
        )}
        <Tab
          icon={<ClockCounterClockwiseIcon size={ICON_SIZE.SM} />}
          label="History"
          active={rightTab === "history"}
          onClick={() => handleTabChange("history")}
        />
        <span className="flex-1" />
        {(presentations.length > 0 ||
          (hasPr && !isOpsSession && !isSandboxSession)) && (
          <span
            className="self-center h-[18px] w-px bg-(--color-border-secondary) mx-1"
            aria-hidden="true"
          />
        )}
        {presentations.length > 0 && (
          <Tab
            icon={<PresentationChartIcon size={ICON_SIZE.SM} />}
            label="Present"
            active={rightTab === "present"}
            onClick={() => handleTabChange("present")}
            badge={
              rightTab !== "present" && presentUnseenCount > 0 ? (
                <span className="inline-flex items-center justify-center min-w-[1.25rem] h-4 px-1 rounded-full bg-(--color-accent) text-(--color-accent-text) text-[10px] font-semibold leading-none">
                  {presentUnseenCount}
                </span>
              ) : undefined
            }
          />
        )}
        {hasPr && !isOpsSession && !isSandboxSession && (
          <Tab
            icon={<GitPullRequestIcon size={ICON_SIZE.SM} />}
            label="PR"
            tone="pr"
            active={rightTab === "pr"}
            onClick={() => handleTabChange("pr")}
          />
        )}
      </div>
      <div className="flex-1 min-h-0 relative">
        <div
          className={`absolute inset-0 flex flex-col ${previewVisible ? "" : "invisible pointer-events-none"}`}
        >
          <div className="flex-1 min-h-0 relative">
            <PreviewFrame
              paneVisible={previewOnScreen}
              preview={effectivePreviewStatus}
              sessionId={sessionId}
              detectedPorts={detectedPorts}
              selectedPort={selectedPort}
              onSelectPort={(p) =>
                usePreviewStore.getState().setSelectedPort(p)
              }
              errors={previewErrors}
              onSendErrors={handleSendErrors}
              onClearErrors={clearPreviewErrors}
              onSendCrashToAgent={handleSendComposeErrorToAgent}
              onSendComposeHintToAgent={handleSendComposeHintToAgent}
              onAgentInterfaceMessage={handleAgentInterfaceMessage}
            />
            <RepoTrustBanner key={currentRepoUrl} repoUrl={currentRepoUrl} />
          </div>
          <PreviewServicesDrawer
            services={composeServices}
            sessionId={sessionId}
            active={previewVisible}
            previewRunning={!!effectivePreviewStatus?.running}
            send={send}
            onSendToAgent={handleSendServiceLogsToAgent}
            onSelectPreviewPort={(port) =>
              usePreviewStore.getState().setSelectedPort(port)
            }
          />
        </div>
        {rightTab === "docs" ? (
          <DocsViewer
            files={docFiles}
            onFileClick={(f) => {
              const doc = docFiles.find((d) => d.path === f);
              handleOpenDoc(f, doc);
            }}
            onRefresh={() => {
              const sid = useSessionStore.getState().sessionId;
              if (sid)
                {useFileStore
                  .getState()
                  .fetchDocs(sid)
                  .catch(() => {});}
            }}
            onOpenIssue={handleOpenIssue}
          />
        ) : rightTab === "plugins" ? (
          <PluginReposPanel />
        ) : rightTab === "issues" ? (
          <IssuesPanel
            onStartSession={handleIssueStartSession}
            onConnect={() => {
              void handleSettingsOpen("integrations");
            }}
          />
        ) : rightTab === "terminal" ? (
          <TerminalPanel
            onClear={() => {
              useLogStore.getState().clearChannel("agent");
              send({ type: "log_clear", channel: "agent" });
            }}
            terminalMode={terminalMode}
            onTerminalModeChange={(m) => useTerminalStore.getState().setMode(m)}
            send={send}
            sessionId={wsSessionId}
            onReconnectWs={reconnect}
            shellContent={
              shellStarted || terminalMode === "shell" ? (
                <InteractiveTerminal
                  ref={terminalRef}
                  onInput={(d) => send({ type: "terminal_input", data: d })}
                  onResize={(cols, rows) =>
                    send({ type: "terminal_resize", cols, rows })
                  }
                  onStart={(cols, rows) => {
                    send({ type: "terminal_start", cols, rows });
                    useTerminalStore.getState().setShellStarted(true);
                  }}
                />
              ) : null
            }
          />
        ) : rightTab === "history" ? (
          <GitHistory
            commits={gitCommits}
            onRefresh={() => {
              const sid = useSessionStore.getState().sessionId;
              if (sid)
                {useGitStore
                  .getState()
                  .fetchLog(sid)
                  .catch(() => {});}
            }}
            onViewDiff={handleViewDiff}
          />
        ) : rightTab === "pr" && hasPr && wsSessionId ? (
          <PrDetailPanel sessionId={wsSessionId} />
        ) : rightTab === "files" ? (
          <FileTree
            tree={fileTree}
            onRefresh={() => {
              const sid = useSessionStore.getState().sessionId;
              if (sid) {
                useFileStore
                  .getState()
                  .fetchTree(sid)
                  .catch(() => {});
                void useFileStore.getState().hydrateUploads(sid);
              }
            }}
            onFileClick={handleOpenFilePreview}
            onEdit={
              sessionGraduated
                ? (f) => {
                    const sid = useSessionStore.getState().sessionId;
                    if (sid) void useFileStore.getState().openEditor(sid, f);
                  }
                : undefined
            }
            onAddToChat={
              chatDisabledReason
                ? undefined
                : (f) => useSettingsStore.getState().addPendingFile(f)
            }
            onDownload={(f) => {
              const sid = useSessionStore.getState().sessionId;
              if (sid) {
                const a = document.createElement("a");
                a.href = `/api/sessions/${sid}/files/download/${f}`;
                a.download = "";
                document.body.appendChild(a);
                a.click();
                a.remove();
              }
            }}
            uploads={sessionUploads}
            onDeleteUpload={(u) => {
              const sid = useSessionStore.getState().sessionId;
              noteUploadDismissed(u.id);
              if (u.path) markUploadDeleted(u.path);
              if (sid && u.path) {
                removeDraftUploads(sid, [u.path]);
                void deleteUploadFromServer(sid, u.path);
              }
              if (u.previewUrl) URL.revokeObjectURL(u.previewUrl);
              if (u.path) useFileStore.getState().removeSessionUpload(u.path);
              else useFileStore.getState().removeSessionUploadById(u.id);
            }}
          />
        ) : rightTab === "present" ? (
          <PresentPane
            isActiveTab={rightTab === "present"}
            onSendComments={handleFileSendComments}
            onAskAgentReview={handleAskAgentReview}
            onAgentInterfaceMessage={handleAgentInterfaceMessage}
          />
        ) : rightTab === "host" ? (
          <HostPanel isActiveTab={rightTab === "host"} />
        ) : null}
      </div>
    </>
  );

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
      {showNewSessionView && newSessionRepoSlug && (
        <NewSessionRepoBar
          repoSlug={newSessionRepoSlug}
          repo={repos.find((r) => r.url === newSessionRepoUrl)}
          repos={repos}
          onSelectRepo={(url) => void handleNewSessionForRepo(url)}
        />
      )}
      {!showHomeScreen &&
        !showNewSessionView &&
        wsSessionId &&
        (isSandboxSession ? (
          <SandboxBanner
            capabilities={
              sessions.find((s) => s.id === wsSessionId)?.capabilities
            }
          />
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
        ))}
      {!showHomeScreen && !showNewSessionView && wsSessionId && isMobile && (
        <div className="relative z-30 flex justify-center px-3 py-1.5 bg-(--color-bg-primary) pointer-events-none">
          <div className="pointer-events-auto max-w-full">
            <ConnectionBanner
              status={status}
              reconnectAttempt={reconnectAttempt}
              onReconnect={reconnect}
              compact
            />
          </div>
        </div>
      )}
      {showHarnessOnboarding ? (
        <HarnessOnboardingPanel agentList={agentList} />
      ) : showHomeScreen ? (
        <HomeScreen
          onAddRepo={() => useRepoStore.getState().setAddRepoDialogOpen(true)}
          githubAuthenticated={githubStatus.authenticated}
          hasRepos={repos.length > 0}
        />
      ) : (
        <div className="flex-1 min-h-0 flex flex-col relative isolate">
          {showRocket && (
            <div
              className="absolute inset-0 pointer-events-none overflow-hidden"
              style={{ clipPath: "inset(0 0 -80px 0)", zIndex: -1 }}
            >
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
            onDismissBugReport={(cardId) => send({ type: "dismiss_bug_report", cardId })}
            onResolvePermission={(requestId, behavior, remember) =>
              send({
                type: "resolve_permission",
                requestId,
                behavior,
                ...(remember ? { remember: true } : {}),
              })
            }
            onEgressDecision={(cardId, host, action) =>
              send({ type: "egress_decision", cardId, host, action })
            }
            onUndoIssueWrite={(cardId) =>
              send({ type: "undo_issue_write", cardId })
            }
            onOpenIssue={handleOpenIssue}
            onAgentInterfaceMessage={handleAgentInterfaceMessage}
            onResumeSession={(sid) => handleSessionResume(sid, navigate)}
            onReleaseConfirm={handleReleaseConfirm}
            onReleaseCancel={handleReleaseCancel}
          />
          <div className="flex flex-col gap-2">
            {isLoading && <AgentStatusBar activity={activity} />}
            {wsSessionId && <RebaseBanner sessionId={wsSessionId} />}
            <SecretBlockBanner />
            {queuedMessages.length > 0 && (
              <QueueIndicator
                queue={queuedMessages}
                onCancel={(pos) =>
                  send({ type: "cancel_queued_message", position: pos })
                }
              />
            )}
            {wsSessionId && <StaleContainerBanner sessionId={wsSessionId} />}
          </div>
        </div>
      )}
      {agentMessagingBlocked && (!showHomeScreen || showNewSessionView) && (
        <RepoTrustNotice repoUrl={currentRepoUrl} />
      )}
      {(showHarnessOnboarding || !showHomeScreen || showNewSessionView) && (
        <MessageInput
          onSend={handleSend}
          disabled={
            agentMessagingBlocked ||
            (showNewSessionView
              ? status !== "open" && !sessionId
              : status !== "open")
          }
          disabledReason={chatDisabledReason}
          isLoading={isLoading}
          onInterrupt={() => send({ type: "interrupt_agent" })}
          permissionMode={permissionMode}
          onPermissionModeChange={(m) =>
            useSettingsStore
              .getState()
              .setPermissionMode(useSessionStore.getState().sessionId, m)
          }
          pendingFiles={pendingFiles}
          onRemoveFile={(i) => useSettingsStore.getState().removePendingFile(i)}
          onAddFile={(f) => useSettingsStore.getState().addPendingFile(f)}
          fileTree={fileTree}
          skills={skills}
          sessionId={wsSessionId}
          {...(currentSession?.kind === "sandbox" ? {} : { network: composerNetwork })}
          agents={agentList}
          activeAgentId={activeAgentId}
          onAgentChange={handleAgentChange}
          onModelChange={handleModelChange}
          onReasoningChange={handleReasoningChange}
          sessionReasoning={currentSession?.reasoningEffort}
          {...(currentSession?.roleName ? { sessionRoleName: currentSession.roleName } : {})}
          onRoleChange={handleRoleChange}
          roleLocked={!!currentSession?.agentPinned}
          modelInfo={modelInfo}
          contextTokens={contextTokens}
          hasActiveSession={!showNewSessionView && !!sessionId}
          onOpenUsageDetails={handleUsageBadgeClick}
          focusKey={messageInputFocusKey}
          liveSteeringActive={liveSteeringActive}
        />
      )}
    </>
  );

  if (!bootstrapLoaded) {
    return (
      <div className="flex h-(--app-height) items-center justify-center bg-(--color-bg-primary)">
        {showBootstrapSpinner && (
          <Spinner size={ICON_SIZE.MD} className="text-(--color-text-tertiary)" />
        )}
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-(--app-height) bg-(--color-bg-primary) text-(--color-text-primary)">
        <AuthOverlayContainer
          showGitHubGate={showGitHubGate}
          onGitHubTokenSubmit={async (token: string) => {
            const result = await useSettingsStore
              .getState()
              .submitGitHubToken(token);
            if (result) {
              usePrStore.getState().setImportSearchResults(result.repos);
              return true;
            }
            return false;
          }}
          onComplete={() => {
            dismissGitHubGate();
            if (gitIdentityNeeded)
              {useGitStore.getState().setIdentityNeeded(false);}
          }}
        />
        {shortcutsOpen && (
          <KeyboardShortcutsOverlay
            onClose={() => setShortcutsOpen(false)}
            onEdit={() => {
              setShortcutsOpen(false);
              void handleSettingsOpen("keyboard");
            }}
          />
        )}
        {previewFile && previewType && (
          <FilePreviewModal
            filePath={previewFile}
            content={previewContent}
            fileType={previewType}
            line={previewLine}
            actions={previewActions}
            fileOnDisk={previewOnDisk}
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
            onChange={(content) =>
              useFileStore.getState().setEditContent(content)
            }
            onSave={async () => {
              const sid = useSessionStore.getState().sessionId;
              if (sid) await useFileStore.getState().saveEditor(sid);
            }}
            onClose={() => useFileStore.getState().closeEditor()}
          />
        )}
        {settingsOpen && (
          <Settings
            initialContent={systemPromptContent}
            onSaveInstructions={handleInstructionsSave}
            githubStatus={githubStatus}
            onGitHubTokenSubmit={async (token) => {
              const result = await useSettingsStore
                .getState()
                .submitGitHubToken(token);
              if (result)
                {usePrStore.getState().setImportSearchResults(result.repos);}
            }}
            onGitHubLogout={() =>
              useSettingsStore
                .getState()
                .gitHubLogout()
                .catch(() => {})
            }
            agentList={agentList}
            onFullReset={async () => {
              try {
                await apiPost("/api/reset", {});
              } catch (err) {
                console.error("[settings] Full reset failed:", err);
              }
            }}
            gitIdentity={gitIdentity}
            onGitIdentitySave={(name, email) =>
              useGitStore
                .getState()
                .submitGitIdentity(name, email)
                .catch(() => {})
            }
            memoryBudgetMb={memoryBudgetMb}
            onMemoryBudgetSave={async (mb) => {
              try {
                const raw = await apiPut("/api/settings", {
                  memoryBudgetMb: mb,
                });
                const res = raw as Record<string, unknown>;
                if (res.memoryBudgetMb !== undefined)
                  {useSettingsStore
                    .getState()
                    .setMemoryBudgetMb(res.memoryBudgetMb as number | null);}
              } catch (err) {
                console.error(
                  "[settings] Failed to save the memory budget:",
                  err,
                );
              }
            }}
            agentSystemInstructionsEnabled={agentSystemInstructionsEnabled}
            agentSystemInstructions={agentSystemInstructions}
            onToggleAgentSystemInstructions={async (enabled) => {
              try {
                const raw = await apiPut("/api/settings", {
                  agentSystemInstructionsEnabled: enabled,
                });
                const res = raw as Record<string, unknown>;
                if (res.agentSystemInstructionsEnabled !== undefined)
                  {useSettingsStore
                    .getState()
                    .setAgentSystemInstructionsEnabled(
                      !!res.agentSystemInstructionsEnabled,
                    );}
              } catch (err) {
                console.error(
                  "[settings] Failed to toggle agent system instructions:",
                  err,
                );
              }
            }}
            hasActiveSession={!!sessionId}
            onClose={() => {
              useUiStore.getState().setSettingsOpen(false);
              useUiStore.getState().setSettingsTab(undefined);
            }}
          />
        )}
        {projectSettingsRepoUrl && (
          <ProjectSettings
            repoUrl={projectSettingsRepoUrl}
            repoName={parseRepoLabel(projectSettingsRepoUrl)}
            initialTab={projectSettingsTab}
            onSecretsLoad={async (repoUrl) => {
              const data = await apiGet<{ keys: string[] }>(
                `/api/secrets?repoUrl=${encodeURIComponent(repoUrl)}`,
              );
              return data.keys;
            }}
            onSecretsSave={(repoUrl, payload) => {
              void (async () => {
                try {
                  await apiPut("/api/secrets", { repoUrl, ...payload });
                } catch {
                  return;
                }
                // Repos without Compose emit no secrets_status event to trigger this refresh.
                const id = useSessionStore.getState().sessionId;
                if (id) await usePluginReposStore.getState().fetchSnapshot(id);
              })();
            }}
            onClose={() => {
              useUiStore.getState().setProjectSettingsRepoUrl(null);
            }}
          />
        )}
        {showUsageModal && (
          <UsageModal
            currentSessionUsage={currentSessionUsage}
            allUsage={allUsageStats}
            sessions={sessions}
            onClose={() => useUiStore.getState().setShowUsageModal(false)}
            modelInfo={modelInfo}
            contextTokens={contextTokens}
            turnUsage={turnUsageForActiveSession}
            subscriptionLimits={subscriptionLimits}
          />
        )}
        {diffDialogOpen && turnDiff && (
          <Dialog
            open
            onOpenChange={(isOpen) => {
              if (!isOpen) useGitStore.getState().closeDiffDialog();
            }}
          >
            {/* `DiffPanel`'s header strip is 32px tall, so the close button —
                a 28px box — centres on it at (32 - 28) / 2 = 2px. At the 12px
                default it sat 10px low and hung 7px past the strip's bottom
                border, over the file header below. */}
            <DialogContent
              className="w-[90vw] h-[85vh] max-h-[85vh]! overflow-hidden! flex flex-col [--dialog-close-top:0.125rem]"
              aria-label="Diff view"
            >
              <Suspense
                fallback={
                  <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
                    Loading diff viewer...
                  </div>
                }
              >
                <DiffPanel
                  diff={turnDiff}
                  onClose={() => useGitStore.getState().closeDiffDialog()}
                  commitMessage={diffDialogTitle}
                  onSendComments={handleFileSendComments}
                />
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
          onOpenSessions={() =>
            useUiStore.getState().setMobileSidebarOpen(true)
          }
          showConnectionBanner={!showNewSessionView && !!wsSessionId}
          connectionStatus={status}
          reconnectAttempt={reconnectAttempt}
          onReconnect={reconnect}
          isMobile={isMobile}
          showHomeScreen={showHomeScreen}
          showNewSessionView={showNewSessionView}
          mobilePanel={mobilePanel}
          onMobilePanelChange={(p) => {
            useUiStore.getState().setMobilePanel(p);
            useUiStore.getState().setMobileSidebarOpen(false);
          }}
          onMobileNewSession={handleNewSessionShortcut}
          onMobileQuickSession={() =>
            useUiStore.getState().setQuickCaptureOpen(true)
          }
          onMobileVoiceSession={() =>
            useUiStore.getState().setQuickCaptureOpen(true, true)
          }
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
          activeNewSessionRepoUrl={
            showNewSessionView ? newSessionRepoUrl : undefined
          }
          sidebarCollapsed={sidebarCollapsed}
          mobileSidebarOpen={mobileSidebarOpen}
          onCloseMobileSidebar={() =>
            useUiStore.getState().setMobileSidebarOpen(false)
          }
          onResumeSession={(sid: string) => {
            const session = sessions.find((s) => s.id === sid);
            if (session?.remoteUrl)
              {useRepoStore.getState().setActiveRepoUrl(session.remoteUrl);}
            handleSessionResume(sid, navigate);
          }}
          onArchiveSession={async (sid: string) => {
            await useSessionStore.getState().archiveSession(sid);
            if (sid === useSessionStore.getState().sessionId) {
              const repoUrl =
                sessions.find((s) => s.id === sid)?.remoteUrl ?? activeRepoUrl;
              if (repoUrl)
                {void handleNewSessionForRepo(repoUrl, {
                  preserveMobileView: true,
                });}
            }
          }}
          onNewSessionForRepo={handleNewSessionForRepo}
          onToggleSidebarCollapse={() =>
            useUiStore.getState().setSidebarCollapsed(!sidebarCollapsed)
          }
          repos={repos}
          onAddRepo={() => useRepoStore.getState().setAddRepoDialogOpen(true)}
          onCreateNewRepo={() => {
            if (!githubStatus.authenticated) {
              useRepoStore.getState().setAddRepoDialogOpen(true);
              return;
            }
            useRepoStore.getState().setAddRepoDialogOpen(false);
             
            if (templates.length === 0) {
              // eslint-disable-next-line no-restricted-syntax -- fire-and-forget template refresh in click handler
              apiGet<{ templates: typeof templates }>("/api/bootstrap")
                .then((d) => useUiStore.getState().setTemplates(d.templates))
                .catch(() => {});
            }
            // eslint-disable-next-line no-restricted-syntax -- fire-and-forget one-liner
            apiGet<{ orgs: { login: string }[] }>("/api/github/orgs")
              .then((d) => setGithubOrgs(d.orgs.map((o) => o.login)))
              .catch(() => {});
            useRepoStore.getState().setNewRepoDialogOpen(true);
          }}
          toast={toast}
        />
        <AddRepoDialog
          open={addRepoDialogOpen}
          githubAuthenticated={githubStatus.authenticated}
          onGitHubTokenSubmit={async (token: string) => {
            const result = await useSettingsStore
              .getState()
              .submitGitHubToken(token);
            if (result) {
              usePrStore.getState().setImportSearchResults(result.repos);
              return true;
            }
            return false;
          }}
          onClose={() => useRepoStore.getState().setAddRepoDialogOpen(false)}
          onAdd={async (url) => {
            await useRepoStore.getState().addRepo(url);
          }}
          onRepoReady={(url) => {
            useRepoStore.getState().setActiveRepoUrl(url);
            void navigate(repoLabelToNewPath(url));
          }}
          onCreateNew={() => {
            useRepoStore.getState().setAddRepoDialogOpen(false);
             
            if (templates.length === 0) {
              // eslint-disable-next-line no-restricted-syntax -- fire-and-forget template refresh in click handler
              apiGet<{ templates: typeof templates }>("/api/bootstrap")
                .then((d) => useUiStore.getState().setTemplates(d.templates))
                .catch(() => {});
            }
            // eslint-disable-next-line no-restricted-syntax -- fire-and-forget one-liner
            apiGet<{ orgs: { login: string }[] }>("/api/github/orgs")
              .then((d) => setGithubOrgs(d.orgs.map((o) => o.login)))
              .catch(() => {});
            useRepoStore.getState().setNewRepoDialogOpen(true);
          }}
          searchResults={importSearchResults}
          onSearch={(q) =>
            usePrStore
              .getState()
              .searchRepos(q)
              .catch(() => {})
          }
          repos={repos}
        />
        <AllSessionsDialog
          open={allSessionsDialogOpen}
          onClose={() =>
            useSessionStore.getState().setAllSessionsDialogOpen(false)
          }
          sessions={allSessions}
          repos={repos}
          initialRepoUrl={allSessionsDialogRepoUrl ?? currentRepoUrl}
          onFetch={() => useSessionStore.getState().fetchAllSessions()}
          onResume={(sid) => handleSessionResume(sid, navigate)}
          onUnarchive={(sid) =>
            useSessionStore.getState().unarchiveSession(sid)
          }
          onArchive={(sid) => useSessionStore.getState().archiveSession(sid)}
        />
        {newRepoDialogOpen && (
          <NewRepoDialog
            username={githubStatus.username ?? ""}
            orgs={githubOrgs}
            templates={templates}
            creating={creatingRepo}
            onClose={() => useRepoStore.getState().setNewRepoDialogOpen(false)}
            onSubmit={async (
              name,
              description,
              isPrivate,
              templateId,
              owner,
            ) => {
              useSessionStore.getState().setCreatingRepo(true);
              try {
                const res = await apiPost<{
                  success: boolean;
                  repoUrl?: string;
                  message?: string;
                }>("/api/repos", {
                  repoName: name,
                  description,
                  isPrivate,
                  templateId,
                  owner,
                });
                if (res.success && res.repoUrl) {
                  useRepoStore.getState().setNewRepoDialogOpen(false);
                  useRepoStore.getState().setActiveRepoUrl(res.repoUrl);
                  void navigate(repoLabelToNewPath(res.repoUrl));
                } else {
                  useUiStore
                    .getState()
                    .setToast({
                      message: res.message || "Failed to create repository",
                    });
                }
              } catch {
                useUiStore
                  .getState()
                  .setToast({ message: "Failed to create repository" });
              } finally {
                useSessionStore.getState().setCreatingRepo(false);
              }
            }}
          />
        )}
        <SandboxDialog
          open={sandboxDialogOpen}
          onOpenChange={(open) =>
            useUiStore.getState().setSandboxDialogOpen(open)
          }
          creating={creatingSandbox}
          onCreate={async (capabilities) => {
            setCreatingSandbox(true);
            try {
              const newId = await useSessionStore
                .getState()
                .createSandboxSession(capabilities);
              if (newId) {
                useUiStore.getState().setSandboxDialogOpen(false);
                handleSessionResume(newId, navigate);
              } else {
                useUiStore
                  .getState()
                  .setToast({ message: "Failed to create sandbox session" });
              }
            } finally {
              setCreatingSandbox(false);
            }
          }}
        />
        {wsSessionId && (
          <SessionSettingsDialog
            key={wsSessionId}
            sessionId={wsSessionId}
            open={sessionSettingsDialogOpen}
            onOpenChange={(open) =>
              useUiStore.getState().setSessionSettingsDialogOpen(open)
            }
          />
        )}
      </div>
    </TooltipProvider>
  );
}
