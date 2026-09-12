import { create } from "zustand";
import type { GitCommit } from "../components/GitHistory.js";
import type { TurnDiffData } from "../components/DiffPanel.js";

export type RebaseStatus = "idle" | "in_progress" | "conflicts" | "resolving";

interface RebaseConflict {
  path: string;
}

interface GitState {
  commits: GitCommit[];
  identityNeeded: boolean;
  identity: { name: string; email: string };
  lastCommitPair: { from: string; to: string } | null;
  turnDiff: TurnDiffData | null;
  diffDialogOpen: boolean;
  diffDialogTitle: string | undefined;
  rebaseStatus: RebaseStatus;
  rebaseConflicts: RebaseConflict[];

  rebaseError: string | null;
  pushRejected: boolean;

  setCommits: (commits: GitCommit[]) => void;
  prependCommit: (commit: GitCommit) => void;
  setIdentityNeeded: (needed: boolean) => void;
  setIdentity: (identity: { name: string; email: string }) => void;
  setLastCommitPair: (pair: { from: string; to: string } | null) => void;
  setTurnDiff: (diff: TurnDiffData | null) => void;
  openDiffDialog: (title?: string) => void;
  closeDiffDialog: () => void;
  setRebaseStatus: (status: RebaseStatus) => void;
  setRebaseConflicts: (conflicts: RebaseConflict[]) => void;
  setRebaseError: (error: string | null) => void;
  setPushRejected: (rejected: boolean) => void;
  reset: () => void;

  fetchLog: (sessionId: string) => Promise<void>;
  fetchDiff: (sessionId: string, from: string, to: string) => Promise<void>;
  fetchDiffVsBranch: (sessionId: string, baseBranch?: string) => Promise<void>;
  submitGitIdentity: (name: string, email: string) => Promise<void>;
  startRebase: (sessionId: string, baseBranch: string) => Promise<void>;
  resetBranchToBase: (sessionId: string) => Promise<void>;
  abortRebase: (sessionId: string) => Promise<void>;
}

const initialState = {
  commits: [] as GitCommit[],
  identityNeeded: false,
  identity: { name: "", email: "" },
  lastCommitPair: null as { from: string; to: string } | null,
  turnDiff: null as TurnDiffData | null,
  diffDialogOpen: false,
  diffDialogTitle: undefined as string | undefined,
  rebaseStatus: "idle" as RebaseStatus,
  rebaseConflicts: [] as RebaseConflict[],
  rebaseError: null as string | null,
  pushRejected: false,
};

export const useGitStore = create<GitState>((set) => ({
  ...initialState,

  setCommits: (commits) => set({ commits }),

  prependCommit: (commit) =>
    set((state) => ({ commits: [commit, ...state.commits] })),

  setIdentityNeeded: (needed) => set({ identityNeeded: needed }),

  setIdentity: (identity) => set({ identity }),

  setLastCommitPair: (pair) => set({ lastCommitPair: pair }),

  setTurnDiff: (diff) => set({ turnDiff: diff }),

  openDiffDialog: (title) => set({ diffDialogOpen: true, diffDialogTitle: title }),

  closeDiffDialog: () => set({ diffDialogOpen: false, turnDiff: null, diffDialogTitle: undefined }),

  setRebaseStatus: (status) => set({ rebaseStatus: status }),

  setRebaseConflicts: (conflicts) => set({ rebaseConflicts: conflicts }),

  setRebaseError: (error) => set({ rebaseError: error }),

  setPushRejected: (rejected) => set({ pushRejected: rejected }),

  reset: () => set(initialState),

  fetchLog: async (sessionId) => {
    const res = await fetch(`/api/sessions/${sessionId}/git/log`);
    if (!res.ok) {
      throw new Error(`Failed to fetch git log: ${res.status}`);
    }
    const data = await res.json() as { commits: GitCommit[] };
    set({ commits: data.commits });
  },

  fetchDiff: async (sessionId, from, to) => {
    const res = await fetch(`/api/sessions/${sessionId}/git/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch diff: ${res.status}`);
    }
    const data = await res.json() as TurnDiffData;
    set({ turnDiff: data });
  },

  fetchDiffVsBranch: async (sessionId, baseBranch) => {
    const query = baseBranch ? `?base=${encodeURIComponent(baseBranch)}` : "";
    const res = await fetch(`/api/sessions/${sessionId}/git/diff-vs-branch${query}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch diff: ${res.status}`);
    }
    const data = await res.json() as TurnDiffData;
    set({ turnDiff: data });
  },

  submitGitIdentity: async (name, email) => {
    const res = await fetch("/api/settings/git-identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email }),
    });
    if (!res.ok) {
      throw new Error(`Failed to save git identity: ${res.status}`);
    }
    const result = await res.json() as { name: string; email: string };
    set({ identity: result });
  },

  startRebase: async (sessionId, baseBranch) => {

    set({ rebaseStatus: "in_progress", pushRejected: false, rebaseError: null });
    try {
      const res = await fetch(`/api/sessions/${sessionId}/git/rebase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseBranch }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Rebase failed" })) as { error: string };
        throw new Error(data.error);
      }

    } catch (err) {

      const message = err instanceof Error ? err.message : "Rebase failed";
      set({ rebaseStatus: "idle", rebaseError: message });
    }
  },

  resetBranchToBase: async (sessionId) => {
    // A merged branch must be reset, not rebased: squash and merge commits make

    // same safety gate as the agent-driven reset and synchronously settles the

    set({ rebaseStatus: "in_progress", pushRejected: false, rebaseError: null });
    try {
      const res = await fetch(`/api/sessions/${sessionId}/branch/reset-to-base`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({})) as {
        outcome?: "reset" | "already-at-base" | "refused";
        reason?: string;
      };
      if (!res.ok || data.outcome === "refused") {
        throw new Error(data.reason ?? `Branch reset failed: ${res.status}`);
      }
      set({ rebaseStatus: "idle" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Branch reset failed";
      set({ rebaseStatus: "idle", rebaseError: message });
    }
  },

  abortRebase: async (sessionId) => {
    try {
      await fetch(`/api/sessions/${sessionId}/git/rebase/abort`, {
        method: "POST",
      });
    } finally {
      set({ rebaseStatus: "idle", rebaseConflicts: [] });
    }
  },
}));
