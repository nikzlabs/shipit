import { create } from "zustand";
import type { LogEntry } from "../components/TerminalPanel.js";

export type TerminalMode = "logs" | "shell";

export interface TerminalState {
  entries: LogEntry[];
  unreadCount: number;
  mode: TerminalMode;
  shellStarted: boolean;

  addEntry: (entry: LogEntry) => void;
  clearEntries: () => void;
  setMode: (mode: TerminalMode) => void;
  setShellStarted: (started: boolean) => void;
  incrementUnread: () => void;
  resetUnread: () => void;
  reset: () => void;
}

const initialState = {
  entries: [] as LogEntry[],
  unreadCount: 0,
  mode: "logs" as TerminalMode,
  shellStarted: false,
};

export const useTerminalStore = create<TerminalState>((set) => ({
  ...initialState,

  addEntry: (entry) =>
    set((state) => ({
      entries: [...state.entries, entry].slice(-500),
    })),

  clearEntries: () =>
    set({
      entries: [],
      unreadCount: 0,
    }),

  setMode: (mode) => set({ mode }),

  setShellStarted: (started) => set({ shellStarted: started }),

  incrementUnread: () =>
    set((state) => ({
      unreadCount: state.unreadCount + 1,
    })),

  resetUnread: () => set({ unreadCount: 0 }),

  reset: () => set({ ...initialState }),
}));
