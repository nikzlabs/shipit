import { create } from "zustand";
import type { RepoInfo } from "../../server/shared/types.js";
import { getSavedActiveRepo, saveActiveRepo, getSavedCollapsedRepos, saveCollapsedRepos, getSavedCollapsedParents, saveCollapsedParents, getSavedCollapsedResolved, saveCollapsedResolved, getSavedOpsCollapsed, saveOpsCollapsed, getSavedSandboxCollapsed, saveSandboxCollapsed, getSavedHiddenReposCollapsed, saveHiddenReposCollapsed } from "../utils/local-storage.js";

/** Buffers SSE status updates that arrive before addRepo stores the repo. */
const pendingStatusUpdates = new Map<string, "cloning" | "ready">();

interface RepoState {
  repos: RepoInfo[];
  activeRepoUrl: string | undefined;
  addRepoDialogOpen: boolean;
  newRepoDialogOpen: boolean;
  collapsedRepos: Set<string>;
  /**
   * Parent session IDs whose agent-spawned children are hidden in the sidebar.
   * Per-parent so a user can collapse one busy parent's brood without affecting
   * the rest. Persisted to localStorage — see [[collapse-spawned-sessions]].
   */
  collapsedParents: Set<string>;
  /**
   * docs/161 — repo URLs whose "Recently resolved" sub-section is collapsed.
   * Per-repo (like {@link collapsedRepos}) so the multi-repo user can tuck away
   * the resolved list on a noisy repo while keeping it open on the one they're
   * actively shipping. Absence = expanded (the default). Persisted to localStorage.
   */
  collapsedResolved: Set<string>;
  /** Whether the "Host / Ops" sidebar group is collapsed. Persisted to localStorage. */
  opsCollapsed: boolean;
  /** docs/211 — whether the "Sandbox" sidebar group is collapsed. Persisted to localStorage. */
  sandboxCollapsed: boolean;
  /** docs/222 — whether the "Hidden" repos sidebar section is collapsed. Persisted; defaults collapsed. */
  hiddenReposCollapsed: boolean;

  // Actions
  setRepos: (repos: RepoInfo[]) => void;
  setActiveRepoUrl: (url: string | undefined) => void;
  setAddRepoDialogOpen: (open: boolean) => void;
  setNewRepoDialogOpen: (open: boolean) => void;
  updateRepoStatus: (url: string, status: "cloning" | "ready") => void;
  updateRepoWarmSession: (url: string, sessionId: string) => void;
  toggleRepoCollapsed: (url: string) => void;
  toggleParentCollapsed: (parentId: string) => void;
  toggleResolvedCollapsed: (url: string) => void;
  toggleOpsCollapsed: () => void;
  toggleSandboxCollapsed: () => void;
  toggleHiddenReposCollapsed: () => void;
  reset: () => void;

  // Async actions
  addRepo: (url: string) => Promise<RepoInfo | null>;
  removeRepo: (url: string) => Promise<boolean>;
  /**
   * docs/222 — hide/show a repo in the sidebar. Pure visibility toggle (no
   * sessions archived, no disk reclaimed). Flips the repo's `hidden` flag
   * optimistically so the sidebar updates instantly, then PATCHes. The server
   * broadcasts `repo_list`, which re-sets the authoritative list (a no-op when
   * the optimistic update was correct). Reverts on failure.
   */
  setRepoHidden: (url: string, hidden: boolean) => Promise<boolean>;
  /**
   * Reorder repos in the sidebar. Applies the new order optimistically to
   * the local list (so the drop feels instant) and persists to the server.
   * Server then broadcasts `repo_list` over SSE — that re-sets the list
   * from the authoritative source, which is a no-op when our optimistic
   * update was correct.
   */
  reorderRepos: (urls: string[]) => Promise<boolean>;
  /**
   * docs/178 — grant trust to a remote (trust-on-first-use). Flips the repo's
   * `trusted` flag optimistically so the trust banner clears instantly, then
   * POSTs. The server broadcasts `repo_list`, which re-sets the authoritative
   * list (a no-op when the optimistic update was correct). Reverts on failure.
   */
  trustRepo: (url: string) => Promise<boolean>;
  claimSession: (url: string, signal?: AbortSignal) => Promise<{ sessionId: string; sessionDir: string } | null>;
}

export const useRepoStore = create<RepoState>((set, get) => ({
  repos: [],
  activeRepoUrl: getSavedActiveRepo(),
  addRepoDialogOpen: false,
  newRepoDialogOpen: false,
  collapsedRepos: getSavedCollapsedRepos(),
  collapsedParents: getSavedCollapsedParents(),
  collapsedResolved: getSavedCollapsedResolved(),
  opsCollapsed: getSavedOpsCollapsed(),
  sandboxCollapsed: getSavedSandboxCollapsed(),
  hiddenReposCollapsed: getSavedHiddenReposCollapsed(),

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

  toggleRepoCollapsed: (url) =>
    set((state) => {
      const next = new Set(state.collapsedRepos);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      saveCollapsedRepos(next);
      return { collapsedRepos: next };
    }),

  toggleParentCollapsed: (parentId) =>
    set((state) => {
      const next = new Set(state.collapsedParents);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      saveCollapsedParents(next);
      return { collapsedParents: next };
    }),

  toggleResolvedCollapsed: (url) =>
    set((state) => {
      const next = new Set(state.collapsedResolved);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      saveCollapsedResolved(next);
      return { collapsedResolved: next };
    }),

  toggleOpsCollapsed: () =>
    set((state) => {
      const next = !state.opsCollapsed;
      saveOpsCollapsed(next);
      return { opsCollapsed: next };
    }),

  toggleSandboxCollapsed: () =>
    set((state) => {
      const next = !state.sandboxCollapsed;
      saveSandboxCollapsed(next);
      return { sandboxCollapsed: next };
    }),

  toggleHiddenReposCollapsed: () =>
    set((state) => {
      const next = !state.hiddenReposCollapsed;
      saveHiddenReposCollapsed(next);
      return { hiddenReposCollapsed: next };
    }),

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

  reorderRepos: async (urls) => {
    const prevRepos = get().repos;
    // Optimistic update: reorder the list locally so the drop feels instant.
    // We rebuild the array by mapping urls → existing RepoInfo (skipping any
    // unknown urls), then appending any repos that weren't in the urls list
    // (defensive: a concurrent add could land an extra repo locally before
    // the drop completes).
    const byUrl = new Map(prevRepos.map((r) => [r.url, r]));
    const reordered: RepoInfo[] = [];
    const seen = new Set<string>();
    for (const u of urls) {
      const r = byUrl.get(u);
      if (r) {
        reordered.push(r);
        seen.add(u);
      }
    }
    for (const r of prevRepos) {
      if (!seen.has(r.url)) reordered.push(r);
    }
    set({ repos: reordered });

    try {
      const res = await fetch("/api/repos/order", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ urls }),
      });
      if (!res.ok) {
        // Revert optimistic update on failure
        set({ repos: prevRepos });
        return false;
      }
      return true;
    } catch (err) {
      console.error("[repo-store] reorderRepos failed:", err);
      set({ repos: prevRepos });
      return false;
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

  setRepoHidden: async (url, hidden) => {
    const apply = (h: boolean) =>
      set((state) => ({ repos: state.repos.map((r) => (r.url === url ? { ...r, hidden: h } : r)) }));
    // Optimistic — the repo leaves/returns to the sidebar immediately.
    apply(hidden);
    try {
      const res = await fetch(`/api/repos/${encodeURIComponent(url)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ hidden }),
      });
      if (!res.ok) {
        apply(!hidden);
        return false;
      }
      return true;
    } catch (err) {
      console.error("[repo-store] setRepoHidden failed:", err);
      apply(!hidden);
      return false;
    }
  },

  trustRepo: async (url) => {
    const setTrusted = (trusted: boolean) =>
      set((state) => ({ repos: state.repos.map((r) => (r.url === url ? { ...r, trusted } : r)) }));
    // Optimistic — clear the banner immediately.
    setTrusted(true);
    try {
      const res = await fetch("/api/repos/trust", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        setTrusted(false);
        return false;
      }
      return true;
    } catch (err) {
      console.error("[repo-store] trustRepo failed:", err);
      setTrusted(false);
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
