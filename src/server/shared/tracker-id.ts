import type { TrackerId } from "./types/domain-types/issue.js";

export const GITHUB_TRACKER_PREFIX = "github:";
export const LINEAR_TRACKER_PREFIX = "linear:";

export interface TrackerRepoRef {
  owner: string;
  repo: string;
}

const OWNER_REPO_RE = /^([^/\s#]+)\/([^/\s#]+)$/;
const LINEAR_TEAM_KEY_RE = /^[A-Za-z][A-Za-z0-9]*$/;

export function parseOwnerRepo(slug: string): TrackerRepoRef | null {
  const m = OWNER_REPO_RE.exec(slug.trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

export function githubTrackerId(ref: TrackerRepoRef): TrackerId {
  return `${GITHUB_TRACKER_PREFIX}${ref.owner}/${ref.repo}`;
}

/** Bare "github" needs the session's repository context and returns null here. */
export function parseGitHubTrackerId(id: string): TrackerRepoRef | null {
  if (!id.startsWith(GITHUB_TRACKER_PREFIX)) return null;
  return parseOwnerRepo(id.slice(GITHUB_TRACKER_PREFIX.length));
}

export function isGitHubTracker(id: string): boolean {
  return id === "github" || id.startsWith(GITHUB_TRACKER_PREFIX);
}

export function normalizeLinearTeamKey(key: string): string | null {
  const trimmed = key.trim();
  if (!LINEAR_TEAM_KEY_RE.test(trimmed)) return null;
  return trimmed.toUpperCase();
}

export function linearTrackerId(teamKey: string): TrackerId {
  return `${LINEAR_TRACKER_PREFIX}${teamKey.toUpperCase()}`;
}

export function parseLinearTrackerId(id: string): string | null {
  if (!id.startsWith(LINEAR_TRACKER_PREFIX)) return null;
  return normalizeLinearTeamKey(id.slice(LINEAR_TRACKER_PREFIX.length));
}

export function isLinearTracker(id: string): boolean {
  return id === "linear" || id.startsWith(LINEAR_TRACKER_PREFIX);
}
