import { create } from "zustand";
import type { PreviewStatus } from "../components/PreviewFrame.js";
import type { ComposeServiceStatus, ComposeServicePreviewMode } from "../../server/shared/types/ws-server-messages.js";

// ---- Compose service state ----

export interface ManagedServiceState {
  name: string;
  status: ComposeServiceStatus;
  port?: number;
  preview: ComposeServicePreviewMode;
  error?: string;
}

export interface StartupStep {
  stepId: "fetch" | "install" | "dev_server";
  status: "pending" | "running" | "complete" | "error";
  durationMs?: number;
  message?: string;
  logLines: string[];
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

/** Per-session state that gets snapshotted on session switch. */
export interface SessionPreviewSnapshot {
  status: PreviewStatus | null;
  selectedPort: number | null;
  errors: PreviewError[];
  autoFixRetries: number;
  startupSteps: StartupStep[];
  services: ManagedServiceState[];
  composeError: string | null;
  composeNotConfigured: boolean;
}

interface PreviewState {
  status: PreviewStatus | null;
  selectedPort: number | null;
  errors: PreviewError[];
  autoFixEnabled: boolean;
  autoFixRetries: number;
  startupSteps: StartupStep[];

  /** Compose services for the current session (keyed by service name). */
  services: ManagedServiceState[];
  /** Error message when Docker Compose stack fails to start. */
  composeError: string | null;
  /** True when no compose file is configured in shipit.yaml. */
  composeNotConfigured: boolean;

  /** Saved preview state per session, keyed by sessionId. */
  sessionSnapshots: Record<string, SessionPreviewSnapshot>;

  setStatus: (status: PreviewStatus | null) => void;
  setSelectedPort: (port: number | null) => void;
  addError: (error: PreviewError) => void;
  clearErrors: () => void;
  setAutoFixEnabled: (enabled: boolean) => void;
  setAutoFixRetries: (retries: number) => void;
  disableAutoFix: () => void;
  toggleAutoFix: () => void;
  initStartupSteps: () => void;
  setStartupStep: (update: Partial<StartupStep> & { stepId: string }) => void;
  clearStartupSteps: () => void;
  /** Replace the full service list (from service_list WS message). */
  setServices: (services: ManagedServiceState[]) => void;
  /** Update a single service status (from service_status WS message). */
  updateService: (update: ManagedServiceState) => void;
  setComposeError: (error: string | null) => void;
  setComposeNotConfigured: (value: boolean) => void;
  /** Save current top-level state into sessionSnapshots[sessionId]. */
  snapshotSession: (sessionId: string) => void;
  /** Restore from snapshot if exists, otherwise reset to defaults. */
  restoreSession: (sessionId: string) => void;
  /** Read-only access to a session's snapshot. */
  getSnapshot: (sessionId: string) => SessionPreviewSnapshot | undefined;
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

const initialSessionState: SessionPreviewSnapshot = {
  status: null,
  selectedPort: null,
  errors: [],
  autoFixRetries: 0,
  startupSteps: [],
  services: [],
  composeError: null,
  composeNotConfigured: false,
};

const initialState = {
  ...initialSessionState,
  autoFixEnabled: false,
  sessionSnapshots: {} as Record<string, SessionPreviewSnapshot>,
};

export const usePreviewStore = create<PreviewState>((set, get) => ({
  ...initialState,

  setStatus: (status) => set({ status }),

  setSelectedPort: (port) => set({ selectedPort: port }),

  addError: (error) =>
    set((state) => {
      const next = [...state.errors, error];
      return { errors: next.length > MAX_ERRORS ? next.slice(-MAX_ERRORS) : next };
    }),

  clearErrors: () => {
    resetDedupState();
    set({ errors: [] });
  },

  setAutoFixEnabled: (autoFixEnabled) => set({ autoFixEnabled }),

  setAutoFixRetries: (autoFixRetries) => set({ autoFixRetries }),

  disableAutoFix: () => set({ autoFixEnabled: false, autoFixRetries: 0 }),

  toggleAutoFix: () =>
    set((state) => ({ autoFixEnabled: !state.autoFixEnabled, ...(!state.autoFixEnabled ? {} : { autoFixRetries: 0 }) })),

  initStartupSteps: () =>
    set({
      startupSteps: [
        { stepId: "fetch", status: "running", logLines: [] },
        { stepId: "install", status: "pending", logLines: [] },
        { stepId: "dev_server", status: "pending", logLines: [] },
      ],
    }),

  setStartupStep: (update) =>
    set((state) => ({
      startupSteps: state.startupSteps.map((s) =>
        s.stepId === update.stepId ? { ...s, ...update, logLines: update.logLines ?? s.logLines } : s,
      ),
    })),

  clearStartupSteps: () => set({ startupSteps: [] }),

  setComposeError: (composeError) => set({ composeError }),

  setComposeNotConfigured: (composeNotConfigured) => set({ composeNotConfigured }),

  setServices: (services) => set({ services, composeError: null, composeNotConfigured: false }),

  updateService: (update) =>
    set((state) => {
      const existing = state.services.find(s => s.name === update.name);
      if (existing) {
        return {
          services: state.services.map(s =>
            s.name === update.name ? { ...s, ...update } : s,
          ),
        };
      }
      return { services: [...state.services, update] };
    }),

  snapshotSession: (sessionId) =>
    set((state) => ({
      sessionSnapshots: {
        ...state.sessionSnapshots,
        [sessionId]: {
          status: state.status,
          selectedPort: state.selectedPort,
          errors: state.errors,
          autoFixRetries: state.autoFixRetries,
          startupSteps: state.startupSteps,
          services: state.services,
          composeError: state.composeError,
          composeNotConfigured: state.composeNotConfigured,
        },
      },
    })),

  restoreSession: (sessionId) => {
    const snap = get().sessionSnapshots[sessionId];
    if (snap) {
      set({ ...snap });
    } else {
      resetDedupState();
      set({ ...initialSessionState });
    }
  },

  getSnapshot: (sessionId): SessionPreviewSnapshot | undefined => get().sessionSnapshots[sessionId],

  reset: () => {
    resetDedupState();
    set({ ...initialState, sessionSnapshots: {} });
  },
}));
