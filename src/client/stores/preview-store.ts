import { create } from "zustand";
import type { PreviewStatus } from "../components/PreviewFrame.js";

interface InstallStatus {
  status: "running" | "complete" | "error";
  message?: string;
}

interface CrashInfo {
  exitCode: number | null;
  output: string;
}

interface PreviewState {
  status: PreviewStatus | null;
  selectedPort: number | null;
  configMissing: boolean;
  installStatus: InstallStatus | null;
  crashInfo: CrashInfo | null;

  setStatus: (status: PreviewStatus | null) => void;
  setSelectedPort: (port: number | null) => void;
  setConfigMissing: (missing: boolean) => void;
  setInstallStatus: (status: InstallStatus | null) => void;
  setCrashInfo: (info: CrashInfo | null) => void;
  reset: () => void;
}

const initialState = {
  status: null as PreviewStatus | null,
  selectedPort: null as number | null,
  configMissing: false,
  installStatus: null as InstallStatus | null,
  crashInfo: null as CrashInfo | null,
};

export const usePreviewStore = create<PreviewState>((set) => ({
  ...initialState,

  setStatus: (status) => set({ status }),

  setSelectedPort: (port) => set({ selectedPort: port }),

  setConfigMissing: (missing) => set({ configMissing: missing }),

  setInstallStatus: (installStatus) => set({ installStatus }),

  setCrashInfo: (crashInfo) => set({ crashInfo }),

  reset: () => set({ ...initialState }),
}));
