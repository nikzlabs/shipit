import { create } from "zustand";
import type { PreviewStatus } from "../components/PreviewFrame.js";

interface InstallStatus {
  status: "running" | "complete" | "error";
  message?: string;
}

interface PreviewState {
  status: PreviewStatus | null;
  selectedPort: number | null;
  configMissing: boolean;
  installStatus: InstallStatus | null;

  setStatus: (status: PreviewStatus | null) => void;
  setSelectedPort: (port: number | null) => void;
  setConfigMissing: (missing: boolean) => void;
  setInstallStatus: (status: InstallStatus | null) => void;
  reset: () => void;
}

const initialState = {
  status: null as PreviewStatus | null,
  selectedPort: null as number | null,
  configMissing: false,
  installStatus: null as InstallStatus | null,
};

export const usePreviewStore = create<PreviewState>((set) => ({
  ...initialState,

  setStatus: (status) => set({ status }),

  setSelectedPort: (port) => set({ selectedPort: port }),

  setConfigMissing: (missing) => set({ configMissing: missing }),

  setInstallStatus: (installStatus) => set({ installStatus }),

  reset: () => set({ ...initialState }),
}));
