import { create } from "zustand";
import type {
  ListIssuesResult,
  TrackerId,
  TrackerInfo,
  TrackerIssue,
} from "../../server/shared/types.js";

/**
 * Issues-tab store (docs/170). Per-tracker issue lists, fetched on tab open and
 * via a manual refresh button — no background poller in v1. Mirrors the
 * docs-list model (HTTP fetch + manual reload) rather than an SSE feed: the
 * issue list is repo/workspace-scoped reference data, not per-session stream.
 */
interface IssuesState {
  /** Configured-tracker metadata — drives the sub-tab switcher. */
  trackers: TrackerInfo[];
  activeTracker: TrackerId;
  issuesByTracker: Record<string, TrackerIssue[]>;
  /** Per-tracker info refreshed alongside the list (configured + binding). */
  infoByTracker: Record<string, TrackerInfo>;
  loading: boolean;
  error: string | null;
  /** Issue ids with a Start-session request in flight (per-row spinner). */
  startingIds: Set<string>;

  setActiveTracker: (id: TrackerId) => void;
  fetchTrackers: () => Promise<void>;
  fetchIssues: (trackerId?: TrackerId) => Promise<void>;
  startSession: (issue: TrackerIssue, repoUrl: string) => Promise<string | null>;
  reset: () => void;
}

export const useIssuesStore = create<IssuesState>((set, get) => ({
  trackers: [],
  activeTracker: "linear",
  issuesByTracker: {},
  infoByTracker: {},
  loading: false,
  error: null,
  startingIds: new Set(),

  setActiveTracker: (id) => set({ activeTracker: id }),

  fetchTrackers: async () => {
    try {
      const res = await fetch("/api/trackers", { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const data = (await res.json()) as { trackers?: TrackerInfo[] };
      const trackers = data.trackers ?? [];
      set((state) => {
        const infoByTracker = { ...state.infoByTracker };
        for (const t of trackers) infoByTracker[t.id] = t;
        // Keep the active sub-tab valid if the configured set changed.
        const activeTracker = trackers.some((t) => t.id === state.activeTracker)
          ? state.activeTracker
          : (trackers[0]?.id ?? "linear");
        return { trackers, infoByTracker, activeTracker };
      });
    } catch (err) {
      console.error("[issues-store] fetchTrackers failed:", err);
    }
  },

  fetchIssues: async (trackerId) => {
    const id = trackerId ?? get().activeTracker;
    set({ loading: true, error: null });
    try {
      const res = await fetch(`/api/issues?tracker=${encodeURIComponent(id)}`, {
        headers: { Accept: "application/json" },
      });
      const body = (await res.json().catch(() => ({}))) as Partial<ListIssuesResult> & { error?: string };
      if (!res.ok) {
        set({ loading: false, error: body.error ?? `Failed to load issues (${res.status})` });
        return;
      }
      set((state) => ({
        loading: false,
        error: null,
        issuesByTracker: { ...state.issuesByTracker, [id]: body.issues ?? [] },
        infoByTracker: body.tracker
          ? { ...state.infoByTracker, [id]: body.tracker }
          : state.infoByTracker,
      }));
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  startSession: async (issue, repoUrl) => {
    set((state) => ({ startingIds: new Set(state.startingIds).add(issue.id) }));
    try {
      const activeTracker = get().activeTracker;
      const res = await fetch("/api/sessions/headless", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          repoUrl,
          issueRef: {
            tracker: activeTracker,
            identifier: issue.identifier,
            title: issue.title,
            url: issue.url,
            ...(issue.description ? { description: issue.description } : {}),
          },
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; sessionId?: string };
      if (!res.ok || !body.sessionId) {
        set({ error: body.error ?? `Failed to start session (${res.status})` });
        return null;
      }
      return body.sessionId;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    } finally {
      set((state) => {
        const next = new Set(state.startingIds);
        next.delete(issue.id);
        return { startingIds: next };
      });
    }
  },

  reset: () =>
    set({
      issuesByTracker: {},
      loading: false,
      error: null,
      startingIds: new Set(),
    }),
}));
