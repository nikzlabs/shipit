import { create } from "zustand";
import type { TemplateInfo } from "../components/TemplateSelector.js";
import type { AgentOption } from "../components/AgentPicker.js";
import type {
  SessionUsage,
  UsageStats,
} from "../components/UsageModal.js";
import type { ModelInfo } from "../components/StatusBar.js";
import type { ToastData } from "../components/Toast.js";
import type { AgentId, DockerMemoryStats } from "../../server/shared/types.js";
import {
  getSavedAgentId,
  saveAgentId,
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
  | "services";

type MobilePanel = "chat" | "preview";

type SettingsTab =
  | "agent"
  | "github"
  | "git"
  | "instructions"
  | "mcp"
  | "advanced"
  | "deployments"
  | "secrets"
  | undefined;

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
  sidebarCollapsed: boolean;
  mobileSidebarOpen: boolean;
  toast: ToastData | null;
  bootstrapLoaded: boolean;
  dockerMemory: DockerMemoryStats | null;

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
  setSidebarCollapsed: (collapsed: boolean) => void;
  setMobileSidebarOpen: (open: boolean) => void;
  setToast: (toast: ToastData | null) => void;
  setDockerMemory: (stats: DockerMemoryStats | null) => void;
  setBootstrapLoaded: (loaded: boolean) => void;
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
  sidebarCollapsed: getSavedSidebarCollapsed(),
  mobileSidebarOpen: false,
  toast: null as ToastData | null,
  bootstrapLoaded: false,
  dockerMemory: null as DockerMemoryStats | null,
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
    saveAgentId(id);
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

  setSidebarCollapsed: (collapsed) => {
    saveSidebarCollapsed(collapsed);
    set({ sidebarCollapsed: collapsed });
  },

  setMobileSidebarOpen: (mobileSidebarOpen) => set({ mobileSidebarOpen }),

  setToast: (toast) => set({ toast }),

  setDockerMemory: (dockerMemory) => set({ dockerMemory }),

  setBootstrapLoaded: (bootstrapLoaded) => set({ bootstrapLoaded }),

  reset: () =>
    set({
      settingsOpen: false,
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
