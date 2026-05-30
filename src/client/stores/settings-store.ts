import { create } from "zustand";
import type { PermissionMode, FileContextRef, ProviderAccount } from "../../server/shared/types.js";
import {
  getSavedNotifyOnFinish, saveNotifyOnFinish,
  getSavedSoundOnFinish, saveSoundOnFinish,
  getSavedQuickCaptureHotkey, saveQuickCaptureHotkey,
  getSavedVoiceInputEnabled, saveVoiceInputEnabled,
  getSavedSttProvider, saveSttProvider,
  getSavedCleanupEnabled, saveCleanupEnabled,
  getSavedVoiceHotkeyModeA, saveVoiceHotkeyModeA,
  getSavedVoiceHotkeyModeB, saveVoiceHotkeyModeB,
  getSavedVoiceLanguage, saveVoiceLanguage,
  getSavedVoicePlaybackEnabled, saveVoicePlaybackEnabled,
  getSavedTtsProvider, saveTtsProvider,
  getSavedTtsVoice, saveTtsVoice,
  getSavedTtsSpeed, saveTtsSpeed,
} from "../utils/local-storage.js";

/**
 * In-flight `codex login --device-auth` state. Server pushes this via SSE
 * as an `agent_auth_pending` event with `agentId: "codex"` +
 * `details.kind: "device-code"` when the CLI prints the verification URL +
 * user code; cleared on `agent_auth_complete` / `agent_auth_failed` for the
 * same `agentId`. See docs/119-codex-subscription-auth/plan.md and
 * docs/155 Phase 2b for the unified event family.
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
  quickCaptureHotkey: string;
  /** docs/144 — voice dictation + playback settings (non-credential; the API key is server-side only). */
  voiceInputEnabled: boolean;
  sttProvider: string;
  cleanupEnabled: boolean;
  voiceHotkeyModeA: string;
  voiceHotkeyModeB: string;
  voiceLanguage: string;
  voicePlaybackEnabled: boolean;
  ttsProvider: string;
  ttsVoice: string;
  ttsSpeed: number;
  autoCreatePr: boolean;
  liveSteering: boolean;
  /** docs/146 — global gate for the auto-resolve-conflicts loop. */
  autoResolveConflicts: boolean;
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
  setQuickCaptureHotkey: (hotkey: string) => void;
  setVoiceInputEnabled: (enabled: boolean) => void;
  setSttProvider: (provider: string) => void;
  setCleanupEnabled: (enabled: boolean) => void;
  setVoiceHotkeyModeA: (hotkey: string) => void;
  setVoiceHotkeyModeB: (hotkey: string) => void;
  setVoiceLanguage: (language: string) => void;
  setVoicePlaybackEnabled: (enabled: boolean) => void;
  setTtsProvider: (provider: string) => void;
  setTtsVoice: (voice: string) => void;
  setTtsSpeed: (speed: number) => void;
  setAutoCreatePr: (enabled: boolean) => void;
  setLiveSteering: (enabled: boolean) => void;
  setAutoResolveConflicts: (enabled: boolean) => void;
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
  quickCaptureHotkey: getSavedQuickCaptureHotkey(),
  voiceInputEnabled: getSavedVoiceInputEnabled(),
  sttProvider: getSavedSttProvider(),
  cleanupEnabled: getSavedCleanupEnabled(),
  voiceHotkeyModeA: getSavedVoiceHotkeyModeA(),
  voiceHotkeyModeB: getSavedVoiceHotkeyModeB(),
  voiceLanguage: getSavedVoiceLanguage(),
  voicePlaybackEnabled: getSavedVoicePlaybackEnabled(),
  ttsProvider: getSavedTtsProvider(),
  ttsVoice: getSavedTtsVoice(),
  ttsSpeed: getSavedTtsSpeed(),
  autoCreatePr: false,
  liveSteering: false,
  autoResolveConflicts: false,
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

  setQuickCaptureHotkey: (hotkey) => {
    saveQuickCaptureHotkey(hotkey);
    set({ quickCaptureHotkey: hotkey });
  },

  setVoiceInputEnabled: (enabled) => {
    saveVoiceInputEnabled(enabled);
    set({ voiceInputEnabled: enabled });
  },

  setSttProvider: (provider) => {
    saveSttProvider(provider);
    set({ sttProvider: provider });
  },

  setCleanupEnabled: (enabled) => {
    saveCleanupEnabled(enabled);
    set({ cleanupEnabled: enabled });
  },

  setVoiceHotkeyModeA: (hotkey) => {
    saveVoiceHotkeyModeA(hotkey);
    set({ voiceHotkeyModeA: hotkey });
  },

  setVoiceHotkeyModeB: (hotkey) => {
    saveVoiceHotkeyModeB(hotkey);
    set({ voiceHotkeyModeB: hotkey });
  },

  setVoiceLanguage: (language) => {
    saveVoiceLanguage(language);
    set({ voiceLanguage: language });
  },

  setVoicePlaybackEnabled: (enabled) => {
    saveVoicePlaybackEnabled(enabled);
    set({ voicePlaybackEnabled: enabled });
  },

  setTtsProvider: (provider) => {
    saveTtsProvider(provider);
    set({ ttsProvider: provider });
  },

  setTtsVoice: (voice) => {
    saveTtsVoice(voice);
    set({ ttsVoice: voice });
  },

  setTtsSpeed: (speed) => {
    saveTtsSpeed(speed);
    set({ ttsSpeed: speed });
  },

  setAutoCreatePr: (enabled) => set({ autoCreatePr: enabled }),

  setLiveSteering: (enabled) => set({ liveSteering: enabled }),

  setAutoResolveConflicts: (enabled) => set({ autoResolveConflicts: enabled }),

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
