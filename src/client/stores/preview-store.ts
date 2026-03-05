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

export interface PreviewError {
  id: string;
  type: "error" | "console";
  level?: "error" | "warn";
  message: string;
  source?: string;
  line?: number;
  col?: number;
  stack?: string;
  timestamp: string;
}

/** Maximum number of errors to keep in the rolling buffer. */
const MAX_ERRORS = 50;

/** Time window in ms for deduplication — same error within this window is dropped. */
const DEDUP_WINDOW_MS = 1000;

interface PreviewState {
  status: PreviewStatus | null;
  selectedPort: number | null;
  configMissing: boolean;
  installStatus: InstallStatus | null;
  crashInfo: CrashInfo | null;
  errors: PreviewError[];

  setStatus: (status: PreviewStatus | null) => void;
  setSelectedPort: (port: number | null) => void;
  setConfigMissing: (missing: boolean) => void;
  setInstallStatus: (status: InstallStatus | null) => void;
  setCrashInfo: (info: CrashInfo | null) => void;
  addError: (error: PreviewError) => void;
  clearErrors: () => void;
  reset: () => void;
}

/**
 * Dedup state lives outside Zustand to avoid triggering renders on every
 * dedup-map mutation. Only the actual errors array is reactive.
 */
let idCounter = 0;
const recentKeys = new Map<string, number>();

/** Build a dedup key from an error's core fields. */
function dedupKey(type: string, message: string, source?: string, line?: number): string {
  return `${type}:${message}:${source ?? ""}:${line ?? ""}`;
}

/**
 * Check dedup and return true if the error should be suppressed.
 * Mutates the recentKeys map as a side-effect.
 */
function isDuplicate(key: string): boolean {
  const now = Date.now();
  const lastSeen = recentKeys.get(key);
  if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) {
    return true;
  }
  recentKeys.set(key, now);
  return false;
}

export function nextErrorId(): string {
  return `pe-${++idCounter}`;
}

export function checkDuplicate(type: string, message: string, source?: string, line?: number): boolean {
  return isDuplicate(dedupKey(type, message, source, line));
}

export function resetDedupState(): void {
  recentKeys.clear();
  idCounter = 0;
}

const initialState = {
  status: null as PreviewStatus | null,
  selectedPort: null as number | null,
  configMissing: false,
  installStatus: null as InstallStatus | null,
  crashInfo: null as CrashInfo | null,
  errors: [] as PreviewError[],
};

export const usePreviewStore = create<PreviewState>((set) => ({
  ...initialState,

  setStatus: (status) => set({ status }),

  setSelectedPort: (port) => set({ selectedPort: port }),

  setConfigMissing: (missing) => set({ configMissing: missing }),

  setInstallStatus: (installStatus) => set({ installStatus }),

  setCrashInfo: (crashInfo) => set({ crashInfo }),

  addError: (error) =>
    set((state) => {
      const next = [...state.errors, error];
      return { errors: next.length > MAX_ERRORS ? next.slice(-MAX_ERRORS) : next };
    }),

  clearErrors: () => {
    resetDedupState();
    set({ errors: [] });
  },

  reset: () => {
    resetDedupState();
    set({ ...initialState });
  },
}));
