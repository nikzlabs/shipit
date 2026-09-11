import { create } from "zustand";
import { saveDraftMessage } from "../utils/local-storage.js";
import type { ChatMessage } from "../components/MessageList.js";
import type { StreamingActivity } from "../components/StreamingIndicator.js";
import type { SessionInfo, SessionCapabilities, TurnUsage, RescuePhase, WsRewindPreview, AgentId, ContainerFreshness, SessionSecretBlock, IssueRef } from "../../server/shared/types.js";
import { useUiStore } from "./ui-store.js";

/**
 * docs/144 — a transient sub-agent spawn spinner ("Asking Codex…"), live only
 * while the `shipit agent` call is in flight. Status only; never persisted. The
 * TERMINAL "Consulted Codex · 47s" record is NOT here — it's a persisted
 * `subAgentConsult` chat message that survives a switch/reload. When that card
 * arrives the spinner is removed by `spawnId`.
 */
export interface SubAgentSpawnChip {
  spawnId: string;
  subAgentId: AgentId;
}

export interface RescueState {
  phase: RescuePhase;
  reason?: string;
  message?: string;

  startedAt?: number;
}

export interface RewindRecovery {
  sessionId: string;
  action: "chat" | "code" | "both" | "fork";
  expiresAt: number;
}

interface SessionState {
  sessionId: string | undefined;
  messages: ChatMessage[];
  isLoading: boolean;
  activity: StreamingActivity | undefined;
  /**
   * docs/178 — transient "Compacting…" indicator. Set true on a
   * `compaction_status` with `active:true`, cleared on `active:false` (or when
   * the matching card lands). Never persisted — purely a live progress signal.
   */
  compacting: boolean;
  /**
   * docs/178 — the transcript position the in-flight compaction started at:
   * `messages.length` at the moment `compacting` went true, or `null` when no
   * compaction is running. `MessageList` renders the transient indicator at
   * this position instead of at the end of the list, so a message the user
   * sends *while* the compaction runs lands BELOW the spinner — the order the
   * two things actually happened in. Derived by `setCompacting`; never set
   * directly.
   */
  compactingAnchor: number | null;
  /**
   * docs/144 — transient sub-agent spawn chips keyed by spawnId. Set from
   * `sub_agent_spawn` WS messages; "Asking Codex…" while in flight, replaced by
   * "Consulted Codex · 47s · $0.03" on return. Status only, never persisted —
   * resets on reload/switch (the sub-agent's output reaches the user through the
   * primary's own voice).
   */
  subAgentSpawns: Record<string, SubAgentSpawnChip>;
  selectedRepoUrl: string | null;
  creatingRepo: boolean;
  sessions: SessionInfo[];
  /**
   * docs/252 phase 4 — how many times the server has answered a selection change
   * for a session, keyed by session id.
   *
   * The composer picks OPTIMISTICALLY, and the obvious clear signal — "the
   * session row now matches my pick" — cannot fire when the server REFUSED the
   * pick, because the row is then exactly what it was. Without a separate
   * signal the picker sits on a selection the session is not on, indefinitely
   * and invisibly (a same-id cross-service pick changes nothing else on screen).
   * A counter says "the server has answered", which is true of both outcomes.
   */
  modelSelectionEcho: Record<string, number>;
  activeRunnerSessions: Set<string>;
  /**
   * docs/285 — which runner GENERATION each session is on, as the server last
   * reported it. Bumped server-side whenever a session's runner is created, so a
   * value that moves means the runner this tab is attached to has been replaced
   * (a network-mode rebuild, a Rescue).
   *
   * It matters because disposal leaves the viewer's socket open with no
   * listeners on the other end: a tab that was watching when the container was
   * rebuilt receives nothing at all, forever, with no error to notice.
   */
  runnerIncarnations: Record<string, number>;
  /**
   * docs/285 — bumped when the ACTIVE session's runner generation moved, so this
   * tab's WebSocket reattaches to the replacement.
   *
   * A counter rather than a boolean because the same thing can happen twice, and
   * the second occurrence has to be distinguishable from the first.
   */
  staleRunnerNonce: number;

  awaitingPermissionSessions: Set<string>;
  /**
   * docs/235 — sessions holding outstanding agent-initiated background tasks,
   * mapped to those tasks' descriptions (empty when the descriptions aren't
   * known — the SSE reconnect snapshot carries ids only).
   *
   * Deliberately SEPARATE from `activeRunnerSessions` rather than folded into
   * it: consumers of that set (`PrStatusControls`, `SpawnedSessionCard`,
   * `useAttentionNotifications`) read it as "a turn is in flight", so widening
   * it would silently change PR-action gating as a side effect. Sites that
   * should treat the two alike OR them explicitly.
   *
   * A Map rather than a Set of ids because the chat status line names the work
   * ("Waiting for: npm test"), and that line is restored at *turn end* — by
   * which point the `background_tasks` message that carried the descriptions is
   * long gone. Keeping them here means the marker and its label can't drift.
   */
  backgroundTaskSessions: Map<string, string[]>;
  queuedMessages: { text: string; position: number }[];
  rewindPreviews: Record<string, WsRewindPreview>;
  rewindRecoveries: Record<string, RewindRecovery>;

  pendingWsMessage: Record<string, unknown> | undefined;

  prefillText: string | undefined;
  /**
   * planning#322 — the issue the Issues tab's "Start session" seeded this session
   * with, waiting to ride along with the first message. It is NOT the prefill
   * text's twin: the text is consumed by the composer immediately and may then
   * be edited or discarded, while this stays until the message is actually
   * sent, which is the moment the server can act on it (branch pin + `→
   * started`). Scoped by `sessionId` because prefilling doesn't stop the user
   * from switching sessions first — the send only attaches the ref when the
   * session it was seeded for is the one being sent to.
   */
  pendingIssueRef: { sessionId: string; ref: IssueRef } | undefined;

  quoteReplyText: string | undefined;

  historyLoaded: boolean;

  rescueState: RescueState | null;

  recoveryActionError: string | null;

  interruptError: string | null;

  pauseNotice: { reason: "agent-reclaimed" | "memory-pressure"; idleMs?: number; at: number } | null;

  memoryExhausted: { countInWindow: number; windowMs: number; threshold: number; at: number } | null;

  containerFreshness: ContainerFreshness | null;
  /**
   * docs/213 / planning#317 — non-null while the active session's auto-commit is
   * refused because a likely credential sits in the working tree. Drives the
   * sticky `SecretBlockBanner`; the accompanying chat notice is a separate,
   * scrollable transcript row. Seeded on attach/session-switch from
   * `secret_block_status` and cleared when a commit lands.
   */
  secretBlock: SessionSecretBlock | null;

  turnUsage: Record<string, TurnUsage[]>;

  setSessionId: (id: string | undefined) => void;
  setMessages: (
    messages: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]),
  ) => void;
  updateLastMessage: (updater: (msg: ChatMessage) => ChatMessage) => void;
  setIsLoading: (loading: boolean) => void;
  setActivity: (activity: StreamingActivity | undefined) => void;
  setCompacting: (compacting: boolean) => void;

  upsertSubAgentSpawn: (chip: SubAgentSpawnChip) => void;

  removeSubAgentSpawn: (spawnId: string) => void;
  setHistoryLoaded: (loaded: boolean) => void;
  setRescueState: (state: RescueState | null) => void;
  setRecoveryActionError: (error: string | null) => void;
  setInterruptError: (error: string | null) => void;
  setPauseNotice: (notice: SessionState["pauseNotice"]) => void;
  setMemoryExhausted: (notice: SessionState["memoryExhausted"]) => void;
  setContainerFreshness: (freshness: ContainerFreshness | null) => void;
  setSecretBlock: (block: SessionSecretBlock | null) => void;
  setSessions: (
    sessions: SessionInfo[] | ((prev: SessionInfo[]) => SessionInfo[]),
  ) => void;

  bumpModelSelectionEcho: (sessionId: string) => void;

  setAutoFixCiPaused: (sessionId: string, paused: boolean) => Promise<void>;

  setPinned: (sessionId: string, pinned: boolean) => Promise<void>;

  setKeepPreviewRunning: (sessionId: string, enabled: boolean) => Promise<void>;

  setMuted: (sessionId: string, muted: boolean) => Promise<void>;

  reorderPins: (remoteUrl: string, ids: string[]) => Promise<void>;
  setSelectedRepoUrl: (url: string | null) => void;
  setCreatingRepo: (creating: boolean) => void;
  setActiveRunnerSessions: (
    updater: (prev: Set<string>) => Set<string>,
  ) => void;
  /**
   * docs/285 — fold in the server's view of runner generations, and raise
   * `staleRunnerNonce` if the ACTIVE session's moved.
   *
   * `merge` distinguishes the two shapes that arrive here: the SSE connect
   * snapshot is authoritative and replaces the map, while a live per-session
   * signal carries one entry and must not erase what it does not mention.
   */
  noteRunnerIncarnations: (
    next: Record<string, number>,

    opts?: { merge?: boolean; live?: boolean },
  ) => void;
  setAwaitingPermissionSessions: (
    updater: (prev: Set<string>) => Set<string>,
  ) => void;
  setBackgroundTaskSessions: (
    updater: (prev: Map<string, string[]>) => Map<string, string[]>,
  ) => void;
  setQueuedMessages: (
    messages:
      | { text: string; position: number }[]
      | ((
          prev: { text: string; position: number }[],
        ) => { text: string; position: number }[]),
  ) => void;
  setRewindPreview: (preview: WsRewindPreview) => void;
  setRewindRecovery: (recovery: RewindRecovery | null) => void;
  setPendingWsMessage: (message: Record<string, unknown> | undefined) => void;

  setPrefillText: (text: string | undefined) => void;
  setPendingIssueRef: (pending: { sessionId: string; ref: IssueRef } | undefined) => void;

  setQuoteReplyText: (text: string | undefined) => void;

  appendTurnUsage: (sessionId: string, turn: TurnUsage) => void;

  setTurnUsageForSession: (sessionId: string, turns: TurnUsage[]) => void;
  reset: () => void;

  allSessions: SessionInfo[];
  allSessionsDialogOpen: boolean;
  /**
   * Repo the dialog opens filtered to, when it was opened FROM a repo (the
   * sidebar's "View All Sessions"). `undefined` means "no repo was named" and
   * the dialog falls back to the current session's repo. Carried here rather
   * than read off the active session because the two differ exactly when it
   * matters — opening the menu on repo B while a session of repo A is current.
   */
  allSessionsDialogRepoUrl: string | undefined;
  setAllSessionsDialogOpen: (open: boolean, repoUrl?: string) => void;
  fetchAllSessions: () => Promise<void>;
  unarchiveSession: (sessionId: string) => Promise<void>;

  archiveSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  refreshSessions: () => Promise<void>;

  createOpsSession: (targetSessionId?: string) => Promise<string | null>;

  createSandboxSession: (capabilities: SessionCapabilities) => Promise<string | null>;

  getChildren: (parentSessionId: string) => SessionInfo[];
}

const initialResettableState = {
  messages: [] as ChatMessage[],
  isLoading: false,
  activity: undefined as StreamingActivity | undefined,
  compacting: false,
  compactingAnchor: null as number | null,
  subAgentSpawns: {},
  selectedRepoUrl: null as string | null,
  creatingRepo: false,
  queuedMessages: [] as { text: string; position: number }[],
  rewindPreviews: {} as Record<string, WsRewindPreview>,
  pendingWsMessage: undefined as Record<string, unknown> | undefined,
  prefillText: undefined as string | undefined,
  pendingIssueRef: undefined as { sessionId: string; ref: IssueRef } | undefined,
  quoteReplyText: undefined as string | undefined,
  historyLoaded: false,
  rescueState: null as RescueState | null,
  recoveryActionError: null as string | null,
  interruptError: null as string | null,
  pauseNotice: null as SessionState["pauseNotice"],
  memoryExhausted: null as SessionState["memoryExhausted"],
  containerFreshness: null as ContainerFreshness | null,
  secretBlock: null as SessionSecretBlock | null,
};

const initialTurnUsage: Record<string, TurnUsage[]> = {};

export const useSessionStore = create<SessionState>((set, get) => ({
  sessionId: undefined,
  ...initialResettableState,
  sessions: [] as SessionInfo[],
  modelSelectionEcho: {},
  activeRunnerSessions: new Set<string>(),
  runnerIncarnations: {},
  staleRunnerNonce: 0,
  awaitingPermissionSessions: new Set<string>(),
  backgroundTaskSessions: new Map<string, string[]>(),
  rewindRecoveries: {},
  turnUsage: initialTurnUsage,
  allSessions: [] as SessionInfo[],
  allSessionsDialogOpen: false,
  allSessionsDialogRepoUrl: undefined,

  setSessionId: (sessionId) => set({ sessionId }),

  setMessages: (messages) =>
    set((state) => ({
      messages:
        typeof messages === "function" ? messages(state.messages) : messages,
    })),

  updateLastMessage: (updater) =>
    set((state) => {
      if (state.messages.length === 0) return state;
      const updated = [...state.messages];
      updated[updated.length - 1] = updater(updated[updated.length - 1]);
      return { messages: updated };
    }),

  setIsLoading: (isLoading) => set({ isLoading }),

  setActivity: (activity) => set({ activity }),

  // the replay must not move the spinner down past messages sent since.
  setCompacting: (compacting) =>
    set((s) => ({
      compacting,
      compactingAnchor: !compacting
        ? null
        : s.compacting && s.compactingAnchor !== null
        ? s.compactingAnchor
        : s.messages.length,
    })),
  upsertSubAgentSpawn: (chip) =>
    set((s) => ({ subAgentSpawns: { ...s.subAgentSpawns, [chip.spawnId]: chip } })),
  removeSubAgentSpawn: (spawnId) =>
    set((s) => {
      if (!(spawnId in s.subAgentSpawns)) return s;
      const next = Object.fromEntries(
        Object.entries(s.subAgentSpawns).filter(([id]) => id !== spawnId),
      );
      return { subAgentSpawns: next };
    }),

  setHistoryLoaded: (historyLoaded) => set({ historyLoaded }),

  setRescueState: (rescueState) => set({ rescueState }),

  setRecoveryActionError: (recoveryActionError) => set({ recoveryActionError }),

  setInterruptError: (interruptError) => set({ interruptError }),

  setPauseNotice: (pauseNotice) => set({ pauseNotice }),

  setMemoryExhausted: (memoryExhausted) => set({ memoryExhausted }),

  setContainerFreshness: (containerFreshness) => set({ containerFreshness }),
  setSecretBlock: (secretBlock) => set({ secretBlock }),

  setSessions: (sessions) =>
    set((state) => ({
      sessions:
        typeof sessions === "function" ? sessions(state.sessions) : sessions,
    })),

  bumpModelSelectionEcho: (sessionId) =>
    set((state) => ({
      modelSelectionEcho: {
        ...state.modelSelectionEcho,
        [sessionId]: (state.modelSelectionEcho[sessionId] ?? 0) + 1,
      },
    })),

  setAutoFixCiPaused: async (sessionId, paused) => {
    const patch = (value: boolean) =>
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, autoFixCiPaused: value } : s,
        ),
      }));
    const prev = get().sessions.find((s) => s.id === sessionId)?.autoFixCiPaused ?? false;
    patch(paused);              
    try {
      const res = await fetch(`/api/sessions/${sessionId}/pr/auto-fix-pause`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ paused }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        console.error("[session-store] Auto-fix pause toggle failed:", data.error);
        patch(prev);          
      }
    } catch (err) {
      console.error("[session-store] Auto-fix pause toggle failed:", err);
      patch(prev);          
    }
  },

  setPinned: async (sessionId, pinned) => {
    const patch = (value: string | undefined) =>
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, pinnedAt: value } : s,
        ),
      }));
    const prev = get().sessions.find((s) => s.id === sessionId)?.pinnedAt;
    patch(pinned ? new Date().toISOString() : undefined);              
    try {
      const res = await fetch(`/api/sessions/${sessionId}/pin`, {
        method: pinned ? "POST" : "DELETE",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        console.error("[session-store] Pin toggle failed:", data.error);
        patch(prev);          
      }
      // On success the server broadcasts session_list, which reconciles ordering.
    } catch (err) {
      console.error("[session-store] Pin toggle failed:", err);
      patch(prev);          
    }
  },

  setKeepPreviewRunning: async (sessionId, enabled) => {

    const patch = (value: boolean) =>
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, keepPreviewRunning: value || undefined } : s,
        ),
        allSessions: state.allSessions.map((s) =>
          s.id === sessionId ? { ...s, keepPreviewRunning: value || undefined } : s,
        ),
      }));

    // dialog may not be in `sessions` at all, and a revert must restore its

    const prev = (get().sessions.find((s) => s.id === sessionId)
      ?? get().allSessions.find((s) => s.id === sessionId))?.keepPreviewRunning ?? false;
    patch(enabled);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/keep-preview-running`, {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        patch(prev);
        useUiStore.getState().setToast({ message: data.error ?? "Failed to update preview reservation" });
      }
    } catch (err) {
      console.error("[session-store] Preview reservation toggle failed:", err);
      patch(prev);
      useUiStore.getState().setToast({ message: "Failed to update preview reservation" });
    }
  },

  setMuted: async (sessionId, muted) => {

    const patch = (value: string | undefined) =>
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, mutedAt: value } : s)),
        allSessions: state.allSessions.map((s) => (s.id === sessionId ? { ...s, mutedAt: value } : s)),
      }));
    const prev = (get().sessions.find((s) => s.id === sessionId)
      ?? get().allSessions.find((s) => s.id === sessionId))?.mutedAt;

    patch(muted ? new Date().toISOString() : undefined);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/muted`, {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ muted }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        patch(prev);
        useUiStore.getState().setToast({ message: data.error ?? "Failed to update session mute" });
      }
    } catch (err) {
      console.error("[session-store] Mute toggle failed:", err);
      patch(prev);
      useUiStore.getState().setToast({ message: "Failed to update session mute" });
    }
  },

  reorderPins: async (remoteUrl, ids) => {

    const prev = new Map(
      get().sessions.filter((s) => ids.includes(s.id)).map((s) => [s.id, s.pinnedAt]),
    );

    const base = Date.now();
    set((state) => ({
      sessions: state.sessions.map((s) => {
        const idx = ids.indexOf(s.id);
        return idx >= 0 ? { ...s, pinnedAt: new Date(base - idx * 1000).toISOString() } : s;
      }),
    }));
    try {
      const res = await fetch("/api/sessions/pin-order", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ remoteUrl, ids }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        console.error("[session-store] Pin reorder failed:", data.error);
        set((state) => ({
          sessions: state.sessions.map((s) =>
            prev.has(s.id) ? { ...s, pinnedAt: prev.get(s.id) } : s,
          ),
        }));
      }
    } catch (err) {
      console.error("[session-store] Pin reorder failed:", err);
      set((state) => ({
        sessions: state.sessions.map((s) =>
          prev.has(s.id) ? { ...s, pinnedAt: prev.get(s.id) } : s,
        ),
      }));
    }
  },

  setSelectedRepoUrl: (selectedRepoUrl) => set({ selectedRepoUrl }),

  setCreatingRepo: (creatingRepo) => set({ creatingRepo }),

  setActiveRunnerSessions: (updater) =>
    set((state) => ({
      activeRunnerSessions: updater(state.activeRunnerSessions),
    })),

  noteRunnerIncarnations: (next, opts) =>
    set((state) => {
      const merged = opts?.merge
        ? { ...state.runnerIncarnations, ...next }
        : next;
      const active = state.sessionId;

      const previous = active ? state.runnerIncarnations[active] : undefined;
      const current = active ? merged[active] : undefined;

      const replaced =
        active !== null
        && current !== undefined
        && (opts?.live === true

          ? previous === undefined || current > previous
          : previous !== undefined && current > previous);
      return {
        runnerIncarnations: merged,
        staleRunnerNonce: replaced ? state.staleRunnerNonce + 1 : state.staleRunnerNonce,
      };
    }),

  setAwaitingPermissionSessions: (updater) =>
    set((state) => ({
      awaitingPermissionSessions: updater(state.awaitingPermissionSessions),
    })),

  setBackgroundTaskSessions: (updater) =>
    set((state) => ({
      backgroundTaskSessions: updater(state.backgroundTaskSessions),
    })),

  setQueuedMessages: (messages) =>
    set((state) => ({
      queuedMessages:
        typeof messages === "function"
          ? messages(state.queuedMessages)
          : messages,
    })),

  setRewindPreview: (preview) =>
    set((state) => ({
      rewindPreviews: {
        ...state.rewindPreviews,
        [`${preview.gapPosition}:${preview.action}`]: preview,
      },
    })),

  setRewindRecovery: (recovery) =>
    set((state) => {
      if (!recovery) {
        const sid = state.sessionId;
        if (!sid || !(sid in state.rewindRecoveries)) return state;
        const { [sid]: _omit, ...rest } = state.rewindRecoveries;
        void _omit;
        return { rewindRecoveries: rest };
      }
      return {
        rewindRecoveries: {
          ...state.rewindRecoveries,
          [recovery.sessionId]: recovery,
        },
      };
    }),

  setPendingWsMessage: (pendingWsMessage) => set({ pendingWsMessage }),

  setPrefillText: (prefillText) => set({ prefillText }),

  setPendingIssueRef: (pendingIssueRef) => set({ pendingIssueRef }),

  setQuoteReplyText: (quoteReplyText) => set({ quoteReplyText }),

  appendTurnUsage: (sessionId, turn) =>
    set((state) => ({
      turnUsage: {
        ...state.turnUsage,
        [sessionId]: [...(state.turnUsage[sessionId] ?? []), turn],
      },
    })),

  setTurnUsageForSession: (sessionId, turns) =>
    set((state) => ({
      turnUsage: { ...state.turnUsage, [sessionId]: turns },
    })),

  reset: () => set(initialResettableState),

  setAllSessionsDialogOpen: (allSessionsDialogOpen, allSessionsDialogRepoUrl) =>

    // open never inherits the previous one's repo.
    set({ allSessionsDialogOpen, allSessionsDialogRepoUrl }),

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
        s.id === sessionId
          ? { ...s, archived: undefined, userArchived: undefined, diskTier: "hot" as const }
          : s,
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
    const result = await res.json() as {
      sessions: SessionInfo[];
      checkoutsRetained?: { sessionId: string; message: string }[];
    };
    // The server keeps a checkout when its commits are on no remote; say so, or the
    // session quietly keeps using disk with nothing to explain it. Archiving a parent
    // archives its children too, so more than one can come back.
    const retained = result.checkoutsRetained ?? [];
    if (retained.length > 0) {
      const others = retained.length - 1;
      useUiStore.getState().setToast({
        message: others > 0
          ? `${retained[0].message} (and ${others} other archived session${others > 1 ? "s" : ""})`
          : retained[0].message,
        variant: "error",
        duration: 15000,
      });
    }
    const archivedTier = retained.some((r) => r.sessionId === sessionId)
      ? "light" as const
      : "evicted" as const;
    set((state) => {

      const { [sessionId]: _omit, ...rest } = state.turnUsage;
      void _omit;
      return {
        sessions: result.sessions,
        allSessions: state.allSessions.map((s) =>
          s.id === sessionId
            // Mirror the server's released preview reservation in the cached row.
            ? { ...s, archived: true, userArchived: true, diskTier: archivedTier, keepPreviewRunning: undefined }
            : s,
        ),
        turnUsage: rest,
      };
    });
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

  createOpsSession: async (targetSessionId) => {
    try {
      const res = await fetch("/api/sessions/new/template", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          templateId: "ops",
          ...(targetSessionId ? { targetSessionId } : {}),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { session?: { id: string }; seedPrompt?: string };
      const id = data.session?.id;
      if (!id) return null;

      // already typed (no race with container boot — this is a plain draft, not

      if (data.seedPrompt) saveDraftMessage(id, data.seedPrompt);
      await get().refreshSessions();
      return id;
    } catch (err) {
      console.error("[session-store] create ops session failed:", err);
      return null;
    }
  },

  createSandboxSession: async (capabilities) => {
    try {
      const res = await fetch("/api/sessions/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ capabilities }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { session?: { id: string } };
      const id = data.session?.id;
      if (!id) return null;
      await get().refreshSessions();
      return id;
    } catch (err) {
      console.error("[session-store] create sandbox session failed:", err);
      return null;
    }
  },

  getChildren: (parentSessionId) =>
    get().sessions.filter((s) => s.parentSessionId === parentSessionId),
}));
