import { create } from "zustand";
import type { GitCommit } from "../components/GitHistory.js";
import type { TurnDiffData } from "../components/DiffPanel.js";
import type { FileTreeNode } from "../components/FileTree.js";

interface GitState {
  commits: GitCommit[];
  identityNeeded: boolean;
  identity: { name: string; email: string };
  lastCommitPair: { from: string; to: string } | null;
  turnDiff: TurnDiffData | null;
  historyDiffMode: boolean;

  setCommits: (commits: GitCommit[]) => void;
  prependCommit: (commit: GitCommit) => void;
  setIdentityNeeded: (needed: boolean) => void;
  setIdentity: (identity: { name: string; email: string }) => void;
  setLastCommitPair: (pair: { from: string; to: string } | null) => void;
  setTurnDiff: (diff: TurnDiffData | null) => void;
  setHistoryDiffMode: (mode: boolean) => void;
  reset: () => void;

  fetchLog: (sessionId: string) => Promise<void>;
  rollback: (sessionId: string, hash: string) => Promise<void>;
  rejectFiles: (
    sessionId: string,
    files: string[],
  ) => Promise<{ gitLog?: GitCommit[]; fileTree?: FileTreeNode[] } | null>;
  submitGitIdentity: (name: string, email: string) => Promise<void>;
}

const initialState = {
  commits: [] as GitCommit[],
  identityNeeded: false,
  identity: { name: "", email: "" },
  lastCommitPair: null as { from: string; to: string } | null,
  turnDiff: null as TurnDiffData | null,
  historyDiffMode: false,
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

  setHistoryDiffMode: (mode) => set({ historyDiffMode: mode }),

  reset: () => set(initialState),

  fetchLog: async (sessionId) => {
    const res = await fetch(`/api/sessions/${sessionId}/git/log`);
    if (!res.ok) {
      throw new Error(`Failed to fetch git log: ${res.status}`);
    }
    const data = await res.json();
    set({ commits: data.commits });
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

  rejectFiles: async (sessionId, files) => {
    const res = await fetch(`/api/sessions/${sessionId}/git/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromCommit: get().lastCommitPair?.from, files }),
    });
    if (!res.ok) {
      throw new Error(`Failed to reject files: ${res.status}`);
    }

    set({ turnDiff: null, lastCommitPair: null });

    const stateRes = await fetch(
      `/api/sessions/${sessionId}/workspace-state`,
    );
    if (!stateRes.ok) {
      return null;
    }
    const result = await stateRes.json();
    return result as { gitLog?: GitCommit[]; fileTree?: FileTreeNode[] };
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
    const result = await res.json();
    set({ identity: result });
  },
}));
