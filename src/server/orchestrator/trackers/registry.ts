/**
 * Declared-tracker registry (docs/170, SHI-80; reworked by docs/248).
 *
 * Holds the set of trackers a session can reach and drives the Issues tab's
 * sub-tabs. Under requirement 1 that set is **exactly what the session's
 * repository declared** in its `shipit.yaml`, plus the session's own GitHub
 * Issues — requirement 12's single destination that needs no declaration.
 * ShipIt has no built-in tracker: Linear is a declared `kind` like any other,
 * so a deployment with a Linear token but no `kind: linear` declaration gets no
 * Linear tab at all.
 *
 * The registry is rebuilt per request rather than cached as a singleton, because
 * every input to it varies at runtime:
 *   - **Declarations** come from the session repository's committed
 *     `shipit.yaml`, so they change when the file is edited and differ per
 *     session.
 *   - **The session's own repository** is derived from that session's remote,
 *     resolved by the route and passed in via `github`.
 *   - **Credentials** live in `CredentialStore` and change at runtime
 *     (connect/disconnect). A credential names no destination (req 23) — it only
 *     authorizes reaching one.
 * An adapter instance captures its binding at construction, so a fresh registry
 * per request is what keeps every binding current.
 *
 * ## `list()` and `get()` agree
 *
 * They used to disagree on purpose: `get()` synthesized a tracker for any
 * well-formed `github:owner/repo` id it did not hold, so an operation could name
 * any repository the credential could reach. Requirement 11 forbids exactly
 * that — an address identifying no declared destination fails closed, because
 * requirement 1 leaves no destination outside the declarations. So the
 * synthesizer is gone and `get()` returns only what the session actually
 * declares.
 *
 * ## The one carve-out: {@link TrackerRegistry.getRecorded}
 *
 * Undoing a *recorded* write is requirement 11's single exception, and it needs
 * its own resolution rather than the narrowed `get()`. A provenance card records
 * the destination it reached, and Undo acts on **that** destination — even after
 * it stops being declared (req 11: an undeclared destination stays undoable).
 * Reversing a write grants no access the write did not already have, since the
 * card could only exist if the destination was declared when it was written;
 * failing closed here instead would strand every recorded action behind a config
 * edit.
 *
 * Undo is NOT re-targeted by a re-pointed name (req 16's exception). Undo means
 * "reverse what I did", and what was done was done to the recorded issue — so
 * following the name would apply one issue's snapshot to a different issue that
 * never had it. `undoIssueWrite` detects that case via {@link
 * TrackerRegistry.destinationForName} and refuses rather than acting.
 */

import type { CredentialStore } from "../credential-store.js";
import type { TrackerId, TrackerInfo } from "../../shared/types.js";
import type { DeclaredTracker, TrackerDestination } from "../../shared/declared-tracker.js";
import { declaredTrackerLabel, destinationForDeclaration } from "../../shared/declared-tracker.js";
import { githubTrackerId, parseGitHubTrackerId, parseLinearTrackerId } from "../../shared/tracker-id.js";
import type { Tracker } from "./tracker.js";
import { LinearTracker, type FetchImpl } from "./linear/adapter.js";
import { GitHubTracker, type GitHubRepoRef } from "./github/adapter.js";

/**
 * Per-request context resolved by the route from the active session: the GitHub
 * token (reused from `GitHubAuthManager`), the repo derived from that session's
 * remote, the trackers that session's repository declares, and the warnings its
 * `shipit.yaml` parse produced. `token` and `repo` are null when GitHub isn't
 * connected or the active session has no GitHub remote — the adapter then
 * reports `configured: false`. `declared` is empty when the repository declares
 * none, which after docs/248 means the session reaches only its own repository.
 */
export interface GitHubTrackerContext {
  token: string | null;
  repo: GitHubRepoRef | null;
  /** docs/248 — `issues.trackers` from the session repository's shipit.yaml. */
  declared?: DeclaredTracker[];
  /**
   * docs/248 req 8 — warnings from parsing that repository's `shipit.yaml`
   * (an unrecognized `kind`, a malformed entry, a duplicate `name`). Carried
   * here so the routes can surface them in `shipit` CLI output, where the agent
   * can repair the declaration or raise it with the user.
   */
  warnings?: string[];
}

/** One registry entry: an adapter plus whether it renders as a tab. */
interface RegistryEntry {
  tracker: Tracker;
  /**
   * Whether this entry appears in `list()` (and therefore as a tab, req 9). A
   * repository that declares its *own* repository gets a name for it — the
   * declaration is what renders, and the bare-`github` adapter stays registered
   * but unlisted so requirement 12's unnamed operations still resolve, without
   * minting a second tab for the same issues.
   */
  listed: boolean;
  /** The destination this entry represents, for reference resolution. */
  destination: TrackerDestination;
}

export class TrackerRegistry {
  private readonly entries: RegistryEntry[];
  private readonly makeRecorded: (id: TrackerId) => Tracker | undefined;

  constructor(entries: RegistryEntry[], makeRecorded: (id: TrackerId) => Tracker | undefined) {
    this.entries = entries;
    this.makeRecorded = makeRecorded;
  }

  /** Metadata for every tab-visible tracker — drives the sub-tab switcher. */
  list(): TrackerInfo[] {
    return this.entries.filter((e) => e.listed).map((e) => e.tracker.info());
  }

  /**
   * The destinations a reference may resolve to (docs/248 req 11) — every
   * declaration plus the session's own repository. Includes unlisted entries,
   * because reachability and tab-visibility are different questions: a
   * self-declared repository is reachable both by its name and, unnamed, as the
   * session's own repo.
   */
  destinations(): TrackerDestination[] {
    return this.entries.map((e) => e.destination);
  }

  /**
   * Resolve a tracker id to an adapter. Only registered ids resolve; an id
   * naming no declared destination returns undefined, and callers surface that
   * as an unknown-tracker error rather than falling back to another tracker
   * (req 17: ShipIt never substitutes one destination for another).
   */
  get(id: TrackerId): Tracker | undefined {
    return this.entries.find((e) => e.tracker.id === id)?.tracker;
  }

  /**
   * Resolve the destination recorded on a provenance card — requirement 11's one
   * carve-out, used only by the Undo path. Prefers the still-declared registry
   * entry (so a re-pointed name re-targets the undo, req 16) and otherwise
   * rebuilds an adapter for the recorded id, which is what keeps an Undo working
   * after the repository stops declaring that destination.
   */
  getRecorded(id: TrackerId): Tracker | undefined {
    return this.get(id) ?? this.makeRecorded(id);
  }

  /**
   * Where a declared name points **today**, or undefined if nothing declares it.
   * Undo uses this to detect that a recorded name has been re-pointed since the
   * write; it is deliberately not a resolution path of its own.
   */
  destinationForName(trackerName: string): TrackerDestination | undefined {
    return this.entries.find(
      (e) => e.destination.name?.toLowerCase() === trackerName.toLowerCase(),
    )?.destination;
  }
}

/**
 * Build the registry from the session repository's declarations plus the
 * per-request GitHub context. `fetchImpl` is injectable so integration tests can
 * stub the Linear and GitHub HTTP endpoints.
 */
export function buildTrackerRegistry(
  credentialStore: CredentialStore,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): TrackerRegistry {
  const token = github?.token ?? null;
  const linearToken = credentialStore.getLinearToken();
  const fetchOpt = fetchImpl ? { fetchImpl } : {};

  const makeGitHubTracker = (ref: GitHubRepoRef, name?: string, label?: string): GitHubTracker =>
    new GitHubTracker({
      token,
      repo: ref,
      id: githubTrackerId(ref),
      ...(name ? { name } : {}),
      ...(label ? { label } : {}),
      ...fetchOpt,
    });

  const makeLinearTracker = (teamKey: string, name?: string, label?: string): LinearTracker =>
    new LinearTracker({
      token: linearToken,
      teamKey,
      ...(name ? { name } : {}),
      ...(label ? { label } : {}),
      ...fetchOpt,
    });

  const declared = github?.declared ?? [];
  const sessionRepo = github?.repo ?? null;
  const sameAsSessionRepo = (owner: string, repo: string): boolean =>
    sessionRepo !== null &&
    sessionRepo.owner.toLowerCase() === owner.toLowerCase() &&
    sessionRepo.repo.toLowerCase() === repo.toLowerCase();

  // req 12 — the session's own GitHub Issues, under the bare `github` id. This
  // is the only destination an operation may reach without naming it, so it is
  // always registered; whether it also renders as a tab depends on whether the
  // repository declared itself (below).
  const sessionRepoTracker = new GitHubTracker({ token, repo: sessionRepo, ...fetchOpt });
  const selfDeclared = declared.some((d) => d.kind === "github" && sameAsSessionRepo(d.owner, d.repo));

  const entries: RegistryEntry[] = [
    {
      tracker: sessionRepoTracker,
      // Suppress the unnamed tab when a declaration already covers the same
      // repository — otherwise one repo's issues would render in two tabs.
      listed: !selfDeclared,
      destination: {
        id: "github",
        kind: "github",
        ...(sessionRepo ? { key: `${sessionRepo.owner}/${sessionRepo.repo}` } : {}),
      },
    },
  ];

  // Declarations, in declaration order (req 9 — that order drives tab order).
  for (const decl of declared) {
    // The tab shows the declared `label`, else the `name` (req 9a) — the address
    // and the heading are different fields, so a terse `planning` can render as
    // "Planning" without becoming unaddressable.
    const label = declaredTrackerLabel(decl);
    const tracker =
      decl.kind === "github"
        ? makeGitHubTracker({ owner: decl.owner, repo: decl.repo }, decl.name, label)
        : makeLinearTracker(decl.team, decl.name, label);
    entries.push({ tracker, listed: true, destination: destinationForDeclaration(decl) });
  }

  return new TrackerRegistry(entries, (id) => {
    const ref = parseGitHubTrackerId(id);
    if (ref) return makeGitHubTracker(ref);
    const team = parseLinearTrackerId(id);
    if (team) return makeLinearTracker(team);
    return undefined;
  });
}
