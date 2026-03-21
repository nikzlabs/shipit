import { create } from "zustand";
import type { GitCommit } from "../components/GitHistory.js";
import type { TurnDiffData } from "../components/DiffPanel.js";
interface GitState {
  commits: GitCommit[];
  identityNeeded: boolean;
  identity: { name: string; email: string };
  lastCommitPair: { from: string; to: string } | null;
  turnDiff: TurnDiffData | null;
  diffDialogOpen: boolean;
  diffDialogTitle: string | undefined;

  setCommits: (commits: GitCommit[]) => void;
  prependCommit: (commit: GitCommit) => void;
  setIdentityNeeded: (needed: boolean) => void;
  setIdentity: (identity: { name: string; email: string }) => void;
  setLastCommitPair: (pair: { from: string; to: string } | null) => void;
  setTurnDiff: (diff: TurnDiffData | null) => void;
  openDiffDialog: (title?: string) => void;
  closeDiffDialog: () => void;
  reset: () => void;

  fetchLog: (sessionId: string) => Promise<void>;
  fetchDiff: (sessionId: string, from: string, to: string) => Promise<void>;
  fetchDiffVsBranch: (sessionId: string, baseBranch?: string) => Promise<void>;
  rollback: (sessionId: string, hash: string) => Promise<void>;
  submitGitIdentity: (name: string, email: string) => Promise<void>;
}

const initialState = {
  commits: [] as GitCommit[],
  identityNeeded: false,
  identity: { name: "", email: "" },
  lastCommitPair: null as { from: string; to: string } | null,
  turnDiff: null as TurnDiffData | null,
  diffDialogOpen: false,
  diffDialogTitle: undefined as string | undefined,
};

export const useGitStore = create<GitState>((set, get) => ({
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

  rollback: async (sessionId, hash) => {
    const res = await fetch(`/api/sessions/${sessionId}/git/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commitHash: hash }),
    });
    if (!res.ok) {
      throw new Error(`Failed to rollback: ${res.status}`);
    }
    await get().fetchLog(sessionId);
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
}));
