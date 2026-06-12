import { create } from "zustand";
import type { TerminalMode } from "../components/TerminalPanel.js";

/**
 * Bottom-panel UI state: which sub-tab (Logs / Shell) is active and whether
 * the interactive shell has been started. The log *content* now lives in
 * `log-store` (docs/192) and renders through `<LogView>`; this store no longer
 * holds log entries or source filters.
 */
export interface TerminalState {
  mode: TerminalMode;
  shellStarted: boolean;

  setMode: (mode: TerminalMode) => void;
  setShellStarted: (started: boolean) => void;
  reset: () => void;
}

const initialState = {
  mode: "logs" as TerminalMode,
  shellStarted: false,
};

export const useTerminalStore = create<TerminalState>((set) => ({
  ...initialState,

  setMode: (mode) => set({ mode }),
  setShellStarted: (started) => set({ shellStarted: started }),
  reset: () => set({ ...initialState }),
}));
