import { create } from "zustand";

interface PrResult {
  success: boolean;
  url?: string;
  number?: number;
  message?: string;
}

interface PrChecks {
  state: "pending" | "success" | "failure" | "none";
  total: number;
  passed: number;
  failed: number;
  pending: number;
}

interface PrStatus {
  url: string;
  number: number;
  title: string;
  baseBranch: string;
  headBranch: string;
  insertions: number;
  deletions: number;
  checks: PrChecks;
  autoMergeEnabled: boolean;
  mergeable: boolean;
}

interface ImportSearchResult {
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
}

interface PrState {
  showModal: boolean;
  currentBranch: string;
  remoteBranches: string[];
  result: PrResult | null;
  descGenerating: boolean;
  descError: string | null;
  generatedDesc: string | null;
  importSearchResults: ImportSearchResult[];
  status: PrStatus | null;

  // Actions
  openModal: () => void;
  closeModal: () => void;
  setResult: (result: PrResult | null) => void;
  setStatus: (status: PrStatus | null) => void;
  setImportSearchResults: (results: ImportSearchResult[]) => void;
  setCurrentBranch: (branch: string) => void;
  setRemoteBranches: (branches: string[]) => void;
  setDescGenerating: (generating: boolean) => void;
  setDescError: (error: string | null) => void;
  setGeneratedDesc: (desc: string | null) => void;
  reset: () => void;

  // Async actions
  submit: (
    sessionId: string,
    data: { title: string; body: string; base: string; draft: boolean },
  ) => Promise<void>;
  requestBranches: (sessionId: string) => Promise<void>;
  generateDescription: (sessionId: string) => Promise<void>;
  searchRepos: (query: string) => Promise<void>;
  mergePr: (
    sessionId: string,
    method: "merge" | "squash" | "rebase",
  ) => Promise<{ success: boolean; autoMergeEnabled?: boolean } | null>;
  fetchStatus: (sessionId: string) => Promise<void>;
}

const initialState = {
  showModal: false,
  currentBranch: "",
  remoteBranches: [] as string[],
  result: null as PrResult | null,
  descGenerating: false,
  descError: null as string | null,
  generatedDesc: null as string | null,
  importSearchResults: [] as ImportSearchResult[],
  status: null as PrStatus | null,
};

export const usePrStore = create<PrState>((set) => ({
  ...initialState,

  openModal: () =>
    set({
      result: null,
      currentBranch: "",
      remoteBranches: [],
      descGenerating: false,
      descError: null,
      generatedDesc: null,
      showModal: true,
    }),

  closeModal: () => set({ showModal: false }),

  setResult: (result) => set({ result }),

  setStatus: (status) => set({ status }),

  setImportSearchResults: (importSearchResults) => set({ importSearchResults }),

  setCurrentBranch: (currentBranch) => set({ currentBranch }),

  setRemoteBranches: (remoteBranches) => set({ remoteBranches }),

  setDescGenerating: (descGenerating) => set({ descGenerating }),

  setDescError: (descError) => set({ descError }),

  setGeneratedDesc: (generatedDesc) => set({ generatedDesc }),

  reset: () => set(initialState),

  submit: async (sessionId, data) => {
    const res = await fetch(`/api/sessions/${sessionId}/pr`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    set({ result: json });
  },

  requestBranches: async (sessionId) => {
    const res = await fetch(`/api/sessions/${sessionId}/git/branches`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const data = await res.json();
    set({
      currentBranch: data.current,
      remoteBranches: data.remote,
    });
  },

  generateDescription: async (sessionId) => {
    set({ descGenerating: true, descError: null, generatedDesc: null });
    try {
      const res = await fetch(`/api/sessions/${sessionId}/pr/description`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      });
      const data = await res.json();
      if (!res.ok) {
        set({ descError: data.error || "Failed to generate description" });
      } else {
        set({ generatedDesc: data.description });
      }
    } catch (err) {
      set({
        descError:
          err instanceof Error ? err.message : "Failed to generate description",
      });
    } finally {
      set({ descGenerating: false });
    }
  },

  searchRepos: async (query) => {
    const res = await fetch(
      `/api/github/repos?q=${encodeURIComponent(query)}`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
      },
    );
    const data = await res.json();
    set({ importSearchResults: data.repos });
  },

  mergePr: async (sessionId, method) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/pr/merge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ method }),
      });
      const data = await res.json();
      return data;
    } catch {
      return null;
    }
  },

  fetchStatus: async (sessionId) => {
    const res = await fetch(`/api/sessions/${sessionId}/pr/status`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const data = await res.json();
    set({ status: data.pr });
  },
}));
