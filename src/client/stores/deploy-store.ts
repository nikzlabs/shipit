import { create } from "zustand";
import type { DeployTargetInfo, DeploymentRecord } from "../../server/shared/types.js";
import type { DeployPhase } from "../components/DeployModal.js";

interface DeployState {
  showModal: boolean;
  targets: DeployTargetInfo[];
  configStatus: Record<string, { configured: boolean; projectName?: string }>;
  status: DeployPhase | null;
  lastUrl: string | null;
  lastError: string | null;
  history: DeploymentRecord[];

  openModal: () => void;
  closeModal: () => void;
  setStatus: (status: DeployPhase | null) => void;
  setTargets: (targets: DeployTargetInfo[]) => void;
  setConfigStatus: (
    configStatus: Record<string, { configured: boolean; projectName?: string }>,
  ) => void;
  setLastUrl: (url: string | null) => void;
  setLastError: (error: string | null) => void;
  setHistory: (history: DeploymentRecord[]) => void;
  reset: () => void;

  fetchSetup: (sessionId: string) => Promise<void>;
  configure: (
    sessionId: string,
    targetId: string,
    credentials: Record<string, string>,
    projectName?: string,
  ) => Promise<void>;
  deleteConfig: (sessionId: string, targetId: string) => Promise<void>;
  fetchHistory: (sessionId: string) => Promise<void>;
}

const initialState = {
  showModal: false,
  targets: [] as DeployTargetInfo[],
  configStatus: {} as Record<
    string,
    { configured: boolean; projectName?: string }
  >,
  status: null as DeployPhase | null,
  lastUrl: null as string | null,
  lastError: null as string | null,
  history: [] as DeploymentRecord[],
};

export const useDeployStore = create<DeployState>((set, get) => ({
  ...initialState,

  openModal: () => set({ showModal: true, status: null, lastUrl: null, lastError: null }),

  closeModal: () => set({ showModal: false }),

  setStatus: (status) => set({ status }),

  setTargets: (targets) => set({ targets }),

  setConfigStatus: (configStatus) => set({ configStatus }),

  setLastUrl: (url) => set({ lastUrl: url }),

  setLastError: (error) => set({ lastError: error }),

  setHistory: (history) => set({ history }),

  reset: () => set({ ...initialState }),

  fetchSetup: async (sessionId) => {
    const res = await fetch(`/api/sessions/${sessionId}/deploy/setup`);
    if (!res.ok) {
      throw new Error(`Failed to fetch deploy setup: ${res.status}`);
    }
    const data = await res.json() as { targets: DeployTargetInfo[]; projectSettings: Record<string, { configured: boolean; projectName?: string }> };
    set({
      targets: data.targets,
      configStatus: data.projectSettings,
    });
  },

  configure: async (sessionId, targetId, credentials, projectName) => {
    const res = await fetch(`/api/sessions/${sessionId}/deploy/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId, credentials, projectName }),
    });
    if (!res.ok) {
      throw new Error(`Failed to save deploy config: ${res.status}`);
    }
    await get().fetchSetup(sessionId);
  },

  deleteConfig: async (sessionId, targetId) => {
    const res = await fetch(
      `/api/sessions/${sessionId}/deploy/config/${targetId}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      throw new Error(`Failed to delete deploy config: ${res.status}`);
    }
    await get().fetchSetup(sessionId);
  },

  fetchHistory: async (sessionId) => {
    const res = await fetch(`/api/sessions/${sessionId}/deploy/history`);
    if (!res.ok) {
      throw new Error(`Failed to fetch deploy history: ${res.status}`);
    }
    const data = await res.json() as { deployments: DeploymentRecord[] };
    set({ history: data.deployments });
  },
}));
