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

type IssueStatusRef = NonNullable<TrackerIssue["status"]>;
import {
  UNASSIGNED,
  distinctAssignees,
  distinctLabels,
  distinctStatuses,
  type IssueFilters,
} from "../components/issues-filter.js";
import type { SortPrefs } from "../components/issues-sort.js";
import {
  getSavedIncludeDone,
  getSavedIssueCollapsed,
  getSavedIssueFilters,
  getSavedSortPrefs,
  saveIncludeDone,
  saveIssueCollapsed,
  saveIssueFilters,
  saveSortPrefs,
} from "../utils/local-storage.js";
import { useSessionStore } from "./session-store.js";
import { useUiStore } from "./ui-store.js";
import type { TrackerDestination } from "../../server/shared/declared-tracker.js";
import {
  resolveIssueRef,
  type IssueRefResolution,
} from "../../server/shared/issue-ref-resolution.js";

function sessionIdParam(): string {
  const id = useSessionStore.getState().sessionId;
  return id ? `sessionId=${encodeURIComponent(id)}` : "";
}

/**
 * docs/248 — the reference-resolution context, derived from the tracker list the
 * store already fetched for the sub-tabs. The browser never sees `shipit.yaml`,
 * so this list IS its view of the declarations: `TrackerInfo` carries the
 * declared `name`, the destination `id`, the backend `kind`, and the backend's
 * own identity in `binding.key` — everything `resolveIssueRef` matches on. That
 * is why the resolver reads from here rather than adding a second fetch.
 */
export function trackerDestinations(): TrackerDestination[] {
  return toTrackerDestinations(useIssuesStore.getState().trackers);
}

/**
 * The same projection, over a tracker list the caller already holds. Split out
 * for the one resolver that runs at **render** time rather than in a click
 * handler — the inline `IssueBadge` (docs/207, planning#325), which subscribes to the
 * store's `trackers` array and must derive its destinations inside a `useMemo`.
 * Calling {@link trackerDestinations} from a zustand selector would mint a new
 * array on every store read and defeat the snapshot cache.
 */
export function toTrackerDestinations(trackers: TrackerInfo[]): TrackerDestination[] {
  return trackers.map((t) => ({
    id: t.id,
    kind: t.kind,
    ...(t.name ? { name: t.name } : {}),
    ...(t.binding?.key ? { key: t.binding.key } : {}),
  }));
}

function declarationSignature(trackers: TrackerInfo[]): string {
  return JSON.stringify(
    trackers.map((t) => [t.id, t.kind, t.name ?? null, t.binding?.key ?? null, t.configured]),
  );
}

export function resolveUiIssueRef(pointer: string): IssueRefResolution {
  return resolveIssueRef(pointer, trackerDestinations());
}

export function issueLookupId(identifier: string): string {
  const hash = identifier.indexOf("#");
  return hash === -1 ? identifier : identifier.slice(hash + 1);
}

export interface IssueSelection {
  tracker: TrackerId;

  id: string;

  identifier: string;
  title?: string;
  url?: string;

  anchorCommentId?: string;
}

export interface OpenIssueRef {
  tracker: TrackerId;

  id?: string;
  identifier: string;
  title?: string;
  url?: string;

  seed?: TrackerIssue;

  anchorCommentId?: string;
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

  trackers: TrackerInfo[];

  repoScope: string | null;

  declarationsPending: boolean;
  activeTracker: TrackerId;
  issuesByTracker: Record<string, TrackerIssue[]>;

  infoByTracker: Record<string, TrackerInfo>;

  statusesByTracker: Record<string, IssueStatusRef[]>;

  labelsByTracker: Record<string, IssueLabel[]>;
  loading: boolean;
  error: string | null;

  filters: IssueFilters;

  includeDone: boolean;

  /**
   * User-defined two-level sort + group prefs for the list (docs/206). Applied
   * client-side over the already-loaded set (the server's order is just a
   * default), so changing the sort never refetches. Persisted globally.
   */
  sortPrefs: SortPrefs;

  collapseById: Record<string, boolean>;

  listScrollTop: number;

  selected: IssueSelection | null;
  detail: TrackerIssue | null;
  detailLoading: boolean;
  detailError: string | null;

  comments: TrackerComment[] | null;
  commentsLoading: boolean;
  commentsError: string | null;

  setActiveTracker: (id: TrackerId) => void;
  /**
   * Point the store at the repository the active session belongs to (planning#327).
   * A no-op while the repository is unchanged — switching between two sessions
   * of the same repository keeps the open issue and the loaded lists, which are
   * still valid there. On a *change* it drops everything scoped to the previous
   * repository, including the declared-tracker list itself: what the incoming
   * repository declares is unknown until `fetchTrackers` lands, and docs/248
   * req 11 says an undeclared destination fails closed, so the honest render for
   * that window is "nothing declared yet" rather than the previous repository's
   * trackers and its open issue.
   *
   * This is the *synchronous* half of the rule, and it exists for the window
   * alone: {@link IssuesState.fetchTrackers} is the authoritative check, but it
   * costs a round-trip, and leaving the previous repository's issue rendered
   * across it is the bug in miniature. `fetchTrackers` remains load-bearing for
   * what this can't see — the declared set is read from the session's own
   * workspace, so two sessions on one repository can differ (a branch that
   * edits `shipit.yaml`), and an edit changes it with no switch at all.
   */
  setRepoScope: (repoUrl: string | null) => void;

  fetchTrackers: () => Promise<boolean>;
  /**
   * `fetchTrackers`, plus a bounded background retry for as long as the server
   * reports the declarations aren't readable yet
   * ({@link IssuesState.declarationsPending}). Resolves on the first answer, so
   * it substitutes for `fetchTrackers` at every call site without adding a wait.
   *
   * This is what the session-change warm-up calls instead of a bare
   * `fetchTrackers`: one shot lands in the window where a disk-evicted session
   * is still being re-cloned, and the empty answer it gets is then cached until
   * the user opens the Issues tab. Only a *pending* answer retries — a
   * repository that genuinely declares nothing answers once and never loops.
   */
  warmTrackers: () => Promise<void>;
  fetchIssues: (trackerId?: TrackerId) => Promise<void>;

  fetchLabels: (trackerId?: TrackerId) => Promise<void>;

  openIssue: (ref: OpenIssueRef) => Promise<void>;

  fetchDetail: () => Promise<void>;

  fetchComments: () => Promise<void>;

  clearAnchorComment: () => void;

  postComment: (body: string) => Promise<string | null>;
  /**
   * Set an issue's status (docs/191). Patches the row + open detail in place on
   * success. Returns an error message on failure, or null on success. `tracker`
   * is passed explicitly because a `TrackerIssue` doesn't carry its tracker id.
   */
  setIssueStatus: (tracker: TrackerId, issue: TrackerIssue, status: string) => Promise<string | null>;

  setIssuePriority: (
    tracker: TrackerId,
    issue: TrackerIssue,
    level: IssuePriorityLevel,
  ) => Promise<string | null>;

  setIssueLabels: (
    tracker: TrackerId,
    issue: TrackerIssue,
    labels: string[],
  ) => Promise<string | null>;

  closeIssue: () => void;

  setListScrollTop: (top: number) => void;
  setQuery: (query: string) => void;
  togglePriority: (level: IssuePriorityLevel) => void;
  toggleStatus: (name: string) => void;
  toggleAssignee: (value: string) => void;
  toggleLabel: (name: string) => void;
  toggleIncludeDone: () => void;

  setSortPrefs: (prefs: SortPrefs) => void;

  setCollapsed: (issueId: string, collapsed: boolean) => void;
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

function closedDetail() {
  return {
    selected: null,
    detail: null,
    detailLoading: false,
    detailError: null,
    comments: null,
    commentsLoading: false,
    commentsError: null,
  } as const;
}

function clearedRepoState() {
  return {

    declarationsPending: false,
    issuesByTracker: {},
    statusesByTracker: {},
    labelsByTracker: {},
    loading: false,
    error: null,
    filters: emptyFilters(),
    listScrollTop: 0,
    ...closedDetail(),
  };
}

function destinationKey(t: TrackerInfo): string {
  return `${t.kind ?? ""}:${t.binding?.key ?? ""}`;
}

function pickReachable<T>(record: Record<string, T>, reachable: Set<string>): Record<string, T> {
  const keys = Object.keys(record);
  if (keys.every((k) => reachable.has(k))) return record;
  return Object.fromEntries(keys.filter((k) => reachable.has(k)).map((k) => [k, record[k]]));
}

function toggleInSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

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

const WARM_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000];

let warmGeneration = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function declarationScope(get: () => IssuesState): string {
  return `${useSessionStore.getState().sessionId ?? ""} ${get().repoScope ?? ""}`;
}

async function retryUntilReadable(get: () => IssuesState, generation: number): Promise<void> {
  const startedFor = useSessionStore.getState().sessionId;
  let changed = false;
  for (const delayMs of WARM_RETRY_DELAYS_MS) {
    await sleep(delayMs);
    if (generation !== warmGeneration) return;
    if (useSessionStore.getState().sessionId !== startedFor) return;
    changed = await get().fetchTrackers();
    if (!get().declarationsPending) break;
  }
  if (changed && useUiStore.getState().rightTab === "issues") {
    await get().fetchIssues();
  }
}

export const useIssuesStore = create<IssuesState>((set, get) => ({
  trackers: [],
  repoScope: null,
  declarationsPending: false,

  activeTracker: "github",
  issuesByTracker: {},
  infoByTracker: {},
  statusesByTracker: {},
  labelsByTracker: {},
  loading: false,
  error: null,

  filters: getSavedIssueFilters(),
  includeDone: getSavedIncludeDone(),
  sortPrefs: getSavedSortPrefs(),
  collapseById: getSavedIssueCollapsed(),
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

      filters: pruneFilters(state.filters, state.issuesByTracker[id] ?? []),
    })),

  setRepoScope: (repoUrl) =>
    set((state) =>
      state.repoScope === repoUrl
        ? state
        : {
            repoScope: repoUrl,

            trackers: [],
            infoByTracker: {},
            ...clearedRepoState(),

            loading: true,
          },
    ),

  fetchTrackers: async () => {
    try {
      const requestedFor = declarationScope(get);
      const params = sessionIdParam();
      const res = await fetch(`/api/trackers${params ? `?${params}` : ""}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return false;
      const data = (await res.json()) as {
        trackers?: TrackerInfo[];
        declarationsPending?: boolean;
      };

      if (declarationScope(get) !== requestedFor) return false;
      const trackers = data.trackers ?? [];
      const declarationsPending = data.declarationsPending === true;
      const changed = declarationSignature(get().trackers) !== declarationSignature(trackers);
      set((state) => {

        const reachable = new Set(
          trackers
            .filter((t) => {
              const prev = state.infoByTracker[t.id];
              return !prev || destinationKey(prev) === destinationKey(t);
            })
            .map((t) => t.id),
        );
        const infoByTracker = { ...pickReachable(state.infoByTracker, reachable) };
        for (const t of trackers) infoByTracker[t.id] = t;

        const activeTracker = trackers.some((t) => t.id === state.activeTracker)
          ? state.activeTracker
          : (trackers[0]?.id ?? "github");
        return {
          trackers,
          declarationsPending,
          infoByTracker,
          activeTracker,

          issuesByTracker: pickReachable(state.issuesByTracker, reachable),
          statusesByTracker: pickReachable(state.statusesByTracker, reachable),
          labelsByTracker: pickReachable(state.labelsByTracker, reachable),

          ...(state.selected && !reachable.has(state.selected.tracker) ? closedDetail() : {}),
        };
      });
      return changed;
    } catch (err) {
      console.error("[issues-store] fetchTrackers failed:", err);
      return false;
    }
  },

  warmTrackers: async () => {
    const generation = ++warmGeneration;
    await get().fetchTrackers();

    if (get().declarationsPending) void retryUntilReadable(get, generation);
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

        const filters = id === state.activeTracker ? pruneFilters(state.filters, issues) : state.filters;
        return {
          loading: false,
          error: null,
          filters,
          issuesByTracker: { ...state.issuesByTracker, [id]: issues },
          infoByTracker: body.tracker
            ? { ...state.infoByTracker, [id]: body.tracker }
            : state.infoByTracker,

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

      activeTracker: ref.tracker,
      selected: {
        tracker: ref.tracker,
        id,
        identifier: ref.identifier,
        ...(ref.title !== undefined ? { title: ref.title } : {}),
        ...(ref.url !== undefined ? { url: ref.url } : {}),
        ...(ref.anchorCommentId !== undefined ? { anchorCommentId: ref.anchorCommentId } : {}),
      },

      detail: ref.seed ?? null,
      detailError: null,
      detailLoading: true,

      comments: null,
      commentsError: null,
      commentsLoading: true,
      filters: pruneFilters(state.filters, state.issuesByTracker[ref.tracker] ?? []),
    }));

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

  clearAnchorComment: () =>
    set((state) =>
      state.selected?.anchorCommentId
        ? { selected: { ...state.selected, anchorCommentId: undefined } }
        : state,
    ),

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

  closeIssue: () => set(closedDetail()),

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

    void get().fetchIssues();
  },

  setSortPrefs: (prefs) => set({ sortPrefs: prefs }),

  setCollapsed: (issueId, collapsed) =>
    set((state) => ({ collapseById: { ...state.collapseById, [issueId]: collapsed } })),

  clearFilters: () => set({ filters: emptyFilters() }),

  reset: () => set(clearedRepoState()),
}));

async function applyIssueMutation(
  endpoint: string,
  tracker: TrackerId,
  issue: TrackerIssue,

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

useIssuesStore.subscribe((state, prev) => {
  if (state.filters !== prev.filters) saveIssueFilters(state.filters);

  if (state.sortPrefs !== prev.sortPrefs) saveSortPrefs(state.sortPrefs);
  if (state.collapseById !== prev.collapseById) saveIssueCollapsed(state.collapseById);
});
