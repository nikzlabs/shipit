/**
 * Declared-tracker registry (docs/170, planning#82; reworked by docs/248).
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
 * ## Declared plugin repositories are destinations too (docs/262 req 25)
 *
 * A `plugins.repos` entry registers its `name` here as well, so feedback on a
 * plugin files through the one issue path everything else uses and its token
 * stays in this process. It is not a tracker declaration and is not treated as
 * one: the entry is **unlisted** (no Issues tab — a plugin repository is a
 * dependency, not where the project's work lives) and its destination carries
 * `origin: "plugin"`, which is what lets a create stamp the running plugin
 * commit onto the report and error messages name it for what it is.
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
import type { PluginFeedbackRepo } from "../../shared/plugin-feedback.js";
import { pluginFeedbackTrackerId } from "../../shared/plugin-feedback.js";
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
   * docs/248-declared-issue-trackers req 8 — warnings from parsing that repository's `shipit.yaml`
   * (an unrecognized `kind`, a malformed entry, a duplicate `name`). Carried
   * here so the routes can surface them in `shipit` CLI output, where the agent
   * can repair the declaration or raise it with the user.
   */
  warnings?: string[];
  /**
   * docs/262 req 25 — the plugin repositories this session's project declares,
   * with the commit each one is running at. Declaring a plugin repository is
   * what grants the feedback channel, so these register as destinations exactly
   * like a declaration does; they are distinguished, not privileged.
   */
  pluginRepos?: readonly PluginFeedbackRepo[];
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
   * The destinations a reference may resolve to (docs/248-declared-issue-trackers req 11) — every
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
   * The destination one tracker id represents — how a caller asks *what kind of
   * destination did this resolve to* (docs/262 req 25: a plugin repository's
   * feedback channel is stamped with the session's plugin context, a declared
   * tracker is not). Reachability, not tab-visibility, so unlisted entries
   * answer too.
   */
  destinationFor(id: TrackerId): TrackerDestination | undefined {
    return this.entries.find((e) => e.tracker.id === id)?.destination;
  }

  /**
   * Where a declared name points **today**, or undefined if nothing declares it.
   * Undo uses this to detect that a recorded name has been re-pointed since the
   * write; it is deliberately not a resolution path of its own.
   */
  destinationForName(trackerName: string): TrackerDestination | undefined {
    const needle = trackerName.toLowerCase();
    // Plugin repository names address a destination too (docs/262 req 25), so
    // the re-point check has to know them — otherwise a card recorded through a
    // plugin name reads as "no longer declared" and skips the guard entirely.
    return this.entries.find(
      (e) =>
        e.destination.name?.toLowerCase() === needle ||
        e.destination.pluginNames?.some((n) => n.toLowerCase() === needle),
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

  // docs/262 req 25 — declared plugin repositories, as feedback destinations.
  //
  // Two things make this different from a declaration, and both are deliberate:
  // the entry is **unlisted** (a plugin repository is a dependency, not one of
  // the project's trackers, so it mints no Issues tab), and it registers only
  // when no entry already covers the same backend identity. That second rule is
  // load-bearing rather than tidy: two *named* destinations sharing one
  // `owner/repo` make the canonical form `owner/repo#42` ambiguous
  // (`resolveParsedIssueRef`), which would break a tracker that was already
  // working. So the plugin name joins the existing destination as an alias, and
  // both names resolve to one adapter.
  for (const plugin of github?.pluginRepos ?? []) {
    const id = pluginFeedbackTrackerId(plugin);
    // Case-insensitively: a tracker id preserves the casing its declaration was
    // written in, and `github:Acme/Planning` addresses the same repository as
    // `github:acme/planning` (`canonicalMatches` already treats them as one).
    // Comparing exactly would let a casing difference mint the second named
    // destination this whole rule exists to prevent.
    const existing = entries.find((e) => e.tracker.id.toLowerCase() === id.toLowerCase());
    if (existing) {
      existing.destination.pluginNames = [...(existing.destination.pluginNames ?? []), plugin.name];
      continue;
    }
    entries.push({
      tracker: makeGitHubTracker({ owner: plugin.owner, repo: plugin.repo }, plugin.name, plugin.name),
      listed: false,
      destination: {
        id,
        name: plugin.name,
        key: `${plugin.owner}/${plugin.repo}`,
        kind: "github",
        origin: "plugin",
        pluginNames: [plugin.name],
      },
    });
  }

  return new TrackerRegistry(entries, (id) => {
    const ref = parseGitHubTrackerId(id);
    if (ref) return makeGitHubTracker(ref);
    const team = parseLinearTrackerId(id);
    if (team) return makeLinearTracker(team);
    return undefined;
  });
}
