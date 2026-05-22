import { create } from "zustand";
import type { TemplateInfo } from "../utils/template-info.js";
import type { AgentOption } from "../agent-types.js";
import type {
  SessionUsage,
  UsageStats,
} from "../components/UsageModal.js";
import type { ModelInfo } from "../utils/model-info.js";
import type { ToastData } from "../components/Toast.js";
import type { AgentId, DockerMemoryStats, SubscriptionLimitsMap, RuntimeMode } from "../../server/shared/types.js";
import {
  getSavedAgentId,
  getSavedSidebarCollapsed,
  saveSidebarCollapsed,
  getSavedRightTab,
  saveRightTab,
} from "../utils/local-storage.js";

type RightTab =
  | "preview"
  | "docs"
  | "files"
  | "terminal"
  | "history"
  | "services"
  | "pr";

type MobilePanel = "chat" | "preview";

type SettingsTab =
  | "agent-claude"
  | "agent-codex"
  | "github"
  | "git"
  | "instructions"
  | "mcp"
  | "advanced"
  | undefined;

type ProjectSettingsTab = "deployments" | "secrets";

interface UiState {
  // State
  rightTab: RightTab;
  mobilePanel: MobilePanel;
  showTemplates: boolean;
  templates: TemplateInfo[];
  agentList: AgentOption[];
  activeAgentId: AgentId;
  showUsageModal: boolean;
  /**
   * Authoritative session-cumulative usage for the active session: cost,
   * duration, turn count. Mirrors `UsageManager.getSessionUsage()` on the
   * server. Driven by `usage_update` (live) and seeded from the `/history`
   * HTTP response on session attach.
   */
  currentSessionUsage: SessionUsage | null;
  allUsageStats: UsageStats | null;
  modelInfo: ModelInfo | null;
  /**
   * Last-turn input tokens (= the current context size in the model's
   * prompt window). Updated on each `turn_usage_update` and seeded from
   * `/history`'s last `turnUsage` entry on session reload.
   */
  contextTokens: number;
  /**
   * Cumulative input tokens across every turn in the session. Used for the
   * popover's "Input tokens" total — distinct from `contextTokens` which is
   * the most recent turn's input only.
   */
  cumulativeInputTokens: number;
  /** Cumulative output tokens across every turn in the session. */
  cumulativeOutputTokens: number;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  /**
   * URL of the repo whose Project Settings dialog is open, or `null` when
   * closed. Project settings (deployments, secrets) are per-repo and live in
   * their own dialog, invoked from the per-repo menu in the sidebar — not the
   * workspace-wide Settings dialog.
   */
  projectSettingsRepoUrl: string | null;
  /** Which tab the Project Settings dialog opens on. */
  projectSettingsTab: ProjectSettingsTab;
  sidebarCollapsed: boolean;
  mobileSidebarOpen: boolean;
  toast: ToastData | null;
  bootstrapLoaded: boolean;
  dockerMemory: DockerMemoryStats | null;
  /**
   * Epoch milliseconds when the orchestrator process started. Set from
   * the `system_info` SSE event on connect. The UptimeBadge ticks live
   * from this value so the user can confirm a restart actually bounced
   * the orchestrator. `null` until the SSE handshake completes.
   */
  processStartedAt: number | null;
  /**
   * Account-wide subscription rate-limit snapshots, keyed by agent id.
   * Driven by the `subscription_limits` SSE broadcast; the server
   * replaces the map wholesale on every tick so sign-outs / unfetchable
   * providers propagate naturally (missing key → no pill).
   * See docs/135-subscription-limits-badge/plan.md.
   */
  subscriptionLimits: SubscriptionLimitsMap;
  /**
   * Orchestrator runtime mode (feature 118), seeded from the `/api/bootstrap`
   * response. `"local"` means the orchestrator runs in-process with no Docker
   * layer — the dogfooding ShipIt-in-ShipIt path. The UI uses this to show a
   * local-mode banner and hide container-only affordances (preview, terminal).
   * Defaults to `"containerized"` for every production deploy.
   */
  runtimeMode: RuntimeMode;

  // Actions
  setRightTab: (tab: RightTab) => void;
  setMobilePanel: (panel: MobilePanel) => void;
  setShowTemplates: (show: boolean) => void;
  setTemplates: (templates: TemplateInfo[]) => void;
  setAgentList: (agents: AgentOption[]) => void;
  setActiveAgentId: (id: AgentId) => void;
  setShowUsageModal: (show: boolean) => void;
  setCurrentSessionUsage: (usage: SessionUsage | null) => void;
  setAllUsageStats: (stats: UsageStats | null) => void;
  setModelInfo: (info: ModelInfo | null) => void;
  setContextTokens: (tokens: number) => void;
  setCumulativeTokens: (input: number, output: number) => void;
  setSettingsOpen: (open: boolean) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  /**
   * Open (or close, with `null`) the per-repo Project Settings dialog. Pass a
   * tab to deep-link; defaults to `"secrets"` — the actionable tab, since
   * Deployments is just setup instructions.
   */
  setProjectSettingsRepoUrl: (url: string | null, tab?: ProjectSettingsTab) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setMobileSidebarOpen: (open: boolean) => void;
  setToast: (toast: ToastData | null) => void;
  setDockerMemory: (stats: DockerMemoryStats | null) => void;
  setProcessStartedAt: (epochMs: number | null) => void;
  setSubscriptionLimits: (limits: SubscriptionLimitsMap) => void;
  setBootstrapLoaded: (loaded: boolean) => void;
  setRuntimeMode: (mode: RuntimeMode) => void;
  reset: () => void;

  // Async actions
  fetchUsageStats: (sessionId: string) => Promise<void>;
}

const initialState = {
  rightTab: getSavedRightTab() as RightTab,
  mobilePanel: "chat" as MobilePanel,
  showTemplates: false,
  templates: [] as TemplateInfo[],
  agentList: [] as AgentOption[],
  activeAgentId: getSavedAgentId(),
  showUsageModal: false,
  currentSessionUsage: null as SessionUsage | null,
  allUsageStats: null as UsageStats | null,
  modelInfo: null as ModelInfo | null,
  contextTokens: 0,
  cumulativeInputTokens: 0,
  cumulativeOutputTokens: 0,
  settingsOpen: false,
  settingsTab: undefined as SettingsTab,
  projectSettingsRepoUrl: null as string | null,
  projectSettingsTab: "secrets" as ProjectSettingsTab,
  sidebarCollapsed: getSavedSidebarCollapsed(),
  mobileSidebarOpen: false,
  toast: null as ToastData | null,
  bootstrapLoaded: false,
  dockerMemory: null as DockerMemoryStats | null,
  processStartedAt: null as number | null,
  subscriptionLimits: {} as SubscriptionLimitsMap,
  runtimeMode: "containerized" as RuntimeMode,
};

export const useUiStore = create<UiState>((set) => ({
  ...initialState,

  setRightTab: (rightTab) => {
    saveRightTab(rightTab);
    set({ rightTab });
  },

  setMobilePanel: (mobilePanel) => set({ mobilePanel }),

  setShowTemplates: (showTemplates) => set({ showTemplates }),

  setTemplates: (templates) => set({ templates }),

  setAgentList: (agentList) => set({ agentList }),

  setActiveAgentId: (id) => {
    // localStorage write happens at the UI call site (App.tsx
    // `handleAgentChange`) so internal syncs — e.g. mirroring a session's
    // persisted agent into the UI on load — don't propagate that session's
    // pick into the global "new session default" key.
    set({ activeAgentId: id });
  },

  setShowUsageModal: (showUsageModal) => set({ showUsageModal }),

  setCurrentSessionUsage: (currentSessionUsage) =>
    set({ currentSessionUsage }),

  setAllUsageStats: (allUsageStats) => set({ allUsageStats }),

  setModelInfo: (modelInfo) => set({ modelInfo }),

  setContextTokens: (contextTokens) => set({ contextTokens }),

  setCumulativeTokens: (cumulativeInputTokens, cumulativeOutputTokens) =>
    set({ cumulativeInputTokens, cumulativeOutputTokens }),

  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  setSettingsTab: (settingsTab) => set({ settingsTab }),

  setProjectSettingsRepoUrl: (projectSettingsRepoUrl, tab = "secrets") =>
    set({ projectSettingsRepoUrl, projectSettingsTab: tab }),

  setSidebarCollapsed: (collapsed) => {
    saveSidebarCollapsed(collapsed);
    set({ sidebarCollapsed: collapsed });
  },

  setMobileSidebarOpen: (mobileSidebarOpen) => set({ mobileSidebarOpen }),

  setToast: (toast) => set({ toast }),

  setDockerMemory: (dockerMemory) => set({ dockerMemory }),

  setProcessStartedAt: (processStartedAt) => set({ processStartedAt }),

  setSubscriptionLimits: (subscriptionLimits) => set({ subscriptionLimits }),

  setBootstrapLoaded: (bootstrapLoaded) => set({ bootstrapLoaded }),

  setRuntimeMode: (runtimeMode) => set({ runtimeMode }),

  reset: () =>
    set({
      settingsOpen: false,
      projectSettingsRepoUrl: null,
      currentSessionUsage: null,
      allUsageStats: null,
      modelInfo: null,
      contextTokens: 0,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      // rightTab intentionally preserved across session switches (persisted to localStorage)
    }),

  fetchUsageStats: async (sessionId) => {
    const res = await fetch(`/api/sessions/${sessionId}/usage`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const data = await res.json() as { stats: UsageStats };
    set({ allUsageStats: data.stats });
  },
}));
