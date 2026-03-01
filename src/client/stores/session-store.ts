import { create } from "zustand";
import type { ChatMessage } from "../components/MessageList.js";
import type { StreamingActivity } from "../components/StreamingIndicator.js";
import type { SessionInfo } from "../../server/shared/types.js";

interface SessionState {
  sessionId: string | undefined;
  messages: ChatMessage[];
  isLoading: boolean;
  activity: StreamingActivity | undefined;
  selectedRepoUrl: string | null;
  creatingRepo: boolean;
  sessions: SessionInfo[];
  authUrl: string | null;
  activeRunnerSessions: Set<string>;
  queuedMessages: Array<{ text: string; position: number }>;
  /** WS message to auto-send when the next per-session WS connection opens (e.g. new session from home). */
  pendingWsMessage: Record<string, unknown> | undefined;

  // Actions
  setSessionId: (id: string | undefined) => void;
  setMessages: (
    messages: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]),
  ) => void;
  appendMessage: (message: ChatMessage) => void;
  updateLastMessage: (updater: (msg: ChatMessage) => ChatMessage) => void;
  setIsLoading: (loading: boolean) => void;
  setActivity: (activity: StreamingActivity | undefined) => void;
  setSessions: (
    sessions: SessionInfo[] | ((prev: SessionInfo[]) => SessionInfo[]),
  ) => void;
  setAuthUrl: (url: string | null) => void;
  setSelectedRepoUrl: (url: string | null) => void;
  setCreatingRepo: (creating: boolean) => void;
  setActiveRunnerSessions: (
    updater: (prev: Set<string>) => Set<string>,
  ) => void;
  setQueuedMessages: (
    messages:
      | Array<{ text: string; position: number }>
      | ((
          prev: Array<{ text: string; position: number }>,
        ) => Array<{ text: string; position: number }>),
  ) => void;
  setPendingWsMessage: (message: Record<string, unknown> | undefined) => void;
  reset: () => void;

  // Async actions
  archiveSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
}

const initialResettableState = {
  messages: [] as ChatMessage[],
  isLoading: false,
  activity: undefined as StreamingActivity | undefined,
  selectedRepoUrl: null as string | null,
  creatingRepo: false,
  queuedMessages: [] as Array<{ text: string; position: number }>,
  pendingWsMessage: undefined as Record<string, unknown> | undefined,
};

export const useSessionStore = create<SessionState>((set) => ({
  sessionId: undefined,
  ...initialResettableState,
  sessions: [] as SessionInfo[],
  authUrl: null,
  activeRunnerSessions: new Set<string>(),

  setSessionId: (sessionId) => set({ sessionId }),

  setMessages: (messages) =>
    set((state) => ({
      messages:
        typeof messages === "function" ? messages(state.messages) : messages,
    })),

  appendMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),

  updateLastMessage: (updater) =>
    set((state) => {
      if (state.messages.length === 0) return state;
      const updated = [...state.messages];
      updated[updated.length - 1] = updater(updated[updated.length - 1]);
      return { messages: updated };
    }),

  setIsLoading: (isLoading) => set({ isLoading }),

  setActivity: (activity) => set({ activity }),

  setSessions: (sessions) =>
    set((state) => ({
      sessions:
        typeof sessions === "function" ? sessions(state.sessions) : sessions,
    })),

  setAuthUrl: (authUrl) => set({ authUrl }),

  setSelectedRepoUrl: (selectedRepoUrl) => set({ selectedRepoUrl }),

  setCreatingRepo: (creatingRepo) => set({ creatingRepo }),

  setActiveRunnerSessions: (updater) =>
    set((state) => ({
      activeRunnerSessions: updater(state.activeRunnerSessions),
    })),

  setQueuedMessages: (messages) =>
    set((state) => ({
      queuedMessages:
        typeof messages === "function"
          ? messages(state.queuedMessages)
          : messages,
    })),

  setPendingWsMessage: (pendingWsMessage) => set({ pendingWsMessage }),

  reset: () => set(initialResettableState),

  archiveSession: async (sessionId) => {
    const res = await fetch(`/api/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    const result = await res.json();
    set({ sessions: result.sessions });
  },

  renameSession: async (sessionId, title) => {
    await fetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ title }),
    });
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, title } : s,
      ),
    }));
  },

  refreshSessions: async () => {
    const res = await fetch("/api/bootstrap", {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const data = await res.json();
    set({ sessions: data.sessions });
  },
}));
