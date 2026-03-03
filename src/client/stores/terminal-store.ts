import { create } from "zustand";
import type { LogEntry } from "../components/TerminalPanel.js";

export type TerminalMode = "logs" | "shell";

/** Monotonically increasing ID counter for log entries. */
let nextEntryId = 1;

export interface TerminalState {
  entries: LogEntry[];
  mode: TerminalMode;
  shellStarted: boolean;

  addEntry: (entry: Omit<LogEntry, "id">) => void;
  clearEntries: () => void;
  setMode: (mode: TerminalMode) => void;
  setShellStarted: (started: boolean) => void;
  reset: () => void;
}

const initialState = {
  entries: [] as LogEntry[],
  mode: "logs" as TerminalMode,
  shellStarted: false,
};

export const useTerminalStore = create<TerminalState>((set) => ({
  ...initialState,

  addEntry: (entry) =>
    set((state) => ({
      entries: [...state.entries, { ...entry, id: nextEntryId++ }].slice(-500),
    })),

  clearEntries: () =>
    set({
      entries: [],
    }),

  setMode: (mode) => set({ mode }),

  setShellStarted: (started) => set({ shellStarted: started }),

  reset: () => set({ ...initialState }),
}));
