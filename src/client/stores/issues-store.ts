import { create } from "zustand";
import type {
  GetIssueResult,
  IssueLabel,
  IssuePriorityLevel,
  ListIssuesResult,
  ListIssueCommentsResult,
  ListLabelsResult,
  MutateIssueResult,
  PostIssueCommentResult,
  TrackerComment,
  TrackerId,
  TrackerInfo,
  TrackerIssue,
} from "../../server/shared/types.js";

/** A tracker status option — the non-null shape of {@link TrackerIssue.status}. */
type IssueStatusRef = NonNullable<TrackerIssue["status"]>;
import {
  UNASSIGNED,
  distinctAssignees,
  distinctLabels,
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
  /**
   * Per-tracker assignable statuses (docs/191) — the tracker's full workflow
   * states (Linear team states / GitHub Open·Closed), refreshed alongside the
   * list. Drives the inline status editor's option menu on the list rows, which
   * (unlike the detail view's `availableStatuses`) have no per-issue option set.
   */
  statusesByTracker: Record<string, IssueStatusRef[]>;
  /**
   * Per-tracker available label set (name + color), fetched lazily and cached —
   * mirrors `statusesByTracker`. The foundation a follow-up label filter facet /
   * on-page editor consumes (the read-only available-labels endpoint). Distinct
   * from the per-issue `TrackerIssue.labels`: this is the whole pickable set.
   */
  labelsByTracker: Record<string, IssueLabel[]>;
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
   * Scroll offset of the list's scroll container, persisted so opening an issue
   * and pressing back lands on the same row the user left (docs/189). The list
   * component fully unmounts behind the detail view, so its DOM `scrollTop` is
   * gone on return — we stash it here on unmount and restore it on remount.
   */
  listScrollTop: number;

  /**
   * The issue open in the inline detail view, or null when the list is showing
   * (docs/189). `detail` is the fully-hydrated issue from `GET /api/issue`;
   * until it lands the view renders from `selected`'s seed fields.
   */
  selected: IssueSelection | null;
  detail: TrackerIssue | null;
  detailLoading: boolean;
  detailError: string | null;

  /**
   * The open issue's comment thread (docs/189 follow-up). `null` means "not
   * fetched yet" (the view shows a loading hint), distinct from `[]` ("no
   * comments"). Fetched alongside the detail when an issue opens, independently
   * so the description paints without waiting on the thread.
   */
  comments: TrackerComment[] | null;
  commentsLoading: boolean;
  commentsError: string | null;

  setActiveTracker: (id: TrackerId) => void;
  fetchTrackers: () => Promise<void>;
  fetchIssues: (trackerId?: TrackerId) => Promise<void>;
  /**
   * Fetch + cache the tracker's full available-label set (name + color). Lazy:
   * a follow-up label filter/editor calls it when it needs the pickable set;
   * the issue list itself gets colors inline on each `TrackerIssue.labels`.
   */
  fetchLabels: (trackerId?: TrackerId) => Promise<void>;
  /** Open the detail view for an issue (from a list row or a chat card). */
  openIssue: (ref: OpenIssueRef) => Promise<void>;
  /** Re-fetch the open issue (refresh button inside the detail view). */
  fetchDetail: () => Promise<void>;
  /** Fetch the open issue's comment thread. */
  fetchComments: () => Promise<void>;
  /**
   * Post a user-authored comment on the open issue. Appends the created comment
   * to the thread on success. Returns an error message on failure, or null on
   * success (so the calling component can surface it inline).
   */
  postComment: (body: string) => Promise<string | null>;
  /**
   * Set an issue's status (docs/191). Patches the row + open detail in place on
   * success. Returns an error message on failure, or null on success. `tracker`
   * is passed explicitly because a `TrackerIssue` doesn't carry its tracker id.
   */
  setIssueStatus: (tracker: TrackerId, issue: TrackerIssue, status: string) => Promise<string | null>;
  /** Set an issue's priority (Linear-only, docs/191). Same contract as status. */
  setIssuePriority: (
    tracker: TrackerId,
    issue: TrackerIssue,
    level: IssuePriorityLevel,
  ) => Promise<string | null>;
  /**
   * Replace an issue's full label set (the on-page label editor). `labels` is
   * the COMPLETE desired set of names — a wholesale replace, not a delta — so a
   * removal is just a name left out and `[]` clears all labels. Patches the row
   * + open detail in place on success. Both trackers support labels, so (unlike
   * priority) this isn't gated. Returns an error message, or null on success.
   */
  setIssueLabels: (
    tracker: TrackerId,
    issue: TrackerIssue,
    labels: string[],
  ) => Promise<string | null>;
  /** Close the detail view and return to the list. */
  closeIssue: () => void;
  /** Stash the list's scroll offset so a later remount can restore it. */
  setListScrollTop: (top: number) => void;
  setQuery: (query: string) => void;
  togglePriority: (level: IssuePriorityLevel) => void;
  toggleStatus: (name: string) => void;
  toggleAssignee: (value: string) => void;
  toggleLabel: (name: string) => void;
  toggleIncludeDone: () => void;
  clearFilters: () => void;
  reset: () => void;
}

function emptyFilters(): IssueFilters {
  return {
    query: "",
    priorities: new Set(),
    statuses: new Set(),
    assignees: new Set(),
    labels: new Set(),
  };
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
  const validLabels = new Set(distinctLabels(issues).map((l) => l.name));
  return {
    query: filters.query,
    priorities: filters.priorities,
    statuses: new Set([...filters.statuses].filter((s) => validStatuses.has(s))),
    assignees: new Set(
      [...filters.assignees].filter((a) => a === UNASSIGNED || validAssignees.has(a)),
    ),
    labels: new Set([...filters.labels].filter((l) => validLabels.has(l))),
  };
}

export const useIssuesStore = create<IssuesState>((set, get) => ({
  trackers: [],
  activeTracker: "linear",
  issuesByTracker: {},
  infoByTracker: {},
  statusesByTracker: {},
  labelsByTracker: {},
  loading: false,
  error: null,
  // Rehydrate the filter bar from the last reload (docs/173). Freeform
  // status/assignee values are pruned to the loaded list by the first
  // fetchIssues, so restoring before any fetch is safe.
  filters: getSavedIssueFilters(),
  includeDone: getSavedIncludeDone(),
  listScrollTop: 0,
  selected: null,
  detail: null,
  detailLoading: false,
  detailError: null,
  comments: null,
  commentsLoading: false,
  commentsError: null,

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
          // Cache the tracker's assignable statuses for the inline status editor
          // (docs/191). Only overwrite when the response carried them so a
          // best-effort omission doesn't blank a previously-loaded set.
          statusesByTracker: body.availableStatuses
            ? { ...state.statusesByTracker, [id]: body.availableStatuses }
            : state.statusesByTracker,
        };
      });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  fetchLabels: async (trackerId) => {
    const id = trackerId ?? get().activeTracker;
    try {
      const params = sessionIdParam();
      const res = await fetch(
        `/api/issue/labels?tracker=${encodeURIComponent(id)}${params ? `&${params}` : ""}`,
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) return;
      const body = (await res.json().catch(() => ({}))) as Partial<ListLabelsResult>;
      const labels = body.labels ?? [];
      set((state) => ({ labelsByTracker: { ...state.labelsByTracker, [id]: labels } }));
    } catch (err) {
      console.error("[issues-store] fetchLabels failed:", err);
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
      // Reset the thread for the newly-opened issue; fetchComments repopulates.
      comments: null,
      commentsError: null,
      commentsLoading: true,
      filters: pruneFilters(state.filters, state.issuesByTracker[ref.tracker] ?? []),
    }));
    // Independent fetches — the description shouldn't wait on the thread.
    await Promise.all([get().fetchDetail(), get().fetchComments()]);
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

  fetchComments: async () => {
    const sel = get().selected;
    if (!sel) return;
    set({ commentsLoading: true, commentsError: null });
    try {
      const params = sessionIdParam();
      const res = await fetch(
        `/api/issue/comments?tracker=${encodeURIComponent(sel.tracker)}&id=${encodeURIComponent(sel.id)}${params ? `&${params}` : ""}`,
        { headers: { Accept: "application/json" } },
      );
      const body = (await res.json().catch(() => ({}))) as Partial<ListIssueCommentsResult> & { error?: string };
      // Drop a stale response superseded by a newer openIssue (fast card clicks).
      const current = get().selected;
      if (current?.id !== sel.id || current?.tracker !== sel.tracker) return;
      if (!res.ok) {
        set({ commentsLoading: false, commentsError: body.error ?? `Failed to load comments (${res.status})` });
        return;
      }
      set({ commentsLoading: false, comments: body.comments ?? [], commentsError: null });
    } catch (err) {
      const current = get().selected;
      if (current?.id !== sel.id || current?.tracker !== sel.tracker) return;
      set({ commentsLoading: false, commentsError: err instanceof Error ? err.message : String(err) });
    }
  },

  postComment: async (body) => {
    const sel = get().selected;
    if (!sel) return "No issue is open";
    const trimmed = body.trim();
    if (!trimmed) return "A comment can't be empty";
    try {
      const res = await fetch(`/api/issue/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          tracker: sel.tracker,
          id: sel.id,
          body: trimmed,
          ...(useSessionStore.getState().sessionId ? { sessionId: useSessionStore.getState().sessionId } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<PostIssueCommentResult> & { error?: string };
      if (!res.ok || !data.comment) {
        return data.error ?? `Failed to post comment (${res.status})`;
      }
      // Append to the open thread (guarding against a mid-flight issue switch).
      const comment = data.comment;
      const current = get().selected;
      if (current?.id === sel.id && current?.tracker === sel.tracker) {
        set((state) => ({ comments: [...(state.comments ?? []), comment] }));
      }
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  },

  setIssueStatus: (tracker, issue, status) =>
    applyIssueMutation("/api/issue/status", tracker, issue, { status }),

  setIssuePriority: (tracker, issue, level) =>
    applyIssueMutation("/api/issue/priority", tracker, issue, { priority: level }),

  setIssueLabels: (tracker, issue, labels) =>
    applyIssueMutation("/api/issue/labels", tracker, issue, { labels }),

  closeIssue: () =>
    set({
      selected: null,
      detail: null,
      detailError: null,
      detailLoading: false,
      comments: null,
      commentsError: null,
      commentsLoading: false,
    }),

  setListScrollTop: (top) => set({ listScrollTop: top }),

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

  toggleLabel: (name) =>
    set((state) => ({
      filters: { ...state.filters, labels: toggleInSet(state.filters.labels, name) },
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
      statusesByTracker: {},
      labelsByTracker: {},
      loading: false,
      error: null,
      filters: emptyFilters(),
      listScrollTop: 0,
      selected: null,
      detail: null,
      detailLoading: false,
      detailError: null,
      comments: null,
      commentsLoading: false,
      commentsError: null,
    }),
}));

/**
 * POST a user-initiated status/priority change (docs/191) and, on success, patch
 * the returned issue into the cached list row AND the open detail view in place
 * — no refetch. Matching is by `issue.id` (the tracker-native node id the row and
 * the hydrated detail share), so it survives a detail opened from a chat card
 * (whose `selected.id` may be a key rather than the node id). Returns an error
 * message on failure, or null on success, for the calling control to surface.
 */
async function applyIssueMutation(
  endpoint: string,
  tracker: TrackerId,
  issue: TrackerIssue,
  // `string` for status/priority; `string[]` for the wholesale label-set replace.
  payload: Record<string, string | string[]>,
): Promise<string | null> {
  try {
    const sessionId = useSessionStore.getState().sessionId;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ tracker, id: issue.id, ...payload, ...(sessionId ? { sessionId } : {}) }),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<MutateIssueResult> & { error?: string };
    if (!res.ok || !data.issue) {
      return data.error ?? `Request failed (${res.status})`;
    }
    const updated = data.issue;
    useIssuesStore.setState((state) => {
      const list = state.issuesByTracker[tracker];
      return {
        issuesByTracker: list
          ? { ...state.issuesByTracker, [tracker]: list.map((i) => (i.id === updated.id ? updated : i)) }
          : state.issuesByTracker,
        detail: state.detail?.id === updated.id ? updated : state.detail,
      };
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// Persist the filter bar across reloads (docs/173). A single subscription
// covers every mutation point — direct edits (setQuery/toggle*/clearFilters)
// and the prune that runs inside setActiveTracker/fetchIssues — so no action
// has to remember to save.
useIssuesStore.subscribe((state, prev) => {
  if (state.filters !== prev.filters) saveIssueFilters(state.filters);
});
