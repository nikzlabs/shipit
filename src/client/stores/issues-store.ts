import { create } from "zustand";
import type {
  IssuePriorityLevel,
  ListIssuesResult,
  TrackerId,
  TrackerInfo,
  TrackerIssue,
} from "../../server/shared/types.js";
import {
  UNASSIGNED,
  distinctAssignees,
  distinctStatuses,
  type IssueFilters,
} from "../components/issues-filter.js";
import {
  getSavedIncludeDone,
  getSavedIssueFilters,
  saveIncludeDone,
  saveIssueFilters,
} from "../utils/local-storage.js";

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

  /**
   * Client-side list filters (docs/173). `query` + `priorities` are
   * normalized/universal so they persist across sub-tab switches; `statuses` +
   * `assignees` are freeform per-tracker values, pruned to the active list on
   * tracker switch / after a fetch (the `UNASSIGNED` sentinel always survives).
   */
  filters: IssueFilters;

  /**
   * Whether the fetched list includes "done"/completed issues. Unlike the
   * `filters` facets (which narrow the already-loaded list client-side), this is
   * a fetch-scope control: toggling it re-fetches with `&includeDone` so the
   * server widens the state set it returns. Persisted across reloads.
   */
  includeDone: boolean;

  setActiveTracker: (id: TrackerId) => void;
  fetchTrackers: () => Promise<void>;
  fetchIssues: (trackerId?: TrackerId) => Promise<void>;
  setQuery: (query: string) => void;
  togglePriority: (level: IssuePriorityLevel) => void;
  toggleStatus: (name: string) => void;
  toggleAssignee: (value: string) => void;
  toggleIncludeDone: () => void;
  clearFilters: () => void;
  reset: () => void;
}

function emptyFilters(): IssueFilters {
  return { query: "", priorities: new Set(), statuses: new Set(), assignees: new Set() };
}

function toggleInSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/**
 * Prune freeform status/assignee selections to the values present in the given
 * list. The `UNASSIGNED` sentinel is preserved unconditionally — it's a
 * synthetic option that isn't enumerated by the tracker.
 */
function pruneFilters(filters: IssueFilters, issues: TrackerIssue[]): IssueFilters {
  const validStatuses = new Set(distinctStatuses(issues).map((s) => s.name));
  const validAssignees = new Set(distinctAssignees(issues).map((a) => a.value));
  return {
    query: filters.query,
    priorities: filters.priorities,
    statuses: new Set([...filters.statuses].filter((s) => validStatuses.has(s))),
    assignees: new Set(
      [...filters.assignees].filter((a) => a === UNASSIGNED || validAssignees.has(a)),
    ),
  };
}

export const useIssuesStore = create<IssuesState>((set, get) => ({
  trackers: [],
  activeTracker: "linear",
  issuesByTracker: {},
  infoByTracker: {},
  loading: false,
  error: null,
  // Rehydrate the filter bar from the last reload (docs/173). Freeform
  // status/assignee values are pruned to the loaded list by the first
  // fetchIssues, so restoring before any fetch is safe.
  filters: getSavedIssueFilters(),
  includeDone: getSavedIncludeDone(),

  setActiveTracker: (id) =>
    set((state) => ({
      activeTracker: id,
      // Prune freeform facets against the newly-active list (it may be empty
      // until fetchIssues lands, which prunes again with fresh data).
      filters: pruneFilters(state.filters, state.issuesByTracker[id] ?? []),
    })),

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
      const includeDone = get().includeDone ? "&includeDone=true" : "";
      const res = await fetch(`/api/issues?tracker=${encodeURIComponent(id)}${includeDone}`, {
        headers: { Accept: "application/json" },
      });
      const body = (await res.json().catch(() => ({}))) as Partial<ListIssuesResult> & { error?: string };
      if (!res.ok) {
        set({ loading: false, error: body.error ?? `Failed to load issues (${res.status})` });
        return;
      }
      set((state) => {
        const issues = body.issues ?? [];
        // Only re-prune when the freshly-loaded list belongs to the active
        // sub-tab — a background fetch for another tracker shouldn't disturb
        // the facets the user is currently looking at.
        const filters = id === state.activeTracker ? pruneFilters(state.filters, issues) : state.filters;
        return {
          loading: false,
          error: null,
          filters,
          issuesByTracker: { ...state.issuesByTracker, [id]: issues },
          infoByTracker: body.tracker
            ? { ...state.infoByTracker, [id]: body.tracker }
            : state.infoByTracker,
        };
      });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  setQuery: (query) => set((state) => ({ filters: { ...state.filters, query } })),

  togglePriority: (level) =>
    set((state) => ({
      filters: { ...state.filters, priorities: toggleInSet(state.filters.priorities, level) },
    })),

  toggleStatus: (name) =>
    set((state) => ({
      filters: { ...state.filters, statuses: toggleInSet(state.filters.statuses, name) },
    })),

  toggleAssignee: (value) =>
    set((state) => ({
      filters: { ...state.filters, assignees: toggleInSet(state.filters.assignees, value) },
    })),

  toggleIncludeDone: () => {
    const next = !get().includeDone;
    saveIncludeDone(next);
    set({ includeDone: next });
    // Re-fetch the active tracker so the widened/narrowed state set lands.
    void get().fetchIssues();
  },

  clearFilters: () => set({ filters: emptyFilters() }),

  reset: () =>
    set({
      issuesByTracker: {},
      loading: false,
      error: null,
      filters: emptyFilters(),
    }),
}));

// Persist the filter bar across reloads (docs/173). A single subscription
// covers every mutation point — direct edits (setQuery/toggle*/clearFilters)
// and the prune that runs inside setActiveTracker/fetchIssues — so no action
// has to remember to save.
useIssuesStore.subscribe((state, prev) => {
  if (state.filters !== prev.filters) saveIssueFilters(state.filters);
});
