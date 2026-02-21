import { create } from "zustand";
import type { ThreadInfo } from "../components/ThreadIndicator.js";

interface ThreadState {
  threads: ThreadInfo[];
  activeThreadId: string;

  setThreads: (threads: ThreadInfo[]) => void;
  setActiveThreadId: (id: string) => void;
  addThread: (thread: ThreadInfo) => void;
  updateThread: (
    threadId: string,
    updater: (thread: ThreadInfo) => ThreadInfo,
  ) => void;
  reset: () => void;

  createCheckpoint: (sessionId: string, label?: string) => Promise<void>;
}

const initialState = {
  threads: [] as ThreadInfo[],
  activeThreadId: "",
};

export const useThreadStore = create<ThreadState>((set) => ({
  ...initialState,

  setThreads: (threads) => set({ threads }),

  setActiveThreadId: (id) => set({ activeThreadId: id }),

  addThread: (thread) =>
    set((state) => ({ threads: [...state.threads, thread] })),

  updateThread: (threadId, updater) =>
    set((state) => ({
      threads: state.threads.map((t) => (t.id === threadId ? updater(t) : t)),
    })),

  reset: () => set(initialState),

  createCheckpoint: async (sessionId, label) => {
    const res = await fetch(
      `/api/sessions/${sessionId}/threads/checkpoint`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      },
    );

    if (!res.ok) {
      throw new Error(`Failed to create checkpoint: ${res.status}`);
    }

    const { checkpoint, threadId } = await res.json();

    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? { ...t, checkpoints: [...t.checkpoints, checkpoint] }
          : t,
      ),
    }));
  },
}));
