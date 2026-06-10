import { create } from "zustand";
import type {
  GetIssueResult,
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
import { useSessionStore } from "./session-store.js";

/**
 * The GitHub tracker is per-repo, so its issues are scoped to the active
 * session's remote (docs/170, SHI-80). We pass the current session id on the
 * tracker/issue fetches; the server resolves it to a `{owner, repo}` binding.
 * Linear ignores it. Returns a `sessionId=…` pair, or "" when no session.
 */
function sessionIdParam(): string {
  const id = useSessionStore.getState().sessionId;
  return id ? `sessionId=${encodeURIComponent(id)}` : "";
}

/**
 * GitHub identifiers are `owner/repo#123`; the tracker-native lookup id the
 * detail fetch wants is the bare number after `#`. Linear identifiers (`SHI-1`,
 * no `#`) ARE the lookup id, so they pass through unchanged. Mirrors the
 * server's `parseIssueRef`, kept here so a card (which only carries the display
 * identifier) can open the detail view without a round-trip to resolve the id.
 */
export function issueLookupId(identifier: string): string {
  const hash = identifier.indexOf("#");
  return hash === -1 ? identifier : identifier.slice(hash + 1);
}

/**
 * The issue currently open in the inline detail view (docs/189). Carries the
 * tracker-native lookup `id` plus the display fields a caller already has (from
 * a list row or a chat card) so the header can render instantly while the
 * fully-hydrated issue is fetched.
 */
export interface IssueSelection {
  tracker: TrackerId;
  /** Tracker-native lookup id: a Linear key/UUID or a bare GitHub number. */
  id: string;
  /** Display identifier, e.g. "SHI-28" or "owner/repo#42". */
  identifier: string;
  title?: string;
  url?: string;
}

/** Argument to {@link IssuesState.openIssue} — from a list row or a chat card. */
export interface OpenIssueRef {
  tracker: TrackerId;
  /** Native lookup id (the list row's `issue.id`); derived from `identifier`
   *  when absent (the chat-card path, which only knows the display id). */
  id?: string;
  identifier: string;
  title?: string;
  url?: string;
  /** Full issue to render instantly while the fresh fetch lands (list path). */
  seed?: TrackerIssue;
}

/**
 * Issues-tab store (docs/170). Per-tracker issue lists, fetched on tab open and
 * via a manual refresh button — no background poller in v1. Mirrors the
 * docs-list model (HTTP fetch + manual reload) rather than an SSE feed: the
 * issue list is repo/workspace-scoped reference data, not per-session stream.
 *
 * docs/189 adds the master-detail layer: `selected`/`detail` drive the inline
 * single-issue view that the list rows AND the agent's chat cards open, so a
 * user never leaves ShipIt to read an issue.
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

  /**
   * The issue open in the inline detail view, or null when the list is showing
   * (docs/189). `detail` is the fully-hydrated issue from `GET /api/issue`;
   * until it lands the view renders from `selected`'s seed fields.
   */
  selected: IssueSelection | null;
  detail: TrackerIssue | null;
  detailLoading: boolean;
  detailError: string | null;

  setActiveTracker: (id: TrackerId) => void;
  fetchTrackers: () => Promise<void>;
  fetchIssues: (trackerId?: TrackerId) => Promise<void>;
  /** Open the detail view for an issue (from a list row or a chat card). */
  openIssue: (ref: OpenIssueRef) => Promise<void>;
  /** Re-fetch the open issue (refresh button inside the detail view). */
  fetchDetail: () => Promise<void>;
  /** Close the detail view and return to the list. */
  closeIssue: () => void;
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
  selected: null,
  detail: null,
  detailLoading: false,
  detailError: null,

  setActiveTracker: (id) =>
    set((state) => ({
      activeTracker: id,
      // Prune freeform facets against the newly-active list (it may be empty
      // until fetchIssues lands, which prunes again with fresh data).
      filters: pruneFilters(state.filters, state.issuesByTracker[id] ?? []),
    })),

  fetchTrackers: async () => {
    try {
      const params = sessionIdParam();
      const res = await fetch(`/api/trackers${params ? `?${params}` : ""}`, {
        headers: { Accept: "application/json" },
      });
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
      const params = sessionIdParam();
      const res = await fetch(
        `/api/issues?tracker=${encodeURIComponent(id)}${includeDone}${params ? `&${params}` : ""}`,
        {
          headers: { Accept: "application/json" },
        },
      );
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

  openIssue: async (ref) => {
    const id = ref.id ?? issueLookupId(ref.identifier);
    set((state) => ({
      // Align the list's sub-tab with the issue being opened so the back
      // button lands on the matching tracker.
      activeTracker: ref.tracker,
      selected: {
        tracker: ref.tracker,
        id,
        identifier: ref.identifier,
        ...(ref.title !== undefined ? { title: ref.title } : {}),
        ...(ref.url !== undefined ? { url: ref.url } : {}),
      },
      // Seed from the row/card so the view paints immediately; the fetch then
      // hydrates the description + availableStatuses.
      detail: ref.seed ?? null,
      detailError: null,
      detailLoading: true,
      filters: pruneFilters(state.filters, state.issuesByTracker[ref.tracker] ?? []),
    }));
    await get().fetchDetail();
  },

  fetchDetail: async () => {
    const sel = get().selected;
    if (!sel) return;
    set({ detailLoading: true, detailError: null });
    try {
      const params = sessionIdParam();
      const res = await fetch(
        `/api/issue?tracker=${encodeURIComponent(sel.tracker)}&id=${encodeURIComponent(sel.id)}${params ? `&${params}` : ""}`,
        { headers: { Accept: "application/json" } },
      );
      const body = (await res.json().catch(() => ({}))) as Partial<GetIssueResult> & { error?: string };
      // Drop a stale response: a newer openIssue may have superseded this fetch
      // while it was in flight (a fast click from one card to another).
      const current = get().selected;
      if (current?.id !== sel.id || current?.tracker !== sel.tracker) return;
      if (!res.ok || !body.issue) {
        set({ detailLoading: false, detailError: body.error ?? `Failed to load issue (${res.status})` });
        return;
      }
      set({ detailLoading: false, detail: body.issue, detailError: null });
    } catch (err) {
      const current = get().selected;
      if (current?.id !== sel.id || current?.tracker !== sel.tracker) return;
      set({ detailLoading: false, detailError: err instanceof Error ? err.message : String(err) });
    }
  },

  closeIssue: () => set({ selected: null, detail: null, detailError: null, detailLoading: false }),

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
      selected: null,
      detail: null,
      detailLoading: false,
      detailError: null,
    }),
}));

// Persist the filter bar across reloads (docs/173). A single subscription
// covers every mutation point — direct edits (setQuery/toggle*/clearFilters)
// and the prune that runs inside setActiveTracker/fetchIssues — so no action
// has to remember to save.
useIssuesStore.subscribe((state, prev) => {
  if (state.filters !== prev.filters) saveIssueFilters(state.filters);
});
