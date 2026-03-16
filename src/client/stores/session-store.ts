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
  /** Session IDs where the agent finished while the user was viewing a different session. */
  unseenResults: Set<string>;
  queuedMessages: { text: string; position: number }[];
  /** WS message to auto-send when the next per-session WS connection opens (e.g. new session from home). */
  pendingWsMessage: Record<string, unknown> | undefined;
  /** Text to prefill into the message input (consumed and cleared by MessageInput). */
  prefillText: string | undefined;

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
  markUnseen: (sessionId: string) => void;
  clearUnseen: (sessionId: string) => void;
  setQueuedMessages: (
    messages:
      | { text: string; position: number }[]
      | ((
          prev: { text: string; position: number }[],
        ) => { text: string; position: number }[]),
  ) => void;
  setPendingWsMessage: (message: Record<string, unknown> | undefined) => void;
  setPrefillText: (text: string | undefined) => void;
  reset: () => void;

  // All sessions dialog
  allSessions: SessionInfo[];
  allSessionsDialogOpen: boolean;
  setAllSessionsDialogOpen: (open: boolean) => void;
  fetchAllSessions: () => Promise<void>;
  unarchiveSession: (sessionId: string) => Promise<void>;

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
  queuedMessages: [] as { text: string; position: number }[],
  pendingWsMessage: undefined as Record<string, unknown> | undefined,
  prefillText: undefined as string | undefined,
};

export const useSessionStore = create<SessionState>((set) => ({
  sessionId: undefined,
  ...initialResettableState,
  sessions: [] as SessionInfo[],
  authUrl: null,
  activeRunnerSessions: new Set<string>(),
  unseenResults: new Set<string>(),
  allSessions: [] as SessionInfo[],
  allSessionsDialogOpen: false,

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

  markUnseen: (sessionId) =>
    set((state) => {
      const next = new Set(state.unseenResults);
      next.add(sessionId);
      return { unseenResults: next };
    }),

  clearUnseen: (sessionId) =>
    set((state) => {
      if (!state.unseenResults.has(sessionId)) return state;
      const next = new Set(state.unseenResults);
      next.delete(sessionId);
      return { unseenResults: next };
    }),

  setQueuedMessages: (messages) =>
    set((state) => ({
      queuedMessages:
        typeof messages === "function"
          ? messages(state.queuedMessages)
          : messages,
    })),

  setPendingWsMessage: (pendingWsMessage) => set({ pendingWsMessage }),

  setPrefillText: (prefillText) => set({ prefillText }),

  reset: () => set(initialResettableState),

  setAllSessionsDialogOpen: (allSessionsDialogOpen) => set({ allSessionsDialogOpen }),

  fetchAllSessions: async () => {
    const res = await fetch("/api/sessions/all", {
      headers: { Accept: "application/json" },
    });
    const data = await res.json() as { sessions: SessionInfo[] };
    set({ allSessions: data.sessions });
  },

  unarchiveSession: async (sessionId) => {
    const res = await fetch(`/api/sessions/${sessionId}/unarchive`, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" })) as { error?: string };
      throw new Error(err.error ?? `Failed to unarchive session (${res.status})`);
    }
    const result = await res.json() as { sessions: SessionInfo[] };
    set((state) => ({
      sessions: result.sessions,
      allSessions: state.allSessions.map((s) =>
        s.id === sessionId ? { ...s, archived: undefined } : s,
      ),
    }));
  },

  archiveSession: async (sessionId) => {
    const res = await fetch(`/api/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" })) as { error?: string };
      throw new Error(err.error ?? `Failed to archive session (${res.status})`);
    }
    const result = await res.json() as { sessions: SessionInfo[] };
    set((state) => ({
      sessions: result.sessions,
      allSessions: state.allSessions.map((s) =>
        s.id === sessionId ? { ...s, archived: true } : s,
      ),
    }));
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
    const data = await res.json() as { sessions: SessionInfo[] };
    set({ sessions: data.sessions });
  },
}));
