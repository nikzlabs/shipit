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
import type { TrackerDestination } from "../../server/shared/declared-tracker.js";
import {
  resolveIssueRef,
  type IssueRefResolution,
} from "../../server/shared/issue-ref-resolution.js";

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
 * handler — the inline `IssueBadge` (docs/207, SHI-323), which subscribes to the
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

/**
 * Signature of the declared-tracker view — everything the sub-tabs and
 * {@link trackerDestinations} read out of a `TrackerInfo`. `fetchTrackers`
 * compares it across a refresh so a caller can tell a real declaration change
 * from a no-op refresh (SHI-321): a `shipit.yaml` edit that touched
 * `agent.install` or the compose path re-reads the (cheap, local) tracker list
 * without also spending a tracker-API round-trip on the issue list.
 */
function declarationSignature(trackers: TrackerInfo[]): string {
  return JSON.stringify(
    trackers.map((t) => [t.id, t.kind, t.name ?? null, t.binding?.key ?? null, t.configured]),
  );
}

/**
 * docs/248 reqs 10/11 — resolve a reference the UI holds (a doc's `issue:`
 * frontmatter, a markdown href) against the declared destinations. Fails closed:
 * callers render an unresolvable reference legibly (plain text, or the external
 * link it already was) rather than an in-app link that would 404.
 */
export function resolveUiIssueRef(pointer: string): IssueRefResolution {
  return resolveIssueRef(pointer, trackerDestinations());
}

/**
 * GitHub identifiers are `owner/repo#123` (or `planning#123` once the repository
 * declares a name for that destination); the tracker-native lookup id the detail
 * fetch wants is the bare number after `#`. Linear identifiers (`SHI-1`, no `#`)
 * ARE the lookup id, so they pass through unchanged. Mirrors the server's
 * `parseIssueRef`, kept here so a card (which only carries the display
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
  /**
   * Tracker-native id of a comment to scroll to + highlight once the thread
   * lands (SHI-103). Set when an opener has a specific comment to land on — e.g.
   * clicking the provenance card for a comment the agent just posted. The detail
   * view consumes it (clears it via `clearAnchorComment`) after anchoring, so a
   * later refresh doesn't re-scroll.
   */
  anchorCommentId?: string;
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
  /** Comment to scroll to + highlight once the thread lands (SHI-103). */
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
  /** Configured-tracker metadata — drives the sub-tab switcher. */
  trackers: TrackerInfo[];
  /**
   * The repository whose declarations the store's contents belong to — the
   * active session's remote URL, or null when there is no repo context
   * (SHI-325). Declarations live in a repository's `shipit.yaml`, so a switch
   * to a session on a *different* repository invalidates everything here
   * before `fetchTrackers` can say what the new repository declares. See
   * {@link IssuesState.setRepoScope}.
   */
  repoScope: string | null;
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
   * User-defined two-level sort + group prefs for the list (docs/206). Applied
   * client-side over the already-loaded set (the server's order is just a
   * default), so changing the sort never refetches. Persisted globally.
   */
  sortPrefs: SortPrefs;

  /**
   * Explicit collapse overrides for parent issues (docs/206), keyed by
   * `TrackerIssue.id`: `true` = collapsed, `false` = expanded. An absent entry
   * means "untouched", so the layout default applies (expanded on the wide table,
   * collapsed on the narrow card layout — see `collapsePredicate`). Persisted
   * GLOBALLY (not per session or repo — neither is the issue list) so the tree
   * stays how the user left it across reloads.
   */
  collapseById: Record<string, boolean>;

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
  /**
   * Point the store at the repository the active session belongs to (SHI-325).
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
  /**
   * Re-read the declared-tracker view from `GET /api/trackers` (a local
   * `shipit.yaml` read server-side — no tracker API round-trip). Resolves to
   * whether the declared set actually changed, so a caller refreshing on a
   * `shipit.yaml` edit (SHI-321) can skip the far more expensive issue-list
   * fetch when the edit touched something else in the file.
   *
   * Also enforces docs/248 req 11 over what the store already holds: a
   * destination that is no longer declared is not reachable, so the open detail
   * closes back to the list and that tracker's cached list/statuses/labels are
   * dropped (SHI-325).
   */
  fetchTrackers: () => Promise<boolean>;
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
   * Clear the open selection's `anchorCommentId` after the detail view has
   * scrolled to it (SHI-103), so a later refresh/refetch doesn't re-anchor.
   */
  clearAnchorComment: () => void;
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
  /** Replace the sort/group prefs (from the sort modal). Persisted. */
  setSortPrefs: (prefs: SortPrefs) => void;
  /**
   * Record an explicit collapse/expand for a parent (docs/206). `collapsed` is
   * the new state; it's stored as an override so the layout default no longer
   * applies to this parent. Persisted.
   */
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

/** The closed-detail state — shared by `closeIssue` and the wider clears. */
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

/**
 * Everything the store holds *about one repository's issues*: the per-tracker
 * caches, the list chrome (loading/error/filters/scroll) and the open detail.
 * Backs both `reset()` and the repo-scope change, so the two can't drift.
 *
 * The caches are keyed by tracker id but their CONTENTS belong to the
 * destination that id named when they were fetched: the GitHub tracker resolves
 * against the active session's repo binding (`sessionIdParam`), so
 * `issuesByTracker["github"]` holds repo A's issues even though repo B declares
 * the same id. That's why a repo change clears all of them, while a declaration
 * refresh drops only the ids whose destination changed or went away (see
 * `destinationKey` / `pickReachable`).
 */
function clearedRepoState() {
  return {
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

/**
 * The destination a tracker id currently names, as the browser can see it: the
 * backend kind plus the backend's own identity for the binding (`owner/repo`,
 * a Linear team key). Two declarations of one id with different keys are two
 * different destinations, and nothing cached under that id crosses between them.
 * An absent binding is its own value — an unconfigured tracker reaches nothing.
 */
function destinationKey(t: TrackerInfo): string {
  return `${t.kind ?? ""}:${t.binding?.key ?? ""}`;
}

/**
 * The subset of a per-tracker cache whose ids are still reachable. Returns the
 * same object when nothing is dropped, so a no-op refresh doesn't re-render
 * every subscriber.
 */
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
  repoScope: null,
  // docs/248 — no built-in tracker, so there is no meaningful default until
  // `fetchTrackers` lands. The session's own repository is the one destination
  // that always exists when there is a repo at all, so it is the safe seed.
  activeTracker: "github",
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
      // Prune freeform facets against the newly-active list (it may be empty
      // until fetchIssues lands, which prunes again with fresh data).
      filters: pruneFilters(state.filters, state.issuesByTracker[id] ?? []),
    })),

  setRepoScope: (repoUrl) =>
    set((state) =>
      state.repoScope === repoUrl
        ? state
        : {
            repoScope: repoUrl,
            // The incoming repository's declarations are unknown until
            // `fetchTrackers` lands; fail closed rather than rendering the
            // previous repository's trackers (and its open issue) meanwhile.
            trackers: [],
            infoByTracker: {},
            ...clearedRepoState(),
            // A tracker fetch always follows a scope change (`App` fires one on
            // every session change), so the panel renders "loading" for the gap
            // rather than the misleading "not connected" that an empty tracker
            // list would otherwise produce. Cleared by the `fetchIssues` that
            // follows when the tab is open.
            loading: true,
          },
    ),

  fetchTrackers: async () => {
    try {
      const params = sessionIdParam();
      const res = await fetch(`/api/trackers${params ? `?${params}` : ""}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { trackers?: TrackerInfo[] };
      const trackers = data.trackers ?? [];
      const changed = declarationSignature(get().trackers) !== declarationSignature(trackers);
      set((state) => {
        // docs/248 req 11 (SHI-325) — what the store holds for a tracker id
        // survives only while that id still names the destination it was
        // fetched from. Presence of the id is NOT enough: the session's own
        // repository's GitHub Issues live under the bare `github` id (req 12),
        // so that id is declared by every repository while pointing at a
        // different destination in each — an issue opened in repo A would
        // otherwise stay open, and refresh, against repo B's issue of the same
        // number. A declared `name` re-pointed at another team/repo is the same
        // case. Comparing the binding is what distinguishes them.
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
        // Keep the active sub-tab valid if the configured set changed.
        const activeTracker = trackers.some((t) => t.id === state.activeTracker)
          ? state.activeTracker
          : (trackers[0]?.id ?? "github");
        return {
          trackers,
          infoByTracker,
          activeTracker,
          // Only the unreachable entries go: a tracker that still names the
          // same destination is still reachable and its cache is still valid.
          issuesByTracker: pickReachable(state.issuesByTracker, reachable),
          statusesByTracker: pickReachable(state.statusesByTracker, reachable),
          labelsByTracker: pickReachable(state.labelsByTracker, reachable),
          // Close the open detail when its destination is gone — the list, in
          // its default state, is what the Issues tab falls back to.
          ...(state.selected && !reachable.has(state.selected.tracker) ? closedDetail() : {}),
        };
      });
      return changed;
    } catch (err) {
      console.error("[issues-store] fetchTrackers failed:", err);
      return false;
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
        ...(ref.anchorCommentId !== undefined ? { anchorCommentId: ref.anchorCommentId } : {}),
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
    // Re-fetch the active tracker so the widened/narrowed state set lands.
    void get().fetchIssues();
  },

  setSortPrefs: (prefs) => set({ sortPrefs: prefs }),

  setCollapsed: (issueId, collapsed) =>
    set((state) => ({ collapseById: { ...state.collapseById, [issueId]: collapsed } })),

  clearFilters: () => set({ filters: emptyFilters() }),

  reset: () => set(clearedRepoState()),
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
  // Sort prefs + collapse state are global reference state (docs/206) — persist
  // them on every change so they survive a reload, like the filter bar above.
  if (state.sortPrefs !== prev.sortPrefs) saveSortPrefs(state.sortPrefs);
  if (state.collapseById !== prev.collapseById) saveIssueCollapsed(state.collapseById);
});
