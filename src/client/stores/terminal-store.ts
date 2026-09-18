import { create } from "zustand";
import type { TerminalMode } from "../components/TerminalPanel.js";

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
