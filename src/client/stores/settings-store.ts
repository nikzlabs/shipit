import { create } from "zustand";
import type { PermissionMode, FileContextRef, ProviderAccount } from "../../server/shared/types.js";
import { getSavedNotifyOnFinish, saveNotifyOnFinish, getSavedSoundOnFinish, saveSoundOnFinish } from "../utils/local-storage.js";

/**
 * In-flight `codex login --device-auth` state. Server pushes this via SSE
 * (`codex_auth_pending`) when the CLI prints the verification URL + user
 * code; cleared on `codex_auth_complete` / `codex_auth_failed`. See
 * docs/119-codex-subscription-auth/plan.md.
 */
export interface CodexDeviceAuth {
  verificationUri: string;
  userCode: string;
  expiresInSec: number;
}

interface SettingsState {
  hasSystemPrompt: boolean;
  systemPromptContent: string;
  /**
   * Default permission mode used by the pre-session (new-session) view and
   * as a fallback for any session that hasn't made an explicit choice yet.
   * Plan mode is a per-conversation choice, so this is intentionally NOT
   * persisted to localStorage — it resets to "auto" on page reload.
   */
  permissionMode: PermissionMode;
  /**
   * Per-session permission mode overrides. Keyed by session id. A session
   * without an entry inherits `permissionMode`. This map is what prevents
   * plan-mode state from leaking between sessions.
   */
  permissionModeBySession: Record<string, PermissionMode>;
  githubStatus: { authenticated: boolean; username?: string; avatarUrl?: string };
  /**
   * GitHub API rate-limit state, pushed by the server via SSE
   * (`gh_rate_limited` / `gh_rate_limited_cleared`). `resetAt` is epoch ms;
   * `null` means the limit is active but the server didn't get a reset
   * timestamp back from GitHub. `null` whole field means "not limited."
   */
  githubRateLimit: { resetAt: number | null } | null;
  pendingFiles: FileContextRef[];
  maxIdleContainers: number;
  agentSystemInstructionsEnabled: boolean;
  agentSystemInstructions: string;
  notifyOnFinish: boolean;
  soundOnFinish: boolean;
  autoCreatePr: boolean;
  liveSteering: boolean;
  /**
   * When true, the PR conversation panel shows reply/resolve controls that
   * write through to GitHub (docs/102). Defaults off; toggled in Settings.
   */
  prCommentSync: boolean;
  /** Active Codex device-auth flow state — `null` when no flow is running. */
  codexDeviceAuth: CodexDeviceAuth | null;
  /** Last device-auth failure message — `null` when no error. */
  codexDeviceAuthError: string | null;
  providerAccounts: ProviderAccount[];

  setHasSystemPrompt: (has: boolean) => void;
  setSystemPromptContent: (content: string) => void;
  setMaxIdleContainers: (n: number) => void;
  setAgentSystemInstructionsEnabled: (enabled: boolean) => void;
  setAgentSystemInstructions: (text: string) => void;
  setNotifyOnFinish: (enabled: boolean) => void;
  setSoundOnFinish: (enabled: boolean) => void;
  setAutoCreatePr: (enabled: boolean) => void;
  setLiveSteering: (enabled: boolean) => void;
  setPrCommentSync: (enabled: boolean) => void;
  setCodexDeviceAuth: (state: CodexDeviceAuth | null) => void;
  setCodexDeviceAuthError: (message: string | null) => void;
  setProviderAccounts: (accounts: ProviderAccount[]) => void;
  /**
   * Update the permission mode. When `sessionId` is provided, the change is
   * scoped to that session only. When `sessionId` is undefined (e.g. on the
   * pre-session new-session view), the default mode is updated.
   */
  setPermissionMode: (sessionId: string | undefined, mode: PermissionMode) => void;
  /** Resolve the effective permission mode for a session (or the default). */
  getPermissionMode: (sessionId: string | undefined) => PermissionMode;
  setGithubStatus: (status: { authenticated: boolean; username?: string; avatarUrl?: string }) => void;
  setGithubRateLimit: (state: { resetAt: number | null } | null) => void;
  addPendingFile: (filePath: string) => void;
  removePendingFile: (index: number) => void;
  clearPendingFiles: () => void;
  setPendingFiles: (files: FileContextRef[]) => void;
  reset: () => void;

  saveInstructions: (content: string) => Promise<void>;
  submitGitHubToken: (token: string) => Promise<{
    repos: {
      fullName: string;
      description: string | null;
      private: boolean;
      defaultBranch: string;
      cloneUrl: string;
    }[];
  } | null>;
  gitHubLogout: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  hasSystemPrompt: false,
  systemPromptContent: "",
  permissionMode: "auto",
  permissionModeBySession: {},
  githubStatus: { authenticated: false },
  githubRateLimit: null,
  pendingFiles: [],
  maxIdleContainers: 5,
  agentSystemInstructionsEnabled: true,
  agentSystemInstructions: "",
  notifyOnFinish: getSavedNotifyOnFinish(),
  soundOnFinish: getSavedSoundOnFinish(),
  autoCreatePr: false,
  liveSteering: false,
  prCommentSync: false,
  codexDeviceAuth: null,
  codexDeviceAuthError: null,
  providerAccounts: [],

  setHasSystemPrompt: (has) => set({ hasSystemPrompt: has }),

  setSystemPromptContent: (content) => set({ systemPromptContent: content }),

  setMaxIdleContainers: (n) => set({ maxIdleContainers: n }),

  setAgentSystemInstructionsEnabled: (enabled) => set({ agentSystemInstructionsEnabled: enabled }),

  setAgentSystemInstructions: (text) => set({ agentSystemInstructions: text }),

  setNotifyOnFinish: (enabled) => {
    saveNotifyOnFinish(enabled);
    set({ notifyOnFinish: enabled });
  },

  setSoundOnFinish: (enabled) => {
    saveSoundOnFinish(enabled);
    set({ soundOnFinish: enabled });
  },

  setAutoCreatePr: (enabled) => set({ autoCreatePr: enabled }),

  setLiveSteering: (enabled) => set({ liveSteering: enabled }),

  setPrCommentSync: (enabled) => set({ prCommentSync: enabled }),

  setCodexDeviceAuth: (state) => set({ codexDeviceAuth: state }),

  setCodexDeviceAuthError: (message) => set({ codexDeviceAuthError: message }),
  setProviderAccounts: (accounts) => set({ providerAccounts: accounts }),

  setPermissionMode: (sessionId, mode) => {
    if (sessionId) {
      set((state) => ({
        permissionModeBySession: { ...state.permissionModeBySession, [sessionId]: mode },
      }));
    } else {
      set({ permissionMode: mode });
    }
  },

  getPermissionMode: (sessionId) => {
    const state = get();
    if (sessionId && sessionId in state.permissionModeBySession) {
      return state.permissionModeBySession[sessionId];
    }
    return state.permissionMode;
  },

  setGithubStatus: (status) => set({ githubStatus: status }),
  setGithubRateLimit: (state) => set({ githubRateLimit: state }),

  addPendingFile: (filePath) =>
    set((state) => {
      if (state.pendingFiles.some((f) => f.path === filePath)) {
        return state;
      }
      return { pendingFiles: [...state.pendingFiles, { path: filePath }] };
    }),

  removePendingFile: (index) =>
    set((state) => ({
      pendingFiles: state.pendingFiles.filter((_, i) => i !== index),
    })),

  clearPendingFiles: () => set({ pendingFiles: [] }),

  setPendingFiles: (files) => set({ pendingFiles: files }),

  reset: () => set({ pendingFiles: [] }),

  saveInstructions: async (content) => {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt: content }),
    });
    if (!res.ok) {
      throw new Error(`Failed to save instructions: ${res.status}`);
    }
    const result = await res.json() as { systemPrompt: string };
    set({
      systemPromptContent: result.systemPrompt,
      hasSystemPrompt: !!result.systemPrompt,
    });
  },

  submitGitHubToken: async (token) => {
    const res = await fetch("/api/github/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      return null;
    }
    const result = await res.json() as { status: { authenticated: boolean; username?: string; avatarUrl?: string }; repos: { fullName: string; description: string | null; private: boolean; defaultBranch: string; cloneUrl: string }[] };
    set({ githubStatus: result.status });
    return result;
  },

  gitHubLogout: async () => {
    const res = await fetch("/api/github/logout", {
      method: "POST",
    });
    if (!res.ok) {
      throw new Error(`Failed to logout from GitHub: ${res.status}`);
    }
    const result = await res.json() as { status: { authenticated: boolean; username?: string; avatarUrl?: string } };
    set({ githubStatus: result.status });
  },
}));
