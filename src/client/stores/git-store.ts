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
  setPushRejected: (rejected: boolean) => void;
  reset: () => void;

  fetchLog: (sessionId: string) => Promise<void>;
  fetchDiff: (sessionId: string, from: string, to: string) => Promise<void>;
  fetchDiffVsBranch: (sessionId: string, baseBranch?: string) => Promise<void>;
  submitGitIdentity: (name: string, email: string) => Promise<void>;
  startRebase: (sessionId: string, baseBranch: string) => Promise<void>;
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

  fetchDiffVsBranch: async (sessionId, baseBranch = "main") => {
    const res = await fetch(`/api/sessions/${sessionId}/git/diff-vs-branch?base=${encodeURIComponent(baseBranch)}`);
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
    set({ rebaseStatus: "in_progress", pushRejected: false });
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
      const data = await res.json() as { status: string; conflicts?: { path: string }[] };
      if (data.status === "conflicts") {
        set({
          rebaseStatus: "conflicts",
          rebaseConflicts: data.conflicts ?? [],
        });
      } else {
        // "rebased" or "up_to_date"
        set({ rebaseStatus: "idle", rebaseConflicts: [] });
      }
    } catch {
      set({ rebaseStatus: "idle" });
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
