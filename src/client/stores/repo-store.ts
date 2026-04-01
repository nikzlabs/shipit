import { create } from "zustand";
import type { RepoInfo } from "../../server/shared/types.js";
import { getSavedActiveRepo, saveActiveRepo } from "../utils/local-storage.js";

/** Buffers SSE status updates that arrive before addRepo stores the repo. */
const pendingStatusUpdates = new Map<string, "cloning" | "ready">();

interface RepoState {
  repos: RepoInfo[];
  activeRepoUrl: string | undefined;
  addRepoDialogOpen: boolean;
  newRepoDialogOpen: boolean;

  // Actions
  setRepos: (repos: RepoInfo[]) => void;
  setActiveRepoUrl: (url: string | undefined) => void;
  setAddRepoDialogOpen: (open: boolean) => void;
  setNewRepoDialogOpen: (open: boolean) => void;
  updateRepoStatus: (url: string, status: "cloning" | "ready") => void;
  updateRepoWarmSession: (url: string, sessionId: string) => void;
  reset: () => void;

  // Async actions
  addRepo: (url: string) => Promise<RepoInfo | null>;
  removeRepo: (url: string) => Promise<boolean>;
  claimSession: (url: string, signal?: AbortSignal) => Promise<{ sessionId: string; sessionDir: string } | null>;
}

export const useRepoStore = create<RepoState>((set, get) => ({
  repos: [],
  activeRepoUrl: getSavedActiveRepo(),
  addRepoDialogOpen: false,
  newRepoDialogOpen: false,

  setRepos: (repos) => {
    const { activeRepoUrl } = get();
    const urls = new Set(repos.map((r) => r.url));
    // If active repo was removed, fall back to first repo
    const nextActive = activeRepoUrl && urls.has(activeRepoUrl)
      ? activeRepoUrl
      : repos[0]?.url;
    if (nextActive !== activeRepoUrl) saveActiveRepo(nextActive);
    set({ repos, activeRepoUrl: nextActive });
  },

  setActiveRepoUrl: (url) => {
    saveActiveRepo(url);
    set({ activeRepoUrl: url });
  },

  setAddRepoDialogOpen: (open) => set({ addRepoDialogOpen: open }),

  setNewRepoDialogOpen: (open) => set({ newRepoDialogOpen: open }),

  updateRepoStatus: (url, status) =>
    set((state) => {
      const found = state.repos.some((r) => r.url === url);
      if (!found) {
        // Repo not in store yet (addRepo POST still in-flight) — buffer for later
        pendingStatusUpdates.set(url, status);
        return state;
      }
      pendingStatusUpdates.delete(url);
      return { repos: state.repos.map((r) => (r.url === url ? { ...r, status } : r)) };
    }),

  updateRepoWarmSession: (url, sessionId) =>
    set((state) => ({
      repos: state.repos.map((r) =>
        r.url === url ? { ...r, warmSessionId: sessionId } : r,
      ),
    })),

  reset: () => set({ repos: [], activeRepoUrl: undefined, addRepoDialogOpen: false, newRepoDialogOpen: false }),

  addRepo: async (url) => {
    try {
      const res = await fetch("/api/repos", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) return null;
      const data = await res.json() as { repo?: RepoInfo };
      if (data.repo) {
        const repo = data.repo;
        // Apply any SSE status update that arrived before this response
        const buffered = pendingStatusUpdates.get(repo.url);
        if (buffered) {
          repo.status = buffered;
          pendingStatusUpdates.delete(repo.url);
        }
        set((state) => {
          const existing = state.repos.findIndex((r) => r.url === repo.url);
          if (existing >= 0) {
            // Don't downgrade status from "ready" to "cloning"
            const merged = state.repos[existing].status === "ready" && repo.status === "cloning"
              ? { ...repo, status: "ready" as const }
              : repo;
            const updated = [...state.repos];
            updated[existing] = merged;
            return { repos: updated };
          }
          return { repos: [repo, ...state.repos] };
        });
        return data.repo;
      }
      return null;
    } catch (err) {
      console.error("[repo-store] addRepo failed:", err);
      return null;
    }
  },

  removeRepo: async (url) => {
    try {
      const res = await fetch(`/api/repos/${encodeURIComponent(url)}`, {
        method: "DELETE",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return false;
      set((state) => ({
        repos: state.repos.filter((r) => r.url !== url),
      }));
      return true;
    } catch (err) {
      console.error("[repo-store] removeRepo failed:", err);
      return false;
    }
  },

  claimSession: async (url, signal) => {
    const { usePreviewStore } = await import("./preview-store.js");
    try {
      // Show startup steps immediately — fetch is "running" while the HTTP call is in flight
      usePreviewStore.getState().initStartupSteps();
      const res = await fetch(`/api/repos/${encodeURIComponent(url)}/claim-session`, {
        method: "POST",
        headers: { Accept: "application/json" },
        signal,
      });
      if (!res.ok) {
        usePreviewStore.getState().clearStartupSteps();
        return null;
      }
      const data = await res.json() as { sessionId: string; sessionDir: string; fetchDurationMs?: number };
      // Mark fetch step complete with server-reported duration
      usePreviewStore.getState().setStartupStep({
        stepId: "fetch",
        status: "complete",
        durationMs: data.fetchDurationMs ?? 0,
      });
      return data;
    } catch (err) {
      usePreviewStore.getState().clearStartupSteps();
      if (err instanceof DOMException && err.name === "AbortError") return null;
      console.error("[repo-store] claimSession failed:", err);
      return null;
    }
  },
}));
