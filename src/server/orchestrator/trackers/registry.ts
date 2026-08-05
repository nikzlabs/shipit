/**
 * Configured-tracker registry (docs/170, SHI-80; extended by docs/247).
 *
 * Holds the set of trackers ShipIt knows about and drives the Issues tab's
 * sub-tabs. It registers Linear, GitHub Issues for the active session's own code
 * repository, and one GitHub tracker per `issues.trackers` declaration in that
 * repository's `shipit.yaml`. Each tracker reports `isConfigured()` so the
 * client can render either the list or a "Connect" empty state.
 *
 * The trackers are configured very differently, which is why the registry is
 * rebuilt per request rather than cached as a singleton:
 *   - **Linear** is workspace-wide; its token + team binding live in
 *     `CredentialStore` and can change at runtime (connect/disconnect).
 *   - **GitHub** is per-repo; its token is ShipIt's existing GitHub auth and
 *     its binding (`{owner, repo}`) is derived from the *active session's*
 *     remote, resolved by the route and passed in via `github`. So the GitHub
 *     sub-tab is auto-configured (no separate connect step) whenever a token
 *     and a GitHub repo are both present — and varies as the user switches
 *     sessions.
 *   - **Declared GitHub trackers** (docs/247) come from the session repository's
 *     committed `shipit.yaml`, so they too vary per session and are read fresh
 *     on each request rather than stored.
 * An adapter instance captures its binding at construction, so a fresh registry
 * per request is what keeps every binding current.
 *
 * ## `list()` vs `get()` — declarations drive tabs, not reachability
 *
 * These two deliberately disagree, and the asymmetry is the design (req 3 + 5).
 * `list()` returns exactly the declared set, because that is what the Issues UI
 * renders as tabs. `get()` additionally *synthesizes* a tracker for any
 * well-formed `github:owner/repo` id it doesn't hold, because an operation may
 * name any repository the GitHub credential can reach — `--repo` is not limited
 * to what `shipit.yaml` declares, and there is no allow-list. GitHub
 * authorization is the only gate, and it applies at request time, so a
 * membership check here would be a second, weaker gate that only ever produced
 * false negatives.
 *
 * The same synthesis is what makes Undo and PR-merge effects address the right
 * repository with no extra persisted state: a card stores `github:owner/repo` as
 * its tracker id, and resolving that id later rebuilds the identical binding.
 */

import type { CredentialStore } from "../credential-store.js";
import type { TrackerId, TrackerInfo } from "../../shared/types.js";
import type { DeclaredTracker } from "../../shared/shipit-config.js";
import { githubTrackerId, parseGitHubTrackerId } from "../../shared/tracker-id.js";
import type { Tracker } from "./tracker.js";
import { LinearTracker, type FetchImpl } from "./linear/adapter.js";
import { GitHubTracker, type GitHubRepoRef } from "./github/adapter.js";

/**
 * Per-request GitHub context resolved by the route from the active session: the
 * GitHub token (reused from `GitHubAuthManager`), the repo derived from that
 * session's remote, and the trackers that session's repository declares. `token`
 * and `repo` are null when GitHub isn't connected or the active session has no
 * GitHub remote — the adapter then reports `configured: false`. `declared` is
 * empty when the repository declares none.
 */
export interface GitHubTrackerContext {
  token: string | null;
  repo: GitHubRepoRef | null;
  /** docs/247 — `issues.trackers` from the session repository's shipit.yaml. */
  declared?: DeclaredTracker[];
}

export class TrackerRegistry {
  private readonly trackers: Tracker[];
  private readonly synthesizeGitHub: ((ref: GitHubRepoRef) => Tracker) | undefined;

  constructor(trackers: Tracker[], synthesizeGitHub?: (ref: GitHubRepoRef) => Tracker) {
    this.trackers = trackers;
    this.synthesizeGitHub = synthesizeGitHub;
  }

  /** Metadata for every known tracker — drives the sub-tab switcher. */
  list(): TrackerInfo[] {
    return this.trackers.map((t) => t.info());
  }

  /**
   * Resolve a tracker id to an adapter.
   *
   * A registered id wins. Failing that, a well-formed `github:owner/repo` id is
   * synthesized on demand — see the class docstring for why that is wider than
   * `list()`. An id that is neither returns undefined, and callers surface that
   * as an unknown-tracker error rather than falling back to another tracker
   * (req 3 rule 3: ShipIt never substitutes one repository for another).
   */
  get(id: TrackerId): Tracker | undefined {
    const registered = this.trackers.find((t) => t.id === id);
    if (registered) return registered;
    const ref = parseGitHubTrackerId(id);
    if (ref && this.synthesizeGitHub) return this.synthesizeGitHub(ref);
    return undefined;
  }
}

/**
 * Build the registry from persisted credentials + the per-request GitHub
 * context. `fetchImpl` is injectable so integration tests can stub the Linear
 * and GitHub HTTP endpoints. `github` carries the active session's GitHub
 * token, resolved repo, and declared trackers; omit it (or pass nulls) and the
 * GitHub tab simply reports unconfigured.
 */
export function buildTrackerRegistry(
  credentialStore: CredentialStore,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): TrackerRegistry {
  const token = github?.token ?? null;
  const fetchOpt = fetchImpl ? { fetchImpl } : {};

  const linear = new LinearTracker({
    token: credentialStore.getLinearToken(),
    team: credentialStore.getLinearTeam(),
    ...fetchOpt,
  });

  // The session's own code repository, under the bare `github` id — unchanged,
  // so no existing command or persisted card changes destination (req 3 rule 2).
  const sessionRepoTracker = new GitHubTracker({
    token,
    repo: github?.repo ?? null,
    ...fetchOpt,
  });

  const makeGitHubTracker = (ref: GitHubRepoRef, label?: string): GitHubTracker =>
    new GitHubTracker({
      token,
      repo: ref,
      id: githubTrackerId(ref),
      ...(label ? { label } : {}),
      ...fetchOpt,
    });

  const declaredTrackers: Tracker[] = [];
  for (const decl of github?.declared ?? []) {
    const ref = { owner: decl.owner, repo: decl.repo };
    // A repository that declares its own code repo would otherwise produce two
    // tabs listing the same issues. The bare-`github` tab already covers it, so
    // the declaration is harmless but redundant — drop the duplicate tab.
    if (
      github?.repo?.owner.toLowerCase() === ref.owner.toLowerCase() &&
      github?.repo?.repo.toLowerCase() === ref.repo.toLowerCase()
    ) {
      continue;
    }
    declaredTrackers.push(makeGitHubTracker(ref, decl.label));
  }

  return new TrackerRegistry(
    [linear, sessionRepoTracker, ...declaredTrackers],
    // Synthesis reuses the same token — there is no second tracker credential.
    // A label isn't passed: an undeclared repo has no tab, so nothing renders it.
    (ref) => makeGitHubTracker(ref),
  );
}
