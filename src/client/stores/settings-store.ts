import { create } from "zustand";
import type { PermissionMode, FileContextRef } from "../../server/shared/types.js";
import { getSavedPermissionMode, savePermissionMode, getSavedNotifyOnFinish, saveNotifyOnFinish, getSavedSoundOnFinish, saveSoundOnFinish } from "../utils/local-storage.js";

interface SettingsState {
  hasSystemPrompt: boolean;
  systemPromptContent: string;
  permissionMode: PermissionMode;
  githubStatus: { authenticated: boolean; username?: string; avatarUrl?: string };
  pendingFiles: FileContextRef[];
  maxIdleContainers: number;
  agentSystemInstructionsEnabled: boolean;
  agentSystemInstructions: string;
  notifyOnFinish: boolean;
  soundOnFinish: boolean;

  setHasSystemPrompt: (has: boolean) => void;
  setSystemPromptContent: (content: string) => void;
  setMaxIdleContainers: (n: number) => void;
  setAgentSystemInstructionsEnabled: (enabled: boolean) => void;
  setAgentSystemInstructions: (text: string) => void;
  setNotifyOnFinish: (enabled: boolean) => void;
  setSoundOnFinish: (enabled: boolean) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  setGithubStatus: (status: { authenticated: boolean; username?: string; avatarUrl?: string }) => void;
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

export const useSettingsStore = create<SettingsState>((set) => ({
  hasSystemPrompt: false,
  systemPromptContent: "",
  permissionMode: getSavedPermissionMode(),
  githubStatus: { authenticated: false },
  pendingFiles: [],
  maxIdleContainers: 5,
  agentSystemInstructionsEnabled: true,
  agentSystemInstructions: "",
  notifyOnFinish: getSavedNotifyOnFinish(),
  soundOnFinish: getSavedSoundOnFinish(),

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

  setPermissionMode: (mode) => {
    savePermissionMode(mode);
    set({ permissionMode: mode });
  },

  setGithubStatus: (status) => set({ githubStatus: status }),

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
