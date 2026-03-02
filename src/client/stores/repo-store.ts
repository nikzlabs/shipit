import { create } from "zustand";
import type { RepoInfo } from "../../server/shared/types.js";

interface RepoState {
  repos: RepoInfo[];
  addRepoDialogOpen: boolean;

  // Actions
  setRepos: (repos: RepoInfo[]) => void;
  setAddRepoDialogOpen: (open: boolean) => void;
  updateRepoStatus: (url: string, status: "cloning" | "ready") => void;
  updateRepoWarmSession: (url: string, sessionId: string) => void;
  reset: () => void;

  // Async actions
  addRepo: (url: string) => Promise<RepoInfo | null>;
  removeRepo: (url: string) => Promise<boolean>;
  claimSession: (url: string) => Promise<{ sessionId: string; sessionDir: string } | null>;
}

export const useRepoStore = create<RepoState>((set) => ({
  repos: [],
  addRepoDialogOpen: false,

  setRepos: (repos) => set({ repos }),

  setAddRepoDialogOpen: (open) => set({ addRepoDialogOpen: open }),

  updateRepoStatus: (url, status) =>
    set((state) => ({
      repos: state.repos.map((r) => (r.url === url ? { ...r, status } : r)),
    })),

  updateRepoWarmSession: (url, sessionId) =>
    set((state) => ({
      repos: state.repos.map((r) =>
        r.url === url ? { ...r, warmSessionId: sessionId } : r,
      ),
    })),

  reset: () => set({ repos: [], addRepoDialogOpen: false }),

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
      const data = await res.json();
      if (data.repo) {
        set((state) => {
          // Add or replace
          const existing = state.repos.findIndex((r) => r.url === data.repo.url);
          if (existing >= 0) {
            const updated = [...state.repos];
            updated[existing] = data.repo;
            return { repos: updated };
          }
          return { repos: [data.repo, ...state.repos] };
        });
        return data.repo as RepoInfo;
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

  claimSession: async (url) => {
    try {
      const res = await fetch(`/api/repos/${encodeURIComponent(url)}/claim-session`, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data as { sessionId: string; sessionDir: string };
    } catch (err) {
      console.error("[repo-store] claimSession failed:", err);
      return null;
    }
  },
}));
