/**
 * Configured-tracker registry (docs/170, SHI-80).
 *
 * Holds the set of trackers ShipIt knows about and drives the Issues tab's
 * sub-tabs. It registers Linear and GitHub Issues; each tracker reports
 * `isConfigured()` so the client can render either the list or a "Connect"
 * empty state.
 *
 * The two trackers are configured very differently, which is why the registry
 * is rebuilt per request rather than cached as a singleton:
 *   - **Linear** is workspace-wide; its token + team binding live in
 *     `CredentialStore` and can change at runtime (connect/disconnect).
 *   - **GitHub** is per-repo; its token is ShipIt's existing GitHub auth and
 *     its binding (`{owner, repo}`) is derived from the *active session's*
 *     remote, resolved by the route and passed in via `github`. So the GitHub
 *     sub-tab is auto-configured (no separate connect step) whenever a token
 *     and a GitHub repo are both present — and varies as the user switches
 *     sessions.
 * An adapter instance captures its binding at construction, so a fresh registry
 * per request is what keeps both bindings current.
 */

import type { CredentialStore } from "../credential-store.js";
import type { TrackerId, TrackerInfo } from "../../shared/types.js";
import type { Tracker } from "./tracker.js";
import { LinearTracker, type FetchImpl } from "./linear/adapter.js";
import { GitHubTracker, type GitHubRepoRef } from "./github/adapter.js";

/**
 * Per-request GitHub context resolved by the route from the active session: the
 * GitHub token (reused from `GitHubAuthManager`) and the repo derived from that
 * session's remote. Both null when GitHub isn't connected or the active session
 * has no GitHub remote — the adapter then reports `configured: false`.
 */
export interface GitHubTrackerContext {
  token: string | null;
  repo: GitHubRepoRef | null;
}

export class TrackerRegistry {
  private readonly trackers: Tracker[];

  constructor(trackers: Tracker[]) {
    this.trackers = trackers;
  }

  /** Metadata for every known tracker — drives the sub-tab switcher. */
  list(): TrackerInfo[] {
    return this.trackers.map((t) => t.info());
  }

  get(id: TrackerId): Tracker | undefined {
    return this.trackers.find((t) => t.id === id);
  }
}

/**
 * Build the registry from persisted credentials + the per-request GitHub
 * context. `fetchImpl` is injectable so integration tests can stub the Linear
 * and GitHub HTTP endpoints. `github` carries the active session's GitHub
 * token + resolved repo; omit it (or pass nulls) and the GitHub tab simply
 * reports unconfigured.
 */
export function buildTrackerRegistry(
  credentialStore: CredentialStore,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): TrackerRegistry {
  const linear = new LinearTracker({
    token: credentialStore.getLinearToken(),
    team: credentialStore.getLinearTeam(),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const githubTracker = new GitHubTracker({
    token: github?.token ?? null,
    repo: github?.repo ?? null,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return new TrackerRegistry([linear, githubTracker]);
}
