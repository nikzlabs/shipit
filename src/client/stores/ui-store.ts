import { create } from "zustand";
import type { TemplateInfo } from "../components/TemplateSelector.js";
import type { AgentOption } from "../components/AgentPicker.js";
import type {
  SessionUsage,
  UsageStats,
  TurnTokenData,
} from "../components/UsageModal.js";
import type { ModelInfo } from "../components/StatusBar.js";
import type { ToastData } from "../components/Toast.js";
import type { AgentId, DockerMemoryStats } from "../../server/shared/types.js";
import {
  getSavedAgentId,
  saveAgentId,
  getSavedSidebarCollapsed,
  saveSidebarCollapsed,
} from "../utils/local-storage.js";

type RightTab =
  | "preview"
  | "docs"
  | "files"
  | "terminal"
  | "history";

type MobilePanel = "chat" | "preview";

type SettingsTab =
  | "agent"
  | "github"
  | "git"
  | "instructions"
  | "advanced"
  | "deploy"
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
  currentSessionUsage: SessionUsage | null;
  allUsageStats: UsageStats | null;
  modelInfo: ModelInfo | null;
  contextTokens: number;
  turnTokens: TurnTokenData[];
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  sidebarCollapsed: boolean;
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
  setTurnTokens: (
    tokens: TurnTokenData[] | ((prev: TurnTokenData[]) => TurnTokenData[]),
  ) => void;
  appendTurnToken: (token: TurnTokenData) => void;
  setSettingsOpen: (open: boolean) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setToast: (toast: ToastData | null) => void;
  setDockerMemory: (stats: DockerMemoryStats | null) => void;
  setBootstrapLoaded: (loaded: boolean) => void;
  reset: () => void;

  // Async actions
  fetchUsageStats: (sessionId: string) => Promise<void>;
}

const initialState = {
  rightTab: "preview" as RightTab,
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
  turnTokens: [] as TurnTokenData[],
  settingsOpen: false,
  settingsTab: undefined as SettingsTab,
  sidebarCollapsed: getSavedSidebarCollapsed(),
  toast: null as ToastData | null,
  bootstrapLoaded: false,
  dockerMemory: null as DockerMemoryStats | null,
};

export const useUiStore = create<UiState>((set, get) => ({
  ...initialState,

  setRightTab: (rightTab) => set({ rightTab }),

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

  setTurnTokens: (tokens) => {
    if (typeof tokens === "function") {
      set({ turnTokens: tokens(get().turnTokens) });
    } else {
      set({ turnTokens: tokens });
    }
  },

  appendTurnToken: (token) =>
    set((state) => ({ turnTokens: [...state.turnTokens, token] })),

  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  setSettingsTab: (settingsTab) => set({ settingsTab }),

  setSidebarCollapsed: (collapsed) => {
    saveSidebarCollapsed(collapsed);
    set({ sidebarCollapsed: collapsed });
  },

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
      turnTokens: [],
      rightTab: "preview",
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
