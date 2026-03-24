import { create } from "zustand";
import type { LogEntry, LogSource } from "../components/TerminalPanel.js";

export type TerminalMode = "logs" | "shell";

/** Monotonically increasing ID counter for log entries. */
let nextEntryId = 1;

export interface TerminalState {
  entries: LogEntry[];
  mode: TerminalMode;
  shellStarted: boolean;
  hiddenSources: Set<LogSource>;

  addEntry: (entry: Omit<LogEntry, "id">) => void;
  clearEntries: () => void;
  setMode: (mode: TerminalMode) => void;
  setShellStarted: (started: boolean) => void;
  toggleSource: (source: LogSource) => void;
  reset: () => void;
}

const ALL_SOURCES_COUNT = 5; // stderr, stdout, server, preview, install

const initialState = {
  entries: [] as LogEntry[],
  mode: "logs" as TerminalMode,
  shellStarted: false,
  hiddenSources: new Set<LogSource>(),
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

  toggleSource: (source) =>
    set((state) => {
      const next = new Set(state.hiddenSources);
      if (next.has(source)) {
        next.delete(source);
      } else {
        // Don't allow hiding all sources
        if (next.size >= ALL_SOURCES_COUNT - 1) return state;
        next.add(source);
      }
      return { hiddenSources: next };
    }),

  reset: () => set({ ...initialState, hiddenSources: new Set() }),
}));
