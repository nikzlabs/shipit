import { create } from "zustand";
import type { TemplateInfo } from "../utils/template-info.js";
import type { AgentOption } from "../agent-types.js";
import type { SessionUsage, UsageStats } from "../../server/shared/types.js";
import type { ModelInfo } from "../utils/model-info.js";
import type { ToastData } from "../components/Toast.js";
import type { AgentId, DockerMemoryStats, SubscriptionLimitsMap, RuntimeMode, VersionInfo } from "../../server/shared/types.js";
import {
  getSavedAgentId,
  getSavedSidebarCollapsed,
  saveSidebarCollapsed,
  getSavedSidebarView,
  saveSidebarView,
  getSavedRightTab,
  saveRightTab,
} from "../utils/local-storage.js";
import type { SidebarView } from "../utils/local-storage.js";
import { newSessionAgentId } from "../utils/new-session-agent.js";

export type RightTab =
  | "preview"
  | "docs"
  | "issues"
  | "files"
  | "plugins"
  | "terminal"
  | "history"
  | "pr"
  | "host"
  | "present";

type MobilePanel = "chat" | "preview";

type SettingsTab =

  | "services"
  // docs/261 — the two configured reviewers. Directly after Services because it

  | "roles"
  | "integrations"
  | "git"
  | "instructions"
  | "skills"
  | "keyboard"
  | "voice"
  | "network"
  | "advanced"
  | undefined;

type ProjectSettingsTab = "deployments" | "secrets";

interface UiState {

  rightTab: RightTab;
  mobilePanel: MobilePanel;
  showTemplates: boolean;
  templates: TemplateInfo[];
  agentList: AgentOption[];
  activeAgentId: AgentId;
  showUsageModal: boolean;

  currentSessionUsage: SessionUsage | null;
  allUsageStats: UsageStats | null;
  modelInfo: ModelInfo | null;

  contextTokens: number;

  cumulativeInputTokens: number;

  cumulativeOutputTokens: number;
  settingsOpen: boolean;

  sandboxDialogOpen: boolean;

  sessionSettingsDialogOpen: boolean;
  quickCaptureOpen: boolean;

  quickCaptureAutoMic: boolean;
  settingsTab: SettingsTab;

  projectSettingsRepoUrl: string | null;

  projectSettingsTab: ProjectSettingsTab;
  sidebarCollapsed: boolean;

  sidebarView: SidebarView;
  mobileSidebarOpen: boolean;
  toast: ToastData | null;
  bootstrapLoaded: boolean;
  dockerMemory: DockerMemoryStats | null;

  processStartedAt: number | null;

  version: VersionInfo | null;
  updateMode: "managed" | "manual";

  subscriptionLimits: SubscriptionLimitsMap;

  runtimeMode: RuntimeMode;

  tailnetPreviewHost: string | null;

  setRightTab: (tab: RightTab) => void;
  setMobilePanel: (panel: MobilePanel) => void;
  setShowTemplates: (show: boolean) => void;
  setTemplates: (templates: TemplateInfo[]) => void;
  setAgentList: (agents: AgentOption[]) => void;
  setActiveAgentId: (id: AgentId) => void;
  setShowUsageModal: (show: boolean) => void;
  setCurrentSessionUsage: (usage: SessionUsage | null) => void;
  setModelInfo: (info: ModelInfo | null) => void;
  setContextTokens: (tokens: number) => void;
  setCumulativeTokens: (input: number, output: number) => void;
  setSettingsOpen: (open: boolean) => void;
  setSandboxDialogOpen: (open: boolean) => void;
  setSessionSettingsDialogOpen: (open: boolean) => void;
  setQuickCaptureOpen: (open: boolean, autoMic?: boolean) => void;
  setQuickCaptureAutoMic: (active: boolean) => void;
  setSettingsTab: (tab: SettingsTab) => void;

  setProjectSettingsRepoUrl: (url: string | null, tab?: ProjectSettingsTab) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarView: (view: SidebarView) => void;

  toggleSidebarView: () => void;
  setMobileSidebarOpen: (open: boolean) => void;
  setToast: (toast: ToastData | null) => void;
  setDockerMemory: (stats: DockerMemoryStats | null) => void;
  setProcessStartedAt: (epochMs: number | null) => void;
  setVersion: (version: VersionInfo | null) => void;
  setUpdateMode: (updateMode: "managed" | "manual") => void;
  setSubscriptionLimits: (limits: SubscriptionLimitsMap) => void;
  setBootstrapLoaded: (loaded: boolean) => void;
  setRuntimeMode: (mode: RuntimeMode) => void;
  setTailnetPreviewHost: (host: string | null) => void;
  reset: () => void;

  fetchUsageStats: (sessionId: string) => Promise<void>;
}

const initialState = {
  rightTab: getSavedRightTab(),
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
  sandboxDialogOpen: false,
  sessionSettingsDialogOpen: false,
  quickCaptureOpen: false,
  quickCaptureAutoMic: false,
  settingsTab: undefined as SettingsTab,
  projectSettingsRepoUrl: null as string | null,
  projectSettingsTab: "secrets" as ProjectSettingsTab,
  sidebarCollapsed: getSavedSidebarCollapsed(),
  sidebarView: getSavedSidebarView(),
  mobileSidebarOpen: false,
  toast: null as ToastData | null,
  bootstrapLoaded: false,
  dockerMemory: null as DockerMemoryStats | null,
  processStartedAt: null as number | null,
  version: null as VersionInfo | null,
  updateMode: "manual" as "managed" | "manual",
  subscriptionLimits: {} as SubscriptionLimitsMap,
  runtimeMode: "containerized" as RuntimeMode,
  tailnetPreviewHost: null as string | null,
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

    set({ activeAgentId: id });
  },

  setShowUsageModal: (showUsageModal) => set({ showUsageModal }),

  setCurrentSessionUsage: (currentSessionUsage) =>
    set({ currentSessionUsage }),

  setModelInfo: (modelInfo) => set({ modelInfo }),

  setContextTokens: (contextTokens) => set({ contextTokens }),

  setCumulativeTokens: (cumulativeInputTokens, cumulativeOutputTokens) =>
    set({ cumulativeInputTokens, cumulativeOutputTokens }),

  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setSandboxDialogOpen: (sandboxDialogOpen) => set({ sandboxDialogOpen }),
  setSessionSettingsDialogOpen: (sessionSettingsDialogOpen) => set({ sessionSettingsDialogOpen }),

  setQuickCaptureOpen: (quickCaptureOpen, autoMic = false) =>
    set({ quickCaptureOpen, quickCaptureAutoMic: quickCaptureOpen ? autoMic : false }),

  setQuickCaptureAutoMic: (quickCaptureAutoMic) => set({ quickCaptureAutoMic }),

  setSettingsTab: (settingsTab) => set({ settingsTab }),

  setProjectSettingsRepoUrl: (projectSettingsRepoUrl, tab = "secrets") =>
    set({ projectSettingsRepoUrl, projectSettingsTab: tab }),

  setSidebarCollapsed: (collapsed) => {
    saveSidebarCollapsed(collapsed);
    set({ sidebarCollapsed: collapsed });
  },

  setSidebarView: (sidebarView) => {
    saveSidebarView(sidebarView);
    set({ sidebarView });
  },

  toggleSidebarView: () =>
    set((state) => {
      const sidebarView: SidebarView = state.sidebarView === "attention" ? "all" : "attention";
      saveSidebarView(sidebarView);
      return { sidebarView };
    }),

  setMobileSidebarOpen: (mobileSidebarOpen) => set({ mobileSidebarOpen }),

  setToast: (toast) => set({ toast }),

  setDockerMemory: (dockerMemory) => set({ dockerMemory }),

  setProcessStartedAt: (processStartedAt) => set({ processStartedAt }),
  setVersion: (version) => set({ version }),
  setUpdateMode: (updateMode) => set({ updateMode }),

  setSubscriptionLimits: (subscriptionLimits) => set({ subscriptionLimits }),

  setBootstrapLoaded: (bootstrapLoaded) => set({ bootstrapLoaded }),

  setRuntimeMode: (runtimeMode) => set({ runtimeMode }),
  setTailnetPreviewHost: (tailnetPreviewHost) => set({ tailnetPreviewHost }),

  reset: () =>
    set((s) => ({
      settingsOpen: false,
      quickCaptureOpen: false,
      quickCaptureAutoMic: false,
      projectSettingsRepoUrl: null,
      currentSessionUsage: null,
      allUsageStats: null,
      modelInfo: null,
      contextTokens: 0,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      // docs/252 — back to the seed, because this field is SYNCED TO THE

      // filters `warm = 0`), so the composer has a bound session it cannot see

      // an internal sync must never move the global "new session default".
      activeAgentId: newSessionAgentId(s.agentList),

      // a new session's first thing to look at is its conversation, never the

      // (Unlike rightTab, which is the desktop tab and is intentionally

      mobilePanel: "chat" as MobilePanel,
    })),

  fetchUsageStats: async (sessionId) => {
    const res = await fetch(`/api/sessions/${sessionId}/usage`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const data = await res.json() as { stats: UsageStats };
    set({ allUsageStats: data.stats });
  },
}));
