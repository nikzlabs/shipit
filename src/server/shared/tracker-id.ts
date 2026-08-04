/**
 * Tracker id vocabulary (docs/247).
 *
 * A tracker id names a *destination*, and for GitHub the destination is a
 * repository. `"github"` alone keeps its historical meaning — the active
 * session's own code repository — while `"github:owner/repo"` names one
 * explicitly. That qualified form is the single piece of routing data this
 * feature adds, and it is deliberately carried in the **id** rather than in a
 * parallel field, because the id is what already round-trips through every
 * surface that must not lose the repository:
 *
 *  - `?tracker=` on the read/write routes and the `/agent-ops/issue/*` schema,
 *  - `IssueWriteCard.tracker`, persisted in chat history — so an Undo replays
 *    against the repository the write actually hit, with no new column,
 *  - the `parseIssueRef` dedup key, so `a/x#42` and `b/y#42` never collide,
 *  - the Issues tab's sub-tab selection.
 *
 * Anything that reduces the id back to the bare string `"github"` re-introduces
 * the wrong-target bug the doc describes, so comparisons use
 * {@link isGitHubTracker} rather than `=== "github"`.
 */

import type { TrackerId } from "./types/domain-types/issue.js";

/** Prefix marking a repository-qualified GitHub tracker id. */
export const GITHUB_TRACKER_PREFIX = "github:";

/** A GitHub repository, as `{owner, repo}`. */
export interface TrackerRepoRef {
  owner: string;
  repo: string;
}

/**
 * `owner`/`repo` shape accepted in an id or a `--repo` argument. Deliberately
 * permissive about the character set (GitHub's own rules change) but strict
 * about the structure: exactly one slash, no whitespace, no `#`, no empty side.
 */
const OWNER_REPO_RE = /^([^/\s#]+)\/([^/\s#]+)$/;

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
 * `"github"` returns null — it means "whatever repository the operation
 * resolved", which is the session's code repo (req 3 rule 2), NOT a fallback
 * chosen here.
 */
export function parseGitHubTrackerId(id: string): TrackerRepoRef | null {
  if (!id.startsWith(GITHUB_TRACKER_PREFIX)) return null;
  return parseOwnerRepo(id.slice(GITHUB_TRACKER_PREFIX.length));
}

/** Whether an id addresses GitHub Issues at all (qualified or not). */
export function isGitHubTracker(id: string): boolean {
  return id === "github" || id.startsWith(GITHUB_TRACKER_PREFIX);
}

/** Default sub-tab label for a qualified GitHub tracker: the repository name. */
export function defaultTrackerLabel(ref: TrackerRepoRef): string {
  return ref.repo;
}
