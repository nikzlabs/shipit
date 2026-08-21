/**
 * Tracker id vocabulary (docs/248).
 *
 * A tracker id names a *destination*. For GitHub the destination is a
 * repository (`github:owner/repo`); for Linear it is a team (`linear:SHI`).
 * The bare `"github"` keeps one narrow meaning — the active session's own code
 * repository, the single destination requirement 12 lets an operation reach
 * without naming it. There is no bare `"linear"` destination: requirement 1
 * removed the built-in Linear tracker, so every Linear destination comes from a
 * declaration and carries its team key.
 *
 * The qualified form is the piece of routing data this feature rests on, and it
 * is deliberately carried in the **id** rather than in a parallel field, because
 * the id is what already round-trips through every surface that must not lose
 * the destination:
 *
 *  - `?tracker=` on the read/write routes and the `/agent-ops/issue/*` schema,
 *  - `IssueWriteCard.tracker`, persisted in chat history — so an Undo replays
 *    against the destination the write actually hit, even after the repository
 *    stops declaring it (req 11's carve-out),
 *  - the `parseIssueRef` dedup key, so `a/x#42` and `b/y#42` never collide,
 *  - the Issues tab's sub-tab selection.
 *
 * Anything that reduces the id back to a bare kind re-introduces the
 * wrong-target bug the doc describes, so comparisons use {@link isGitHubTracker}
 * / {@link isLinearTracker} rather than `=== "github"`.
 */

import type { TrackerId } from "./types/domain-types/issue.js";

/** Prefix marking a repository-qualified GitHub tracker id. */
export const GITHUB_TRACKER_PREFIX = "github:";

/** Prefix marking a team-qualified Linear tracker id (docs/248-declared-issue-trackers req 5). */
export const LINEAR_TRACKER_PREFIX = "linear:";

/** A GitHub repository, as `{owner, repo}`. */
export interface TrackerRepoRef {
  owner: string;
  repo: string;
}

/**
 * `owner`/`repo` shape accepted in an id or a declaration's `repo:` field.
 * Deliberately permissive about the character set (GitHub's own rules change)
 * but strict about the structure: exactly one slash, no whitespace, no `#`, no
 * empty side.
 */
const OWNER_REPO_RE = /^([^/\s#]+)\/([^/\s#]+)$/;

/**
 * A Linear team key — the short uppercase prefix its issue keys carry (`SHI` in
 * `SHI-304`). Linear restricts keys to letters and digits; we accept the same
 * shape case-insensitively and normalize to upper case, so a declaration written
 * `team: shi` still matches a `SHI-304` reference.
 */
const LINEAR_TEAM_KEY_RE = /^[A-Za-z][A-Za-z0-9]*$/;

/** Parse an `owner/repo` slug, or null when it isn't one. */
export function parseOwnerRepo(slug: string): TrackerRepoRef | null {
  const m = OWNER_REPO_RE.exec(slug.trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

/** Build the qualified tracker id for a GitHub repository. */
export function githubTrackerId(ref: TrackerRepoRef): TrackerId {
  return `${GITHUB_TRACKER_PREFIX}${ref.owner}/${ref.repo}`;
}

/**
 * The repository a tracker id names, or null when it names none. Bare
 * `"github"` returns null — it means "the session's own code repository"
 * (req 12), which only the request context can resolve, NOT a fallback chosen
 * here.
 */
export function parseGitHubTrackerId(id: string): TrackerRepoRef | null {
  if (!id.startsWith(GITHUB_TRACKER_PREFIX)) return null;
  return parseOwnerRepo(id.slice(GITHUB_TRACKER_PREFIX.length));
}

/** Whether an id addresses GitHub Issues at all (qualified or not). */
export function isGitHubTracker(id: string): boolean {
  return id === "github" || id.startsWith(GITHUB_TRACKER_PREFIX);
}

/** Validate + normalize a Linear team key (`shi` → `SHI`), or null. */
export function normalizeLinearTeamKey(key: string): string | null {
  const trimmed = key.trim();
  if (!LINEAR_TEAM_KEY_RE.test(trimmed)) return null;
  return trimmed.toUpperCase();
}

/** Build the qualified tracker id for a Linear team (docs/248-declared-issue-trackers req 5). */
export function linearTrackerId(teamKey: string): TrackerId {
  return `${LINEAR_TRACKER_PREFIX}${teamKey.toUpperCase()}`;
}

/**
 * The Linear team key a tracker id names, or null when it names none. The bare
 * `"linear"` returns null: it is the pre-docs/248 deployment-wide binding, which
 * requirement 1 retired, so it names no destination this build can reach.
 */
export function parseLinearTrackerId(id: string): string | null {
  if (!id.startsWith(LINEAR_TRACKER_PREFIX)) return null;
  return normalizeLinearTeamKey(id.slice(LINEAR_TRACKER_PREFIX.length));
}

/** Whether an id addresses Linear at all (qualified or the retired bare form). */
export function isLinearTracker(id: string): boolean {
  return id === "linear" || id.startsWith(LINEAR_TRACKER_PREFIX);
}
